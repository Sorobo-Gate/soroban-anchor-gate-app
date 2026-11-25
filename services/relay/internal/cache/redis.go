package cache

import (
	"bufio"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// RESP protocol limits. They bound the memory a single hostile or corrupt
// reply can allocate inside the relay process.
const (
	maxBulkBytes  = 8 << 20
	maxArrayItems = 1024
	maxNesting    = 4
)

// RedisConfig configures a Redis-backed Store.
type RedisConfig struct {
	// Addrs lists cluster seed nodes as host:port. At least one is required.
	// Nodes without a port default to 6379.
	Addrs []string
	// Username and Password authenticate the connection. Username may be
	// empty for legacy AUTH, or set for ACL authentication.
	Username string
	// Password enables AUTH when non-empty.
	Password string
	// DB selects the logical database. Cluster deployments must use 0.
	DB int
	// DialTimeout bounds new connection establishment. Defaults to 2s.
	DialTimeout time.Duration
	// IOTimeout bounds a single command round trip. Defaults to 2s.
	IOTimeout time.Duration
	// PoolSize bounds concurrent connections. Defaults to 16.
	PoolSize int
	// IdleTimeout closes connections that have been idle longer than this.
	// Defaults to 5m.
	IdleTimeout time.Duration
	// MaxRedirects bounds MOVED/ASK redirects followed per command. Defaults
	// to 2.
	MaxRedirects int
	// TLSConfig enables TLS when non-nil.
	TLSConfig *tls.Config
}

func (c RedisConfig) normalize() (RedisConfig, error) {
	addrs := make([]string, 0, len(c.Addrs))
	for _, raw := range c.Addrs {
		addr := strings.TrimSpace(raw)
		if addr == "" {
			continue
		}
		if !strings.Contains(addr, ":") {
			addr = net.JoinHostPort(addr, "6379")
		}
		if _, _, err := net.SplitHostPort(addr); err != nil {
			return c, fmt.Errorf("cache: invalid Redis address %q: %w", raw, err)
		}
		addrs = append(addrs, addr)
	}
	if len(addrs) == 0 {
		return c, errors.New("cache: at least one Redis address is required")
	}
	c.Addrs = addrs

	if c.DialTimeout <= 0 {
		c.DialTimeout = 2 * time.Second
	}
	if c.IOTimeout <= 0 {
		c.IOTimeout = 2 * time.Second
	}
	if c.PoolSize <= 0 {
		c.PoolSize = 16
	}
	if c.IdleTimeout <= 0 {
		c.IdleTimeout = 5 * time.Minute
	}
	if c.MaxRedirects <= 0 {
		c.MaxRedirects = 2
	}
	return c, nil
}

// RedisError is an error reply returned by the Redis server.
type RedisError struct {
	Message string
}

// Error implements the error interface.
func (e *RedisError) Error() string {
	return "cache: redis error: " + e.Message
}

// RedisPoolStats reports connection pool utilisation.
type RedisPoolStats struct {
	Idle     int
	InUse    int
	Capacity int
}

type redisConn struct {
	conn      net.Conn
	reader    *bufio.Reader
	writer    *bufio.Writer
	addr      string
	idleSince time.Time
}

// RedisStore is a pooled Redis client that implements Store.
//
// It speaks RESP directly over TCP so that the relay keeps a single, auditable
// dependency surface, works against single nodes and cluster front-ends, and
// follows MOVED/ASK redirections. Connections are reused up to PoolSize, and
// failed connections are discarded instead of being returned to the pool.
type RedisStore struct {
	cfg    RedisConfig
	dialer net.Dialer

	mu        sync.Mutex
	idle      map[string][]*redisConn
	open      int
	capacity  int
	available chan struct{}
	closed    bool

	nextAddr uint64
}

// NewRedisStore validates the configuration and returns a lazily connecting
// Redis client. Use Ping to verify reachability at startup.
func NewRedisStore(cfg RedisConfig) (*RedisStore, error) {
	normalized, err := cfg.normalize()
	if err != nil {
		return nil, err
	}
	return &RedisStore{
		cfg:       normalized,
		dialer:    net.Dialer{Timeout: normalized.DialTimeout, KeepAlive: 30 * time.Second},
		capacity:  normalized.PoolSize,
		available: make(chan struct{}, normalized.PoolSize),
		idle:      make(map[string][]*redisConn),
	}, nil
}

// Get returns the value stored at key.
func (r *RedisStore) Get(ctx context.Context, key string) ([]byte, bool, error) {
	if err := validateKey(key); err != nil {
		return nil, false, err
	}
	value, err := r.do(ctx, "GET", key)
	if err != nil {
		return nil, false, err
	}
	switch value.kind {
	case respNil:
		return nil, false, nil
	case respBulk, respSimple:
		return []byte(value.str), true, nil
	default:
		return nil, false, fmt.Errorf("cache: unexpected GET reply type %q", byte(value.kind))
	}
}

// Set stores value at key with a millisecond-precision TTL.
func (r *RedisStore) Set(ctx context.Context, key string, value []byte, ttl time.Duration) error {
	if err := validateKey(key); err != nil {
		return err
	}
	args := []string{"SET", key, string(value)}
	if ttl > 0 {
		// Redis PX is millisecond based; never round a positive TTL down to
		// zero, which would store the key without an expiry.
		millis := int64(ttl / time.Millisecond)
		if millis < 1 {
			millis = 1
		}
		args = append(args, "PX", strconv.FormatInt(millis, 10))
	}

	reply, err := r.do(ctx, args...)
	if err != nil {
		return err
	}
	if reply.kind != respSimple || !strings.EqualFold(reply.str, "OK") {
		return fmt.Errorf("cache: unexpected SET reply %q", reply.str)
	}
	return nil
}

// Delete removes keys. Deleting missing keys is not an error.
func (r *RedisStore) Delete(ctx context.Context, keys ...string) error {
	if len(keys) == 0 {
		return nil
	}
	for _, key := range keys {
		if err := validateKey(key); err != nil {
			return err
		}
	}
	args := append([]string{"DEL"}, keys...)
	reply, err := r.do(ctx, args...)
	if err != nil {
		return err
	}
	if reply.kind != respInteger {
		return fmt.Errorf("cache: unexpected DEL reply type %q", byte(reply.kind))
	}
	return nil
}

// Ping verifies that a Redis node is reachable.
func (r *RedisStore) Ping(ctx context.Context) error {
	reply, err := r.do(ctx, "PING")
	if err != nil {
		return err
	}
	if reply.kind == respError {
		return &RedisError{Message: reply.str}
	}
	if reply.kind != respSimple || !strings.EqualFold(reply.str, "PONG") {
		return fmt.Errorf("cache: unexpected PING reply %q", reply.str)
	}
	return nil
}

// Stats reports current pool utilisation.
func (r *RedisStore) Stats() RedisPoolStats {
	r.mu.Lock()
	defer r.mu.Unlock()

	idle := 0
	for _, conns := range r.idle {
		idle += len(conns)
	}
	return RedisPoolStats{Idle: idle, InUse: r.open - idle, Capacity: r.capacity}
}

// Close closes idle connections and marks the store closed. In-flight
// connections are closed as they are released.
func (r *RedisStore) Close() error {
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return nil
	}
	r.closed = true
	idle := r.idle
	r.idle = make(map[string][]*redisConn)

	idleCount := 0
	for _, conns := range idle {
		idleCount += len(conns)
	}
	r.open -= idleCount
	r.mu.Unlock()

	for _, conns := range idle {
		for _, conn := range conns {
			_ = conn.conn.Close()
		}
	}

	// Wake every waiter so blocked callers observe ErrClosed instead of
	// sleeping until their context deadline.
	for i := 0; i < r.capacity; i++ {
		r.signalAvailable()
	}
	return nil
}

