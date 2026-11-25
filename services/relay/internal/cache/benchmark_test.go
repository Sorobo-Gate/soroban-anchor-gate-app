package cache

import (
	"context"
	"strconv"
	"testing"
	"time"
)

// benchmarkAnchorLatency models the cost of a SEP-38 GET /quote/{id} call
// against a remote anchor: a full TLS round trip plus anchor processing.
const benchmarkAnchorLatency = 250 * time.Microsecond

func newBenchmarkQuoteCache(b *testing.B) *QuoteCache {
	b.Helper()
	cache, err := NewQuoteCache(NewMemoryStore(MemoryConfig{MaxEntries: 8192}), QuoteCacheConfig{})
	if err != nil {
		b.Fatalf("new quote cache: %v", err)
	}
	b.Cleanup(func() { _ = cache.Close() })
	return cache
}

// BenchmarkQuoteLookupCacheHit measures a cache hit for an already-cached
// quote, which is the steady-state path for repeated escrow release checks.
func BenchmarkQuoteLookupCacheHit(b *testing.B) {
	cache := newBenchmarkQuoteCache(b)
	ctx := context.Background()
	expiresAt := time.Now().Add(5 * time.Minute)

	quote := Quote{ID: "quote-hit", ExpiresAt: expiresAt, Price: "1.02"}
	if cached, err := cache.Put(ctx, quote); err != nil || !cached {
		b.Fatalf("seed cache: cached=%v err=%v", cached, err)
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, found, err := cache.Get(ctx, quote.ID); err != nil || !found {
			b.Fatalf("cache hit failed: found=%v err=%v", found, err)
		}
	}
}

// BenchmarkQuoteLookupAnchorRoundTrip measures the uncached path where every
// lookup calls the anchor. Compare its ns/op with BenchmarkQuoteLookupCacheHit
// to quantify the latency improvement.
func BenchmarkQuoteLookupAnchorRoundTrip(b *testing.B) {
	cache := newBenchmarkQuoteCache(b)
	ctx := context.Background()
	expiresAt := time.Now().Add(5 * time.Minute)

	loader := func(_ context.Context, id string) (Quote, error) {
		time.Sleep(benchmarkAnchorLatency)
		return Quote{ID: id, ExpiresAt: expiresAt, Price: "1.02"}, nil
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		// A distinct quote ID per iteration keeps this the genuine cold path.
		if _, err := cache.GetOrLoad(ctx, "quote-"+strconv.Itoa(i), loader); err != nil {
			b.Fatalf("anchor lookup failed: %v", err)
		}
	}
}

// BenchmarkQuoteCachePut measures the cost of writing a freshly fetched quote
// into the cache, including TTL derivation and JSON encoding.
func BenchmarkQuoteCachePut(b *testing.B) {
	cache := newBenchmarkQuoteCache(b)
	ctx := context.Background()
	expiresAt := time.Now().Add(2 * time.Minute)

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		quote := Quote{
			ID:         "quote-" + strconv.Itoa(i),
			ExpiresAt:  expiresAt,
			Price:      "1.02",
			SellAsset:  "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
			SellAmount: "100.00",
			BuyAsset:   "BRL",
			BuyAmount:  "102.00",
		}
		if _, err := cache.Put(ctx, quote); err != nil {
			b.Fatalf("put: %v", err)
		}
	}
}
