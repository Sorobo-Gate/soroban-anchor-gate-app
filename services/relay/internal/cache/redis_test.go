package cache

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeRedis is a minimal RESP server used to exercise RedisStore without an
// external Redis instance. It implements the handful of commands the relay
// issues, plus MOVED redirection and error injection.
type fakeRedis struct {
	t *testing.T

	ln       net.Listener
	mu       sync.Mutex
	data     map[string]string
	expiries map[string]time.Time
	commands []string
	errors   map[string]string
	password string

	redirect    string
	redirected  bool
	connections int
	closed      bool
	wg          sync.WaitGroup
}

func startFakeRedis(t *testing.T) *fakeRedis {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}

	server := &fakeRedis{
		t:        t,
		ln:       ln,
		data:     make(map[string]string),
		expiries: make(map[string]time.Time),
		errors:   make(map[string]string),
	}

	server.wg.Add(1)
	go func() {
		defer server.wg.Done()
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			server.mu.Lock()
			if server.closed {
				server.mu.Unlock()
				_ = conn.Close()
				return
			}
			server.connections++
			server.mu.Unlock()

			server.wg.Add(1)
			go server.serve(conn)
		}
	}()
	return server
}

func (f *fakeRedis) addr() string { return f.ln.Addr().String() }

func (f *fakeRedis) close() {
	f.mu.Lock()
	if f.closed {
		f.mu.Unlock()
		return
	}
	f.closed = true
	f.mu.Unlock()
	_ = f.ln.Close()
	f.wg.Wait()
}

func (f *fakeRedis) commandLog() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.commands...)
}

func (f *fakeRedis) connectionCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.connections
}

func (f *fakeRedis) serve(conn net.Conn) {
	defer f.wg.Done()
	defer conn.Close()

	reader := bufio.NewReader(conn)
	writer := bufio.NewWriter(conn)

	for {
		args, err := readFakeCommand(reader)
		if err != nil {
			return
		}

		f.mu.Lock()
		f.commands = append(f.commands, strings.Join(args, " "))
		reply := f.handleLocked(args)
		f.mu.Unlock()

		if _, err := writer.WriteString(reply); err != nil {
			return
		}
		if err := writer.Flush(); err != nil {
			return
		}
	}
}

func (f *fakeRedis) handleLocked(args []string) string {
	if len(args) == 0 {
		return "-ERR empty command\r\n"
	}

	command := strings.ToUpper(args[0])
	if message, ok := f.errors[command]; ok {
		return "-" + message + "\r\n"
	}

	switch command {
	case "PING":
		return "+PONG\r\n"
	case "AUTH":
		if f.password == "" {
			return "-ERR Client sent AUTH, but no password is set\r\n"
		}
		if len(args) < 2 || args[len(args)-1] != f.password {
			return "-WRONGPASS invalid username-password pair\r\n"
		}
		return "+OK\r\n"
	case "SELECT":
		return "+OK\r\n"
	case "ASKING":
		return "+OK\r\n"
	case "SET":
		if len(args) < 3 {
			return "-ERR wrong number of arguments for 'set' command\r\n"
		}
		key, value := args[1], args[2]
		delete(f.expiries, key)
		if len(args) >= 5 && strings.EqualFold(args[3], "PX") {
			millis, err := strconv.Atoi(args[4])
			if err != nil {
				return "-ERR invalid expire time in 'set' command\r\n"
			}
			f.expiries[key] = time.Now().Add(time.Duration(millis) * time.Millisecond)
		}
		f.data[key] = value
		return "+OK\r\n"
	case "GET":
		if len(args) < 2 {
			return "-ERR wrong number of arguments for 'get' command\r\n"
		}
		if f.redirect != "" && !f.redirected {
			f.redirected = true
			return "-MOVED 0 " + f.redirect + "\r\n"
		}
		value, ok := f.data[args[1]]
		if !ok {
			return "$-1\r\n"
		}
		if expiry, hasExpiry := f.expiries[args[1]]; hasExpiry && !time.Now().Before(expiry) {
			delete(f.data, args[1])
			delete(f.expiries, args[1])
			return "$-1\r\n"
		}
		return fmt.Sprintf("$%d\r\n%s\r\n", len(value), value)
	case "DEL":
		deleted := 0
		for _, key := range args[1:] {
			if _, ok := f.data[key]; ok {
				delete(f.data, key)
				delete(f.expiries, key)
				deleted++
			}
		}
		return fmt.Sprintf(":%d\r\n", deleted)
	default:
		return "-ERR unknown command '" + args[0] + "'\r\n"
	}
}

