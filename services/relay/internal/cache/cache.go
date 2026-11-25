// Package cache provides the relay's anchor quote caching layer.
//
// SEP-38 quote lookups are on the hot path of every escrow payout: the relay
// must re-fetch a reserved quote before it authorizes an on-chain release, and
// anchor RFQ endpoints are both slow and rate limited. This package caches
// active quotes in Redis with a TTL that mirrors the quote's own SEP-38
// lifetime, so repeated lookups for the same quote ID are served from memory
// instead of the anchor.
//
// The package exposes a small Store contract. RedisStore is the production
// implementation (RESP over TCP with connection pooling and cluster
// redirection); MemoryStore is an in-process implementation used by tests and
// by deployments that run without Redis.
package cache

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"
)

var (
	// ErrClosed is returned when an operation targets a closed store.
	ErrClosed = errors.New("cache: store is closed")
	// ErrInvalidKey is returned when a key is empty, contains whitespace or
	// exceeds MaxKeyBytes.
	ErrInvalidKey = errors.New("cache: invalid key")
	// ErrPoolExhausted is returned when every pooled connection is checked out.
	ErrPoolExhausted = errors.New("cache: connection pool exhausted")
)

const (
	// MaxKeyBytes bounds key length so that a malformed identifier cannot turn
	// into a multi-megabyte Redis command.
	MaxKeyBytes = 512
)

// Store is the minimal key/value contract required by QuoteCache.
//
// Implementations must be safe for concurrent use and must treat an expired
// entry as absent.
type Store interface {
	// Get returns the value stored at key. found is false when the key does not
	// exist or has expired.
	Get(ctx context.Context, key string) (value []byte, found bool, err error)
	// Set stores value at key. A ttl <= 0 stores the value without an expiry.
	Set(ctx context.Context, key string, value []byte, ttl time.Duration) error
	// Delete removes keys. Deleting a missing key is not an error.
	Delete(ctx context.Context, keys ...string) error
	// Ping verifies that the backing store is reachable.
	Ping(ctx context.Context) error
	// Close releases the resources held by the store.
	Close() error
}

// validateKey ensures a key is usable by every Store implementation.
func validateKey(key string) error {
	if key == "" {
		return fmt.Errorf("%w: key cannot be empty", ErrInvalidKey)
	}
	if len(key) > MaxKeyBytes {
		return fmt.Errorf("%w: key is %d bytes, limit is %d", ErrInvalidKey, len(key), MaxKeyBytes)
	}
	for i := 0; i < len(key); i++ {
		switch key[i] {
		case ' ', '\t', '\r', '\n':
			return fmt.Errorf("%w: key cannot contain whitespace", ErrInvalidKey)
		}
	}
	return nil
}

// MemoryConfig configures a MemoryStore.
type MemoryConfig struct {
	// MaxEntries bounds the number of live entries. Defaults to 4096.
	MaxEntries int
	// Clock overrides time.Now. Used by tests to exercise expiry.
	Clock func() time.Time
}

type memoryEntry struct {
	value     []byte
	expiresAt time.Time
	hasExpiry bool
}

// MemoryStore is an in-process Store with per-entry TTLs and bounded capacity.
//
// Capacity is enforced by evicting expired entries first and then the entry
// with the earliest expiry. It is not a strict LRU and is documented as such:
// production deployments that need cross-replica sharing run RedisStore.
type MemoryStore struct {
	mu         sync.RWMutex
	entries    map[string]memoryEntry
	maxEntries int
	now        func() time.Time
	closed     bool
}

// NewMemoryStore creates an in-memory Store.
func NewMemoryStore(cfg MemoryConfig) *MemoryStore {
	maxEntries := cfg.MaxEntries
	if maxEntries <= 0 {
		maxEntries = 4096
	}
	now := cfg.Clock
	if now == nil {
		now = time.Now
	}
	return &MemoryStore{
		entries:    make(map[string]memoryEntry),
		maxEntries: maxEntries,
		now:        now,
	}
}

// Get returns the value stored at key, treating expired entries as absent.
func (m *MemoryStore) Get(_ context.Context, key string) ([]byte, bool, error) {
	if err := validateKey(key); err != nil {
		return nil, false, err
	}

	m.mu.RLock()
	if m.closed {
		m.mu.RUnlock()
		return nil, false, ErrClosed
	}
	entry, ok := m.entries[key]
	m.mu.RUnlock()
	if !ok {
		return nil, false, nil
	}

	if entry.hasExpiry && !m.now().Before(entry.expiresAt) {
		m.mu.Lock()
		delete(m.entries, key)
		m.mu.Unlock()
		return nil, false, nil
	}

	value := make([]byte, len(entry.value))
	copy(value, entry.value)
	return value, true, nil
}

// Set stores value at key, evicting entries when capacity is exceeded.
func (m *MemoryStore) Set(_ context.Context, key string, value []byte, ttl time.Duration) error {
	if err := validateKey(key); err != nil {
		return err
	}

	stored := make([]byte, len(value))
	copy(stored, value)

	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return ErrClosed
	}

	entry := memoryEntry{value: stored}
	if ttl > 0 {
		entry.hasExpiry = true
		entry.expiresAt = m.now().Add(ttl)
	}

	if _, exists := m.entries[key]; !exists {
		m.evictLocked()
	}
	m.entries[key] = entry
	return nil
}

// Delete removes keys from the store.
func (m *MemoryStore) Delete(_ context.Context, keys ...string) error {
	for _, key := range keys {
		if err := validateKey(key); err != nil {
			return err
		}
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return ErrClosed
	}
	for _, key := range keys {
		delete(m.entries, key)
	}
	return nil
}

// Ping reports that the store is usable.
func (m *MemoryStore) Ping(_ context.Context) error {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.closed {
		return ErrClosed
	}
	return nil
}

// Len returns the number of entries currently held, including entries that
// have expired but not yet been swept.
func (m *MemoryStore) Len() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.entries)
}

// Close releases the store. Subsequent operations return ErrClosed.
func (m *MemoryStore) Close() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return nil
	}
	m.closed = true
	m.entries = make(map[string]memoryEntry)
	return nil
}

// evictLocked makes room for one new entry. The caller must hold m.mu.
func (m *MemoryStore) evictLocked() {
	if len(m.entries) < m.maxEntries {
		return
	}

	now := m.now()
	for key, entry := range m.entries {
		if entry.hasExpiry && !now.Before(entry.expiresAt) {
			delete(m.entries, key)
		}
	}
	if len(m.entries) < m.maxEntries {
		return
	}

	var oldestKey string
	var oldestExpiry time.Time
	for key, entry := range m.entries {
		if !entry.hasExpiry {
			continue
		}
		if oldestExpiry.IsZero() || entry.expiresAt.Before(oldestExpiry) {
			oldestKey = key
			oldestExpiry = entry.expiresAt
		}
	}
	if oldestKey == "" {
		// Every entry is permanent: fall back to dropping an arbitrary entry so
		// the store stays bounded.
		for key := range m.entries {
			oldestKey = key
			break
		}
	}
	delete(m.entries, oldestKey)
}

var _ Store = (*MemoryStore)(nil)