func (r *RedisStore) checkOpen() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return ErrClosed
	}
	return nil
}

func (r *RedisStore) pickAddr() string {
	index := atomic.AddUint64(&r.nextAddr, 1)
	return r.cfg.Addrs[int(index%uint64(len(r.cfg.Addrs)))]
}

// do sends a command, following cluster redirects and retrying once on a
// transport error with a fresh connection.
func (r *RedisStore) do(ctx context.Context, args ...string) (respValue, error) {
	if err := r.checkOpen(); err != nil {
		return respValue{}, err
	}

	addr := r.pickAddr()
	asking := false
	redirects := 0
	transportRetries := 0

	for {
		conn, err := r.acquire(ctx, addr)
		if err != nil {
			return respValue{}, err
		}

		if asking {
			reply, askErr := conn.roundTrip(ctx, r.cfg.IOTimeout, []string{"ASKING"})
			if askErr != nil || reply.kind == respError {
				r.release(conn, false)
				if askErr != nil {
					return respValue{}, askErr
				}
				return respValue{}, &RedisError{Message: reply.str}
			}
			asking = false
		}

		reply, err := conn.roundTrip(ctx, r.cfg.IOTimeout, args)
		if err != nil {
			r.release(conn, false)
			if ctxErr := ctx.Err(); ctxErr != nil {
				return respValue{}, ctxErr
			}
			transportRetries++
			if transportRetries > 1 {
				return respValue{}, err
			}
			continue
		}

		if reply.kind == respError {
			target, ask, ok := parseRedirect(reply.str)
			if ok && redirects < r.cfg.MaxRedirects {
				redirects++
				r.release(conn, true)
				addr = target
				asking = ask
				continue
			}
			r.release(conn, true)
			return respValue{}, &RedisError{Message: reply.str}
		}

		r.release(conn, true)
		return reply, nil
	}
}