func readFakeCommand(reader *bufio.Reader) ([]string, error) {
	header, err := reader.ReadString('\n')
	if err != nil {
		return nil, err
	}
	header = strings.TrimRight(header, "\r\n")
	if len(header) == 0 || header[0] != '*' {
		return nil, fmt.Errorf("fake redis: expected array header, got %q", header)
	}
	count, err := strconv.Atoi(header[1:])
	if err != nil {
		return nil, err
	}

	args := make([]string, 0, count)
	for i := 0; i < count; i++ {
		bulkHeader, err := reader.ReadString('\n')
		if err != nil {
			return nil, err
		}
		bulkHeader = strings.TrimRight(bulkHeader, "\r\n")
		if len(bulkHeader) == 0 || bulkHeader[0] != '$' {
			return nil, fmt.Errorf("fake redis: expected bulk header, got %q", bulkHeader)
		}
		size, err := strconv.Atoi(bulkHeader[1:])
		if err != nil {
			return nil, err
		}
		buf := make([]byte, size+2)
		if _, err := io.ReadFull(reader, buf); err != nil {
			return nil, err
		}
		args = append(args, string(buf[:size]))
	}
	return args, nil
}

func newTestRedisStore(t *testing.T, cfg RedisConfig) *RedisStore {
	t.Helper()
	store, err := NewRedisStore(cfg)
	if err != nil {
		t.Fatalf("new redis store: %v", err)
	}
	return store
}

