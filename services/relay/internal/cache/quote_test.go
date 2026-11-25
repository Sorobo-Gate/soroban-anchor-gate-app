package cache

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

// recordingStore captures the TTLs and deletions the quote cache applies.
type recordingStore struct {
	mu      sync.Mutex
	data    map[string][]byte
	ttls    map[string]time.Duration
	deletes map[string]int
	sets    int
	getErr  error
	setErr  error
}

func newRecordingStore() *recordingStore {
	return &recordingStore{
		data:    make(map[string][]byte),
		ttls:    make(map[string]time.Duration),
		deletes: make(map[string]int),
	}
}

func (s *recordingStore) Get(_ context.Context, key string) ([]byte, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.getErr != nil {
		return nil, false, s.getErr
	}
	value, ok := s.data[key]
	if !ok {
		return nil, false, nil
	}
	copied := make([]byte, len(value))
	copy(copied, value)
	return copied, true, nil
}

func (s *recordingStore) Set(_ context.Context, key string, value []byte, ttl time.Duration) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.setErr != nil {
		return s.setErr
	}
	s.sets++
	s.data[key] = append([]byte(nil), value...)
	s.ttls[key] = ttl
	return nil
}

func (s *recordingStore) Delete(_ context.Context, keys ...string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, key := range keys {
		s.deletes[key]++
		delete(s.data, key)
	}
	return nil
}

func (s *recordingStore) Ping(context.Context) error { return nil }
func (s *recordingStore) Close() error               { return nil }

func (s *recordingStore) deleteCount(key string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.deletes[key]
}

func (s *recordingStore) setCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sets
}

func (s *recordingStore) recordedTTL(key string) time.Duration {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.ttls[key]
}

func newTestQuoteCache(t *testing.T, store Store, clock *fakeClock, cfg QuoteCacheConfig) *QuoteCache {
	t.Helper()
	if clock != nil {
		cfg.Clock = clock.Now
	}
	cache, err := NewQuoteCache(store, cfg)
	if err != nil {
		t.Fatalf("new quote cache: %v", err)
	}
	return cache
}

func TestQuoteKey_Format(t *testing.T) {
	if _, err := QuoteKey("0192 f4c1"); err == nil {
		t.Fatalf("expected whitespace inside the ID to be rejected")
	}

	key, err := QuoteKey(" 0192f4c1 ")
	if err != nil {
		t.Fatalf("quote key: %v", err)
	}
	if key != "anchor:quote:0192f4c1" {
		t.Fatalf("unexpected key %q", key)
	}

	if _, err := QuoteKey("   "); !errors.Is(err, ErrQuoteIDRequired) {
		t.Fatalf("expected ErrQuoteIDRequired, got %v", err)
	}
	if _, err := QuoteKey(strings.Repeat("q", MaxKeyBytes)); err == nil {
		t.Fatalf("expected oversized key to be rejected")
	}
}

func TestNewQuoteCache_ValidatesConfig(t *testing.T) {
	if _, err := NewQuoteCache(nil, QuoteCacheConfig{}); err == nil {
		t.Fatalf("expected error for nil store")
	}
	if _, err := NewQuoteCache(newRecordingStore(), QuoteCacheConfig{
		MaxTTL: time.Second,
		MinTTL: time.Minute,
	}); err == nil {
		t.Fatalf("expected error when MinTTL exceeds MaxTTL")
	}
}

func TestQuoteCache_PutThenGet(t *testing.T) {
	clock := newFakeClock()
	store := newRecordingStore()
	cache := newTestQuoteCache(t, store, clock, QuoteCacheConfig{})

	ctx := context.Background()
	quote := Quote{
		ID:           "q-1",
		AnchorDomain: "anclap.com",
		ExpiresAt:    clock.Now().Add(90 * time.Second),
		Price:        "1.02",
		SellAsset:    "USDC:GA",
		SellAmount:   "100.00",
		BuyAsset:     "BRL",
		BuyAmount:    "102.00",
		Fee:          json.RawMessage(`{"total":"0.50","asset":"USDC"}`),
	}

	cached, err := cache.Put(ctx, quote)
	if err != nil {
		t.Fatalf("put: %v", err)
	}
	if !cached {
		t.Fatalf("expected quote to be cached")
	}
	if ttl := store.recordedTTL("anchor:quote:q-1"); ttl != 90*time.Second {
		t.Fatalf("expected a 90s TTL, got %s", ttl)
	}

	got, found, err := cache.Get(ctx, "q-1")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if !found {
		t.Fatalf("expected a cache hit")
	}
	if got.Price != quote.Price || got.BuyAmount != quote.BuyAmount || got.AnchorDomain != quote.AnchorDomain {
		t.Fatalf("round trip mismatch: %+v", got)
	}
	if string(got.Fee) != string(quote.Fee) {
		t.Fatalf("fee round trip mismatch: %s", got.Fee)
	}
}

