package cache

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
)

// QuoteKeyPrefix is the Redis key namespace for SEP-38 quotes. The full key is
// anchor:quote:<id>.
const QuoteKeyPrefix = "anchor:quote:"

// Default cache lifetimes for SEP-38 quotes. Anchors typically issue quotes
// that expire within 30 seconds to 5 minutes, so the cache never outlives the
// quote itself and defaults to a short hard ceiling.
const (
	DefaultQuoteMaxTTL = 5 * time.Minute
	DefaultQuoteMinTTL = time.Second
	DefaultQuoteValue  = 64 << 10
)

var (
	// ErrQuoteIDRequired is returned when a quote has no usable identifier.
	ErrQuoteIDRequired = errors.New("cache: quote ID is required")
	// ErrQuoteExpiryRequired is returned when a quote has no expiry timestamp,
	// which would make TTL enforcement impossible.
	ErrQuoteExpiryRequired = errors.New("cache: quote expiry is required")
	// ErrQuoteTooLarge is returned when a serialized quote exceeds MaxValueBytes.
	ErrQuoteTooLarge = errors.New("cache: quote payload is too large")
)

// Quote is the cacheable projection of a SEP-38 quote. It intentionally holds
// only the fields the relay needs to re-validate an escrow release, so a
// cached entry stays small and forward compatible with extra anchor fields.
type Quote struct {
	ID           string          `json:"id"`
	AnchorDomain string          `json:"anchor_domain,omitempty"`
	ExpiresAt    time.Time       `json:"expires_at"`
	Price        string          `json:"price,omitempty"`
	TotalPrice   string          `json:"total_price,omitempty"`
	SellAsset    string          `json:"sell_asset,omitempty"`
	SellAmount   string          `json:"sell_amount,omitempty"`
	BuyAsset     string          `json:"buy_asset,omitempty"`
	BuyAmount    string          `json:"buy_amount,omitempty"`
	Fee          json.RawMessage `json:"fee,omitempty"`
}

// QuoteKey builds the Redis key for a SEP-38 quote ID.
func QuoteKey(quoteID string) (string, error) {
	id := strings.TrimSpace(quoteID)
	if id == "" {
		return "", ErrQuoteIDRequired
	}
	key := QuoteKeyPrefix + id
	if err := validateKey(key); err != nil {
		return "", err
	}
	return key, nil
}

// QuoteCacheConfig configures a QuoteCache.
type QuoteCacheConfig struct {
	// MaxTTL caps how long a quote may be cached. Defaults to
	// DefaultQuoteMaxTTL.
	MaxTTL time.Duration
	// MinTTL is the shortest remaining quote lifetime worth caching. Quotes
	// closer to expiry are treated as already expired. Defaults to
	// DefaultQuoteMinTTL.
	MinTTL time.Duration
	// MaxValueBytes bounds the serialized quote size. Defaults to
	// DefaultQuoteValue.
	MaxValueBytes int
	// Clock overrides time.Now. Used by tests.
	Clock func() time.Time
}

// QuoteCache is a cache-aside layer for SEP-38 quote lookups.
//
// It is safe for concurrent use. Supplier failures are reported to the caller
// and never cached; cache failures are reported as errors so the caller can
// decide whether to fall back to the anchor.
type QuoteCache struct {
	store         Store
	maxTTL        time.Duration
	minTTL        time.Duration
	maxValueBytes int
	now           func() time.Time

	mu       sync.Mutex
	inflight map[string]*quoteLoad
}

type quoteLoad struct {
	done  chan struct{}
	quote Quote
	err   error
}

// NewQuoteCache builds a quote cache on top of store.
func NewQuoteCache(store Store, cfg QuoteCacheConfig) (*QuoteCache, error) {
	if store == nil {
		return nil, errors.New("cache: quote cache requires a store")
	}
	maxTTL := cfg.MaxTTL
	if maxTTL <= 0 {
		maxTTL = DefaultQuoteMaxTTL
	}
	minTTL := cfg.MinTTL
	if minTTL <= 0 {
		minTTL = DefaultQuoteMinTTL
	}
	if minTTL > maxTTL {
		return nil, fmt.Errorf("cache: MinTTL %s cannot exceed MaxTTL %s", minTTL, maxTTL)
	}
	maxValueBytes := cfg.MaxValueBytes
	if maxValueBytes <= 0 {
		maxValueBytes = DefaultQuoteValue
	}
	now := cfg.Clock
	if now == nil {
		now = time.Now
	}

	return &QuoteCache{
		store:         store,
		maxTTL:        maxTTL,
		minTTL:        minTTL,
		maxValueBytes: maxValueBytes,
		now:           now,
		inflight:      make(map[string]*quoteLoad),
	}, nil
}

