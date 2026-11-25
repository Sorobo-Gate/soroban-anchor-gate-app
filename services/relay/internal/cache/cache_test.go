package cache

import (
	"context"
	"sync"
	"testing"
	"time"
)

// fakeClock is a deterministic clock for TTL assertions.
type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func newFakeClock() *fakeClock {
	return &fakeClock{now: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

func TestMemoryStore_SetGetDelete(t *testing.T) {
	store := NewMemoryStore(MemoryConfig{})
	defer store.Close()

	ctx := context.Background()
	if err := store.Set(ctx, "anchor:quote:q-1", []byte("value"), time.Minute); err != nil {
		t.Fatalf("set: %v", err)
	}

	value, found, err := store.Get(ctx, "anchor:quote:q-1")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if !found || string(value) != "value" {
		t.Fatalf("expected cached value, got found=%v value=%q", found, value)
	}

	if err := store.Delete(ctx, "anchor:quote:q-1"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, found, err := store.Get(ctx, "anchor:quote:q-1"); err != nil || found {
		t.Fatalf("expected miss after delete, got found=%v err=%v", found, err)
	}

	// Deleting a missing key is a no-op.
	if err := store.Delete(ctx, "anchor:quote:missing"); err != nil {
		t.Fatalf("delete missing key: %v", err)
	}
}

func TestMemoryStore_ExpiresEntries(t *testing.T) {
	clock := newFakeClock()
	store := NewMemoryStore(MemoryConfig{Clock: clock.Now})
	defer store.Close()

	ctx := context.Background()
	if err := store.Set(ctx, "k", []byte("v"), time.Second); err != nil {
		t.Fatalf("set: %v", err)
	}

	clock.Advance(999 * time.Millisecond)
	if _, found, err := store.Get(ctx, "k"); err != nil || !found {
		t.Fatalf("entry should still be live before the TTL: found=%v err=%v", found, err)
	}

	clock.Advance(time.Millisecond)
	if _, found, err := store.Get(ctx, "k"); err != nil || found {
		t.Fatalf("entry should be expired at the TTL boundary: found=%v err=%v", found, err)
	}
	if store.Len() != 0 {
		t.Fatalf("expired entry should be removed, store holds %d entries", store.Len())
	}
}

func TestMemoryStore_WithoutTTLPersists(t *testing.T) {
	clock := newFakeClock()
	store := NewMemoryStore(MemoryConfig{Clock: clock.Now})
	defer store.Close()

	ctx := context.Background()
	if err := store.Set(ctx, "k", []byte("v"), 0); err != nil {
		t.Fatalf("set: %v", err)
	}
	clock.Advance(24 * time.Hour)
	if _, found, err := store.Get(ctx, "k"); err != nil || !found {
		t.Fatalf("entry without TTL should persist: found=%v err=%v", found, err)
	}
}

func TestMemoryStore_EvictsAtCapacity(t *testing.T) {
	clock := newFakeClock()
	store := NewMemoryStore(MemoryConfig{MaxEntries: 2, Clock: clock.Now})
	defer store.Close()

	ctx := context.Background()
	if err := store.Set(ctx, "a", []byte("1"), time.Minute); err != nil {
		t.Fatalf("set a: %v", err)
	}
	clock.Advance(time.Second)
	if err := store.Set(ctx, "b", []byte("2"), 2*time.Minute); err != nil {
		t.Fatalf("set b: %v", err)
	}
	clock.Advance(time.Second)
	if err := store.Set(ctx, "c", []byte("3"), 3*time.Minute); err != nil {
		t.Fatalf("set c: %v", err)
	}

	if store.Len() > 2 {
		t.Fatalf("store exceeded capacity: %d entries", store.Len())
	}
	if _, found, _ := store.Get(ctx, "a"); found {
		t.Fatalf("entry with the earliest expiry should be evicted first")
	}
	if _, found, _ := store.Get(ctx, "c"); !found {
		t.Fatalf("newest entry must be retained")
	}
}

func TestMemoryStore_EvictsExpiredBeforeLiveEntries(t *testing.T) {
	clock := newFakeClock()
	store := NewMemoryStore(MemoryConfig{MaxEntries: 2, Clock: clock.Now})
	defer store.Close()

	ctx := context.Background()
	if err := store.Set(ctx, "expiring", []byte("1"), time.Second); err != nil {
		t.Fatalf("set expiring: %v", err)
	}
	if err := store.Set(ctx, "live", []byte("2"), time.Hour); err != nil {
		t.Fatalf("set live: %v", err)
	}
	clock.Advance(2 * time.Second)
	if err := store.Set(ctx, "new", []byte("3"), time.Hour); err != nil {
		t.Fatalf("set new: %v", err)
	}

	if _, found, _ := store.Get(ctx, "live"); !found {
		t.Fatalf("live entry must survive eviction")
	}
}

func TestMemoryStore_ReturnsCopies(t *testing.T) {
	store := NewMemoryStore(MemoryConfig{})
	defer store.Close()

	ctx := context.Background()
	original := []byte("value")
	if err := store.Set(ctx, "k", original, time.Minute); err != nil {
		t.Fatalf("set: %v", err)
	}
	original[0] = 'X'

	value, _, err := store.Get(ctx, "k")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	value[0] = 'Y'
	again, _, err := store.Get(ctx, "k")
	if err != nil {
		t.Fatalf("get again: %v", err)
	}
	if string(again) != "value" {
		t.Fatalf("store must not alias caller buffers, got %q", again)
	}
}

func TestMemoryStore_RejectsInvalidKeys(t *testing.T) {
	store := NewMemoryStore(MemoryConfig{})
	defer store.Close()

	ctx := context.Background()
	if err := store.Set(ctx, "", []byte("v"), time.Minute); err == nil {
		t.Fatalf("expected error for empty key")
	}
	if err := store.Set(ctx, "bad key", []byte("v"), time.Minute); err == nil {
		t.Fatalf("expected error for whitespace in key")
	}
	if err := store.Delete(ctx, "a\nb"); err == nil {
		t.Fatalf("expected error for newline in key")
	}
}

func TestMemoryStore_CloseRejectsLaterOperations(t *testing.T) {
	store := NewMemoryStore(MemoryConfig{})
	if err := store.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("second close should be a no-op: %v", err)
	}

	ctx := context.Background()
	if _, _, err := store.Get(ctx, "k"); err != ErrClosed {
		t.Fatalf("expected ErrClosed from Get, got %v", err)
	}
	if err := store.Set(ctx, "k", nil, 0); err != ErrClosed {
		t.Fatalf("expected ErrClosed from Set, got %v", err)
	}
	if err := store.Ping(ctx); err != ErrClosed {
		t.Fatalf("expected ErrClosed from Ping, got %v", err)
	}
}

func TestMemoryStore_ConcurrentAccess(t *testing.T) {
	store := NewMemoryStore(MemoryConfig{MaxEntries: 64})
	defer store.Close()

	ctx := context.Background()
	var wg sync.WaitGroup
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func(worker int) {
			defer wg.Done()
			for j := 0; j < 50; j++ {
				key := "anchor:quote:" + string(rune('a'+worker%8))
				if err := store.Set(ctx, key, []byte("value"), time.Minute); err != nil {
					t.Errorf("set: %v", err)
					return
				}
				if _, _, err := store.Get(ctx, key); err != nil {
					t.Errorf("get: %v", err)
					return
				}
			}
		}(i)
	}
	wg.Wait()
}