func TestQuoteCache_TTLCappedAtMaxTTL(t *testing.T) {
	clock := newFakeClock()
	store := newRecordingStore()
	cache := newTestQuoteCache(t, store, clock, QuoteCacheConfig{MaxTTL: 2 * time.Minute})

	if _, err := cache.Put(context.Background(), Quote{
		ID:        "long-lived",
		ExpiresAt: clock.Now().Add(24 * time.Hour),
	}); err != nil {
		t.Fatalf("put: %v", err)
	}

	if ttl := store.recordedTTL("anchor:quote:long-lived"); ttl != 2*time.Minute {
		t.Fatalf("expected the TTL to be capped at 2m, got %s", ttl)
	}
}

func TestQuoteCache_DoesNotCacheNearlyExpiredQuotes(t *testing.T) {
	clock := newFakeClock()
	store := newRecordingStore()
	cache := newTestQuoteCache(t, store, clock, QuoteCacheConfig{MinTTL: time.Second})

	cached, err := cache.Put(context.Background(), Quote{
		ID:        "q-expiring",
		ExpiresAt: clock.Now().Add(500 * time.Millisecond),
	})
	if err != nil {
		t.Fatalf("put: %v", err)
	}
	if cached {
		t.Fatalf("quote inside the minimum TTL must not be cached")
	}
	if store.setCount() != 0 {
		t.Fatalf("expected no write for a nearly expired quote")
	}
	if store.deleteCount("anchor:quote:q-expiring") == 0 {
		t.Fatalf("expected the stale copy to be invalidated")
	}
}

func TestQuoteCache_InvalidatesAlreadyExpiredQuotes(t *testing.T) {
	clock := newFakeClock()
	store := newRecordingStore()
	cache := newTestQuoteCache(t, store, clock, QuoteCacheConfig{})

	cached, err := cache.Put(context.Background(), Quote{
		ID:        "q-dead",
		ExpiresAt: clock.Now().Add(-time.Minute),
	})
	if err != nil {
		t.Fatalf("put: %v", err)
	}
	if cached {
		t.Fatalf("an expired quote must never be cached")
	}
	if store.setCount() != 0 {
		t.Fatalf("expected no write for an expired quote")
	}
}

func TestQuoteCache_GetDropsExpiredEntry(t *testing.T) {
	clock := newFakeClock()
	store := newRecordingStore()
	cache := newTestQuoteCache(t, store, clock, QuoteCacheConfig{})

	payload, err := json.Marshal(Quote{ID: "q-1", ExpiresAt: clock.Now().Add(time.Minute)})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if err := store.Set(context.Background(), "anchor:quote:q-1", payload, time.Minute); err != nil {
		t.Fatalf("seed store: %v", err)
	}

	clock.Advance(2 * time.Minute)
	if _, found, err := cache.Get(context.Background(), "q-1"); err != nil || found {
		t.Fatalf("expected expired entry to miss: found=%v err=%v", found, err)
	}
	if store.deleteCount("anchor:quote:q-1") == 0 {
		t.Fatalf("expired entry should be deleted from the store")
	}
}

func TestQuoteCache_GetSelfHealsCorruptEntry(t *testing.T) {
	store := newRecordingStore()
	cache := newTestQuoteCache(t, store, newFakeClock(), QuoteCacheConfig{})
	ctx := context.Background()

	if err := store.Set(ctx, "anchor:quote:q-1", []byte("{not-json"), time.Minute); err != nil {
		t.Fatalf("seed store: %v", err)
	}

	if _, found, err := cache.Get(ctx, "q-1"); err != nil || found {
		t.Fatalf("corrupt entry should behave as a miss: found=%v err=%v", found, err)
	}
	if store.deleteCount("anchor:quote:q-1") == 0 {
		t.Fatalf("corrupt entry should be removed")
	}
}

func TestQuoteCache_PropagatesStoreErrors(t *testing.T) {
	store := newRecordingStore()
	store.getErr = errors.New("redis unavailable")
	cache := newTestQuoteCache(t, store, nil, QuoteCacheConfig{})

	if _, _, err := cache.Get(context.Background(), "q-1"); err == nil {
		t.Fatalf("expected store error to propagate")
	}
}

func TestQuoteCache_RejectsQuoteWithoutExpiry(t *testing.T) {
	cache := newTestQuoteCache(t, newRecordingStore(), nil, QuoteCacheConfig{})
	if _, err := cache.Put(context.Background(), Quote{ID: "q-1"}); !errors.Is(err, ErrQuoteExpiryRequired) {
		t.Fatalf("expected ErrQuoteExpiryRequired, got %v", err)
	}
}