// acquire returns a pooled connection for addr, dialing a new one while the
// pool is below capacity. When the pool is saturated the caller waits for a
// release instead of spinning, which keeps the pool bounded under load.
func (r *RedisStore) acquire(ctx context.Context, addr string) (*redisConn, error) {
	for {
		r.mu.Lock()
		if r.closed {
			r.mu.Unlock()
			return nil, ErrClosed
		}
		if conn := r.popIdleForAddrLocked(addr); conn != nil {
			r.mu.Unlock()
			return conn, nil
		}
		if r.open < r.capacity {
			r.open++
			r.mu.Unlock()

			conn, err := r.dial(ctx, addr)
			if err != nil {
				r.mu.Lock()
				r.open--
				r.mu.Unlock()
				r.signalAvailable()
				return nil, err
			}
			return conn, nil
		}
		r.mu.Unlock()

		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-r.available:
		}
	}
}

// popIdleForAddrLocked removes a reusable connection for addr. Connections are
// never borrowed from a different node: after a MOVED redirect the retry must
// reach the node that owns the slot, otherwise the redirect bounces back to the
// node that issued it. Connections that outlived the idle timeout are closed on
// the way out.
func (r *RedisStore) popIdleForAddrLocked(addr string) *redisConn {
	conns, ok := r.idle[addr]
	if !ok {
		return nil
	}

	now := time.Now()
	for len(conns) > 0 {
		conn := conns[len(conns)-1]
		conns = conns[:len(conns)-1]
		if len(conns) == 0 {
			delete(r.idle, addr)
		} else {
			r.idle[addr] = conns
		}

		if now.Sub(conn.idleSince) > r.cfg.IdleTimeout {
			_ = conn.conn.Close()
			r.open--
			continue
		}
		return conn
	}
	return nil
}

func (r *RedisStore) release(conn *redisConn, healthy bool) {
	r.mu.Lock()
	if !healthy || r.closed {
		r.open--
		r.mu.Unlock()
		_ = conn.conn.Close()
		r.signalAvailable()
		return
	}
	conn.idleSince = time.Now()
	r.idle[conn.addr] = append(r.idle[conn.addr], conn)
	r.mu.Unlock()
	r.signalAvailable()
}

// signalAvailable wakes one waiter, if any. The buffer is sized to the pool so
// every release can be observed even while waiters are still scheduling.
func (r *RedisStore) signalAvailable() {
	select {
	case r.available <- struct{}{}:
	default:
	}
}

func (r *RedisStore) dial(ctx context.Context, addr string) (*redisConn, error) {
	dialCtx := ctx
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		dialCtx, cancel = context.WithTimeout(ctx, r.cfg.DialTimeout)
		defer cancel()
	}

	raw, err := r.dialer.DialContext(dialCtx, "tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("cache: dial redis %s: %w", addr, err)
	}

	if r.cfg.TLSConfig != nil {
		tlsConn := tls.Client(raw, r.cfg.TLSConfig)
		if err := tlsConn.HandshakeContext(dialCtx); err != nil {
			_ = raw.Close()
			return nil, fmt.Errorf("cache: tls handshake with redis %s: %w", addr, err)
		}
		raw = tlsConn
	}

	conn := &redisConn{
		conn:   raw,
		reader: bufio.NewReader(raw),
		writer: bufio.NewWriter(raw),
		addr:   addr,
	}

	if r.cfg.Password != "" {
		authArgs := []string{"AUTH", r.cfg.Password}
		if r.cfg.Username != "" {
			authArgs = []string{"AUTH", r.cfg.Username, r.cfg.Password}
		}
		reply, err := conn.roundTrip(dialCtx, r.cfg.IOTimeout, authArgs)
		if err != nil {
			_ = raw.Close()
			return nil, fmt.Errorf("cache: authenticate with redis %s: %w", addr, err)
		}
		if reply.kind == respError {
			_ = raw.Close()
			return nil, &RedisError{Message: reply.str}
		}
	}

	if r.cfg.DB != 0 {
		reply, err := conn.roundTrip(dialCtx, r.cfg.IOTimeout, []string{"SELECT", strconv.Itoa(r.cfg.DB)})
		if err != nil {
			_ = raw.Close()
			return nil, fmt.Errorf("cache: select redis database %d: %w", r.cfg.DB, err)
		}
		if reply.kind == respError {
			_ = raw.Close()
			return nil, &RedisError{Message: reply.str}
		}
	}

	return conn, nil
}