// RemainingTTL returns the remaining lifetime of a quote, clamped to the
// cache ceiling. It returns zero for quotes that are missing an expiry or have
// already expired.
func (c *QuoteCache) RemainingTTL(quote Quote) time.Duration {
	if quote.ExpiresAt.IsZero() {
		return 0
	}
	remaining := quote.ExpiresAt.Sub(c.now())
	if remaining <= 0 {
		return 0
	}
	if remaining > c.maxTTL {
		return c.maxTTL
	}
	return remaining
}

// Get returns a cached quote. Expired or unparseable entries are removed and
// reported as a miss so a poisoned entry self-heals without failing the relay.
func (c *QuoteCache) Get(ctx context.Context, quoteID string) (Quote, bool, error) {
	key, err := QuoteKey(quoteID)
	if err != nil {
		return Quote{}, false, err
	}

	payload, found, err := c.store.Get(ctx, key)
	if err != nil {
		return Quote{}, false, err
	}
	if !found {
		return Quote{}, false, nil
	}

	var quote Quote
	if err := json.Unmarshal(payload, &quote); err != nil {
		_ = c.store.Delete(ctx, key)
		return Quote{}, false, nil
	}
	if quote.ExpiresAt.IsZero() || !c.now().Before(quote.ExpiresAt) {
		_ = c.store.Delete(ctx, key)
		return Quote{}, false, nil
	}
	if quote.ID == "" {
		quote.ID = strings.TrimSpace(quoteID)
	}
	return quote, true, nil
}

// Put caches a quote with a TTL derived from its own expiry. It reports
// whether the quote was stored; quotes that are expired, missing an expiry or
// too close to expiry are not cached and any stale copy is invalidated.
func (c *QuoteCache) Put(ctx context.Context, quote Quote) (bool, error) {
	key, err := QuoteKey(quote.ID)
	if err != nil {
		return false, err
	}
	if quote.ExpiresAt.IsZero() {
		return false, ErrQuoteExpiryRequired
	}

	ttl := c.RemainingTTL(quote)
	if ttl < c.minTTL {
		// Invalidate on expiration: a quote that cannot outlive the minimum TTL
		// must never be served from the cache.
		if err := c.store.Delete(ctx, key); err != nil {
			return false, err
		}
		return false, nil
	}

	payload, err := json.Marshal(quote)
	if err != nil {
		return false, fmt.Errorf("cache: failed to encode quote %s: %w", quote.ID, err)
	}
	if len(payload) > c.maxValueBytes {
		return false, fmt.Errorf("%w: %d bytes exceeds %d", ErrQuoteTooLarge, len(payload), c.maxValueBytes)
	}
	if err := c.store.Set(ctx, key, payload, ttl); err != nil {
		return false, err
	}
	return true, nil
}

// Invalidate removes a quote from the cache. It is safe to call for keys that
// do not exist.
func (c *QuoteCache) Invalidate(ctx context.Context, quoteID string) error {
	key, err := QuoteKey(quoteID)
	if err != nil {
		return err
	}
	return c.store.Delete(ctx, key)
}

// GetOrLoad returns a cached quote or loads it through loader and caches the
// result. Concurrent misses for the same quote ID share a single loader call,
// which keeps an anchor RFQ endpoint from being stampeded by parallel escrow
// releases.
func (c *QuoteCache) GetOrLoad(ctx context.Context, quoteID string, loader func(context.Context, string) (Quote, error)) (Quote, error) {
	if loader == nil {
		return Quote{}, errors.New("cache: quote loader is required")
	}

	quote, found, err := c.Get(ctx, quoteID)
	if err != nil {
		return Quote{}, err
	}
	if found {
		return quote, nil
	}

	key, err := QuoteKey(quoteID)
	if err != nil {
		return Quote{}, err
	}

	c.mu.Lock()
	if call, ok := c.inflight[key]; ok {
		c.mu.Unlock()
		select {
		case <-call.done:
			return call.quote, call.err
		case <-ctx.Done():
			return Quote{}, ctx.Err()
		}
	}
	call := &quoteLoad{done: make(chan struct{})}
	c.inflight[key] = call
	c.mu.Unlock()

	quote, loadErr := loader(ctx, quoteID)
	if loadErr == nil {
		// Caching is best effort: an unavailable cache must not fail a lookup
		// that the anchor already answered.
		_, _ = c.Put(ctx, quote)
	}

	call.quote = quote
	call.err = loadErr
	close(call.done)

	c.mu.Lock()
	delete(c.inflight, key)
	c.mu.Unlock()

	return quote, loadErr
}

// Close closes the underlying store.
func (c *QuoteCache) Close() error {
	return c.store.Close()
}