func TestQuoteCache_GetOrLoadCachesLoaderResult(t *testing.T) {
	clock := newFakeClock()
	store := newRecordingStore()
	cache := newTestQuoteCache(t, store, clock, QuoteCacheConfig{})
	ctx := context.Background()

	calls := 0
	loader := func(context.Context, string) (Quote, error) {
		calls++
		return Quote{ID: "q-1", ExpiresAt: clock.Now().Add(time.Minute), Price: "2.00"}, nil
	}

	first, err := cache.GetOrLoad(ctx, "q-1", loader)
	if err != nil {
		t.Fatalf("first load: %v", err)
	}
	if first.Price != "2.00" {
		t.Fatalf("unexpected quote %+v", first)
	}

	second, err := cache.GetOrLoad(ctx, "q-1", loader)
	if err != nil {
		t.Fatalf("second load: %v", err)
	}
	if second.Price != "2.00" {
		t.Fatalf("unexpected cached quote %+v", second)
	}
	if calls != 1 {
		t.Fatalf("expected the loader to run once, ran %d times", calls)
	}
}

func TestQuoteCache_GetOrLoadSingleFlight(t *testing.T) {
	clock := newFakeClock()
	cache := newTestQuoteCache(t, newRecordingStore(), clock, QuoteCacheConfig{})
	ctx := context.Background()

	release := make(chan struct{})
	var calls int32
	var mu sync.Mutex
	loader := func(context.Context, string) (Quote, error) {
		mu.Lock()
		calls++
		mu.Unlock()
		<-release
		return Quote{ID: "q-1", ExpiresAt: clock.Now().Add(time.Minute), Price: "3.00"}, nil
	}

	const workers = 8
	var wg sync.WaitGroup
	errs := make(chan error, workers)
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			quote, err := cache.GetOrLoad(ctx, "q-1", loader)
			if err != nil {
				errs <- err
				return
			}
			if quote.Price != "3.00" {
				errs <- errors.New("unexpected quote returned to a waiter")
			}
		}()
	}

	// Give every waiter time to join the in-flight call before the loader is
	// allowed to finish.
	time.Sleep(20 * time.Millisecond)
	close(release)
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("concurrent load: %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	if calls != 1 {
		t.Fatalf("expected a single loader call, got %d", calls)
	}
}

func TestQuoteCache_GetOrLoadDoesNotCacheErrors(t *testing.T) {
	clock := newFakeClock()
	store := newRecordingStore()
	cache := newTestQuoteCache(t, store, clock, QuoteCacheConfig{})

	loadErr := errors.New("anchor returned 503")
	if _, err := cache.GetOrLoad(context.Background(), "q-1", func(context.Context, string) (Quote, error) {
		return Quote{}, loadErr
	}); !errors.Is(err, loadErr) {
		t.Fatalf("expected loader error, got %v", err)
	}
	if store.setCount() != 0 {
		t.Fatalf("failed lookups must not be cached")
	}
}

func TestQuoteCache_GetOrLoadRequiresLoader(t *testing.T) {
	cache := newTestQuoteCache(t, newRecordingStore(), nil, QuoteCacheConfig{})
	if _, err := cache.GetOrLoad(context.Background(), "q-1", nil); err == nil {
		t.Fatalf("expected error for nil loader")
	}
}

func TestQuoteCache_GetOrLoadRespectsContextCancellation(t *testing.T) {
	clock := newFakeClock()
	cache := newTestQuoteCache(t, newRecordingStore(), clock, QuoteCacheConfig{})

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := cache.GetOrLoad(ctx, "q-1", func(ctx context.Context, _ string) (Quote, error) {
		return Quote{}, ctx.Err()
	}); !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context cancellation, got %v", err)
	}
}

func TestQuoteCache_RemainingTTL(t *testing.T) {
	clock := newFakeClock()
	cache := newTestQuoteCache(t, newRecordingStore(), clock, QuoteCacheConfig{MaxTTL: time.Minute})

	if got := cache.RemainingTTL(Quote{}); got != 0 {
		t.Fatalf("quote without expiry should have a zero TTL, got %s", got)
	}
	if got := cache.RemainingTTL(Quote{ExpiresAt: clock.Now().Add(-time.Second)}); got != 0 {
		t.Fatalf("expired quote should have a zero TTL, got %s", got)
	}
	if got := cache.RemainingTTL(Quote{ExpiresAt: clock.Now().Add(30 * time.Second)}); got != 30*time.Second {
		t.Fatalf("expected 30s, got %s", got)
	}
	if got := cache.RemainingTTL(Quote{ExpiresAt: clock.Now().Add(time.Hour)}); got != time.Minute {
		t.Fatalf("expected the MaxTTL ceiling, got %s", got)
	}
}

func TestQuoteCache_Invalidate(t *testing.T) {
	store := newRecordingStore()
	cache := newTestQuoteCache(t, store, nil, QuoteCacheConfig{})
	ctx := context.Background()

	if err := cache.Invalidate(ctx, "q-1"); err != nil {
		t.Fatalf("invalidate: %v", err)
	}
	if store.deleteCount("anchor:quote:q-1") != 1 {
		t.Fatalf("expected the key to be deleted")
	}
	if err := cache.Invalidate(ctx, ""); err == nil {
		t.Fatalf("expected error for an empty quote ID")
	}
}