// parseRedirect extracts the target address from a MOVED or ASK error.
func parseRedirect(message string) (addr string, ask bool, ok bool) {
	switch {
	case strings.HasPrefix(message, "MOVED "):
	case strings.HasPrefix(message, "ASK "):
		ask = true
	default:
		return "", false, false
	}

	fields := strings.Fields(message)
	if len(fields) < 3 {
		return "", false, false
	}
	addr = fields[2]
	if addr == "" {
		return "", false, false
	}
	return addr, ask, true
}

func (c *redisConn) roundTrip(ctx context.Context, timeout time.Duration, args []string) (respValue, error) {
	if timeout <= 0 {
		timeout = 2 * time.Second
	}
	deadline := time.Now().Add(timeout)
	if ctxDeadline, ok := ctx.Deadline(); ok && ctxDeadline.Before(deadline) {
		deadline = ctxDeadline
	}

	if err := c.conn.SetDeadline(deadline); err != nil {
		return respValue{}, fmt.Errorf("cache: set redis deadline: %w", err)
	}
	if err := writeCommand(c.writer, args); err != nil {
		return respValue{}, fmt.Errorf("cache: write redis command: %w", err)
	}
	return readReply(c.reader)
}

func writeCommand(writer *bufio.Writer, args []string) error {
	if _, err := fmt.Fprintf(writer, "*%d\r\n", len(args)); err != nil {
		return err
	}
	for _, arg := range args {
		if _, err := fmt.Fprintf(writer, "$%d\r\n%s\r\n", len(arg), arg); err != nil {
			return err
		}
	}
	return writer.Flush()
}

type respKind byte

const (
	respSimple  respKind = '+'
	respError   respKind = '-'
	respInteger respKind = ':'
	respBulk    respKind = '$'
	respArray   respKind = '*'
	respNil     respKind = '_'
)

type respValue struct {
	kind respKind
	str  string
	num  int64
	arr  []respValue
}

func readReply(reader *bufio.Reader) (respValue, error) {
	return readReplyDepth(reader, 0)
}

func readReplyDepth(reader *bufio.Reader, depth int) (respValue, error) {
	if depth > maxNesting {
		return respValue{}, errors.New("cache: RESP reply nesting exceeds limit")
	}

	line, err := readRESPLine(reader)
	if err != nil {
		return respValue{}, err
	}
	if line == "" {
		return respValue{}, errors.New("cache: empty RESP reply")
	}

	switch line[0] {
	case '+':
		return respValue{kind: respSimple, str: line[1:]}, nil
	case '-':
		return respValue{kind: respError, str: line[1:]}, nil
	case ':':
		value, err := strconv.ParseInt(line[1:], 10, 64)
		if err != nil {
			return respValue{}, fmt.Errorf("cache: malformed RESP integer %q: %w", line, err)
		}
		return respValue{kind: respInteger, num: value}, nil
	case '$':
		size, err := strconv.Atoi(line[1:])
		if err != nil {
			return respValue{}, fmt.Errorf("cache: malformed RESP bulk length %q: %w", line, err)
		}
		if size < 0 {
			return respValue{kind: respNil}, nil
		}
		if size > maxBulkBytes {
			return respValue{}, fmt.Errorf("cache: RESP bulk of %d bytes exceeds limit", size)
		}
		buf := make([]byte, size+2)
		if _, err := io.ReadFull(reader, buf); err != nil {
			return respValue{}, fmt.Errorf("cache: truncated RESP bulk: %w", err)
		}
		if buf[size] != '\r' || buf[size+1] != '\n' {
			return respValue{}, errors.New("cache: RESP bulk is missing its terminator")
		}
		return respValue{kind: respBulk, str: string(buf[:size])}, nil
	case '*':
		count, err := strconv.Atoi(line[1:])
		if err != nil {
			return respValue{}, fmt.Errorf("cache: malformed RESP array length %q: %w", line, err)
		}
		if count < 0 {
			return respValue{kind: respNil}, nil
		}
		if count > maxArrayItems {
			return respValue{}, fmt.Errorf("cache: RESP array of %d items exceeds limit", count)
		}
		items := make([]respValue, 0, count)
		for i := 0; i < count; i++ {
			item, err := readReplyDepth(reader, depth+1)
			if err != nil {
				return respValue{}, err
			}
			items = append(items, item)
		}
		return respValue{kind: respArray, arr: items}, nil
	case '_':
		return respValue{kind: respNil}, nil
	default:
		return respValue{}, fmt.Errorf("cache: unsupported RESP reply type %q", line[0])
	}
}

func readRESPLine(reader *bufio.Reader) (string, error) {
	line, err := reader.ReadString('\n')
	if err != nil {
		return "", fmt.Errorf("cache: read RESP reply: %w", err)
	}
	if len(line) < 3 || !strings.HasSuffix(line, "\r\n") {
		return "", fmt.Errorf("cache: malformed RESP line %q", line)
	}
	return line[:len(line)-2], nil
}

var _ Store = (*RedisStore)(nil)