func TestRedisStore_SetGetDelete(t *testing.T) {
	server := startFakeRedis(t)
	defer server.close()

	store := newTestRedisStore(t, RedisConfig{Addrs: []string{server.addr()}})
	defer store.Close()

	ctx := context.Background()
	if err := store.Set(ctx, "anchor:quote:q-1", []byte(`{"id":"q-1"}`), 30*time.Second); err != nil {
		t.Fatalf("set: %v", err)
	}

	value, found, err := store.Get(ctx, "anchor:quote:q-1")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if !found || string(value) != `{"id":"q-1"}` {
		t.Fatalf("unexpected value found=%v value=%q", found, value)
	}

	if err := store.Delete(ctx, "anchor:quote:q-1"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, found, err := store.Get(ctx, "anchor:quote:q-1"); err != nil || found {
		t.Fatalf("expected miss after delete: found=%v err=%v", found, err)
	}

	log := strings.Join(server.commandLog(), "\n")
	if !strings.Contains(log, "SET anchor:quote:q-1") {
		t.Fatalf("server did not observe the SET:\n%s", log)
	}
	if !strings.Contains(log, "PX 30000") {
		t.Fatalf("expected a millisecond TTL of 30000, log:\n%s", log)
	}
}

func TestRedisStore_TTLExpiresEntry(t *testing.T) {
	server := startFakeRedis(t)
	defer server.close()

	store := newTestRedisStore(t, RedisConfig{Addrs: []string{server.addr()}})
	defer store.Close()

	ctx := context.Background()
	if err := store.Set(ctx, "anchor:quote:short", []byte("v"), 20*time.Millisecond); err != nil {
		t.Fatalf("set: %v", err)
	}
	time.Sleep(50 * time.Millisecond)

	if _, found, err := store.Get(ctx, "anchor:quote:short"); err != nil || found {
		t.Fatalf("expected the key to expire: found=%v err=%v", found, err)
	}
}

func TestRedisStore_SubMillisecondTTLRoundsUp(t *testing.T) {
	server := startFakeRedis(t)
	defer server.close()

	store := newTestRedisStore(t, RedisConfig{Addrs: []string{server.addr()}})
	defer store.Close()

	if err := store.Set(context.Background(), "anchor:quote:tiny", []byte("v"), time.Microsecond); err != nil {
		t.Fatalf("set: %v", err)
	}
	log := strings.Join(server.commandLog(), "\n")
	if !strings.Contains(log, "PX 1") {
		t.Fatalf("expected a 1ms TTL rather than an entry without expiry, log:\n%s", log)
	}
}

func TestRedisStore_Ping(t *testing.T) {
	server := startFakeRedis(t)
	defer server.close()

	store := newTestRedisStore(t, RedisConfig{Addrs: []string{server.addr()}})
	defer store.Close()

	if err := store.Ping(context.Background()); err != nil {
		t.Fatalf("ping: %v", err)
	}
}

func TestRedisStore_Authenticates(t *testing.T) {
	server := startFakeRedis(t)
	defer server.close()
	server.mu.Lock()
	server.password = "s3cret"
	server.mu.Unlock()

	bad := newTestRedisStore(t, RedisConfig{Addrs: []string{server.addr()}, Password: "wrong"})
	defer bad.Close()
	if err := bad.Ping(context.Background()); err == nil {
		t.Fatalf("expected authentication failure")
	} else {
		var redisErr *RedisError
		if !errors.As(err, &redisErr) {
			t.Fatalf("expected a RedisError, got %T: %v", err, err)
		}
	}

	good := newTestRedisStore(t, RedisConfig{Addrs: []string{server.addr()}, Password: "s3cret"})
	defer good.Close()
	if err := good.Ping(context.Background()); err != nil {
		t.Fatalf("authenticated ping: %v", err)
	}
}

func TestRedisStore_SelectsDatabase(t *testing.T) {
	server := startFakeRedis(t)
	defer server.close()

	store := newTestRedisStore(t, RedisConfig{Addrs: []string{server.addr()}, DB: 3})
	defer store.Close()

	if err := store.Ping(context.Background()); err != nil {
		t.Fatalf("ping: %v", err)
	}
	if log := strings.Join(server.commandLog(), "\n"); !strings.Contains(log, "SELECT 3") {
		t.Fatalf("expected SELECT 3, log:\n%s", log)
	}
}

func TestRedisStore_FollowsMovedRedirect(t *testing.T) {
	first := startFakeRedis(t)
	defer first.close()
	second := startFakeRedis(t)
	defer second.close()

	second.mu.Lock()
	second.data["anchor:quote:moved"] = "redirected-value"
	second.mu.Unlock()

	first.mu.Lock()
	first.redirect = second.addr()
	first.mu.Unlock()

	store := newTestRedisStore(t, RedisConfig{Addrs: []string{first.addr()}})
	defer store.Close()

	value, found, err := store.Get(context.Background(), "anchor:quote:moved")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if !found || string(value) != "redirected-value" {
		t.Fatalf("expected the redirected value, found=%v value=%q", found, value)
	}
}

func TestRedisStore_ReturnsTypedServerError(t *testing.T) {
	server := startFakeRedis(t)
	defer server.close()
	server.mu.Lock()
	server.errors["GET"] = "ERR synthetic failure"
	server.mu.Unlock()

	store := newTestRedisStore(t, RedisConfig{Addrs: []string{server.addr()}})
	defer store.Close()

	_, _, err := store.Get(context.Background(), "anchor:quote:q-1")
	if err == nil {
		t.Fatalf("expected an error")
	}
	var redisErr *RedisError
	if !errors.As(err, &redisErr) {
		t.Fatalf("expected a RedisError, got %T: %v", err, err)
	}
	if !strings.Contains(redisErr.Message, "synthetic failure") {
		t.Fatalf("unexpected error message %q", redisErr.Message)
	}
}

func TestRedisStore_ReusesPooledConnections(t *testing.T) {
	server := startFakeRedis(t)
	defer server.close()

	store := newTestRedisStore(t, RedisConfig{Addrs: []string{server.addr()}, PoolSize: 4})
	defer store.Close()

	ctx := context.Background()
	for i := 0; i < 10; i++ {
		if err := store.Ping(ctx); err != nil {
			t.Fatalf("ping %d: %v", i, err)
		}
	}

	if got := server.connectionCount(); got != 1 {
		t.Fatalf("expected the connection to be pooled and reused, opened %d connections", got)
	}
	stats := store.Stats()
	if stats.Idle != 1 || stats.InUse != 0 || stats.Capacity != 4 {
		t.Fatalf("unexpected pool stats %+v", stats)
	}
}

func TestRedisStore_ClosedStoreRejectsOperations(t *testing.T) {
	server := startFakeRedis(t)
	defer server.close()

	store := newTestRedisStore(t, RedisConfig{Addrs: []string{server.addr()}})
	if err := store.Ping(context.Background()); err != nil {
		t.Fatalf("ping: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("second close: %v", err)
	}

	if _, _, err := store.Get(context.Background(), "k"); !errors.Is(err, ErrClosed) {
		t.Fatalf("expected ErrClosed, got %v", err)
	}
}

func TestRedisStore_DialFailure(t *testing.T) {
	store := newTestRedisStore(t, RedisConfig{
		Addrs:       []string{"127.0.0.1:1"},
		DialTimeout: 200 * time.Millisecond,
	})
	defer store.Close()

	if err := store.Ping(context.Background()); err == nil {
		t.Fatalf("expected a dial failure")
	}
}

func TestRedisStore_InvalidConfig(t *testing.T) {
	if _, err := NewRedisStore(RedisConfig{}); err == nil {
		t.Fatalf("expected error for missing addresses")
	}
	if _, err := NewRedisStore(RedisConfig{Addrs: []string{"   "}}); err == nil {
		t.Fatalf("expected error for blank addresses")
	}
	if _, err := NewRedisStore(RedisConfig{Addrs: []string{"::not-an-address::"}}); err == nil {
		t.Fatalf("expected error for a malformed address")
	}
}

func TestRedisStore_RequiresValidKey(t *testing.T) {
	server := startFakeRedis(t)
	defer server.close()

	store := newTestRedisStore(t, RedisConfig{Addrs: []string{server.addr()}})
	defer store.Close()

	ctx := context.Background()
	if _, _, err := store.Get(ctx, ""); !errors.Is(err, ErrInvalidKey) {
		t.Fatalf("expected ErrInvalidKey, got %v", err)
	}
	if err := store.Set(ctx, "bad key", []byte("v"), 0); !errors.Is(err, ErrInvalidKey) {
		t.Fatalf("expected ErrInvalidKey, got %v", err)
	}
	if err := store.Delete(ctx); err != nil {
		t.Fatalf("delete with no keys should be a no-op: %v", err)
	}
}

func TestRedisStore_ConcurrentAccess(t *testing.T) {
	server := startFakeRedis(t)
	defer server.close()

	store := newTestRedisStore(t, RedisConfig{Addrs: []string{server.addr()}, PoolSize: 8})
	defer store.Close()

	ctx := context.Background()
	var wg sync.WaitGroup
	errs := make(chan error, 16)
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func(worker int) {
			defer wg.Done()
			for j := 0; j < 10; j++ {
				key := fmt.Sprintf("anchor:quote:%d-%d", worker, j)
				if err := store.Set(ctx, key, []byte("v"), time.Minute); err != nil {
					errs <- err
					return
				}
				if _, found, err := store.Get(ctx, key); err != nil || !found {
					errs <- fmt.Errorf("get %s: found=%v err=%v", key, found, err)
					return
				}
			}
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("concurrent access: %v", err)
	}

	stats := store.Stats()
	if stats.Capacity != 8 {
		t.Fatalf("unexpected pool capacity %+v", stats)
	}
	if stats.InUse != 0 {
		t.Fatalf("all connections should be back in the pool, got %+v", stats)
	}
}

func TestParseRedirect(t *testing.T) {
	tests := []struct {
		message string
		addr    string
		ask     bool
		ok      bool
	}{
		{message: "MOVED 3999 127.0.0.1:6381", addr: "127.0.0.1:6381", ask: false, ok: true},
		{message: "ASK 3999 127.0.0.1:6381", addr: "127.0.0.1:6381", ask: true, ok: true},
		{message: "MOVED", ok: false},
		{message: "ERR unknown", ok: false},
		{message: "MOVED 1", ok: false},
	}

	for _, test := range tests {
		addr, ask, ok := parseRedirect(test.message)
		if ok != test.ok || addr != test.addr || ask != test.ask {
			t.Fatalf("parseRedirect(%q) = (%q, %v, %v), want (%q, %v, %v)",
				test.message, addr, ask, ok, test.addr, test.ask, test.ok)
		}
	}
}

func TestRedisStore_OversizedBulkIsRejected(t *testing.T) {
	// A hostile reply must not allocate beyond maxBulkBytes. Drive the parser
	// directly through a fake reply line.
	reader := bufio.NewReader(strings.NewReader(fmt.Sprintf("$%d\r\n", maxBulkBytes+1)))
	if _, err := readReply(reader); err == nil {
		t.Fatalf("expected oversized bulk to be rejected")
	}
}

func TestRedisStore_MalformedRepliesAreRejected(t *testing.T) {
	cases := []string{
		"\r\n",              // empty line
		"?what\r\n",         // unknown type marker
		":not-a-number\r\n", // malformed integer
		"$abc\r\n",          // malformed bulk length
		"*abc\r\n",          // malformed array length
		"$3\r\nabcXX",       // bulk without CRLF terminator
	}
	for _, payload := range cases {
		reader := bufio.NewReader(strings.NewReader(payload))
		if _, err := readReply(reader); err == nil {
			t.Fatalf("expected payload %q to be rejected", payload)
		}
	}
}

func TestReadReply_ParsesArray(t *testing.T) {
	reader := bufio.NewReader(strings.NewReader("*2\r\n$3\r\nfoo\r\n:7\r\n"))
	value, err := readReply(reader)
	if err != nil {
		t.Fatalf("read reply: %v", err)
	}
	if value.kind != respArray || len(value.arr) != 2 {
		t.Fatalf("unexpected reply %+v", value)
	}
	if value.arr[0].str != "foo" || value.arr[1].num != 7 {
		t.Fatalf("unexpected array contents %+v", value.arr)
	}
}
