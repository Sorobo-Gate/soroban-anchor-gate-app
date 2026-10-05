package store

import (
	"fmt"
	"sync"
)

type IdempotencyStore interface {
	IsProcessed(eventID string) bool
	MarkProcessed(eventID string) error
	GetCursor() uint32
	SetCursor(ledger uint32) error
}

type MemoryStore struct {
	mu        sync.RWMutex
	processed map[string]bool
	cursor    uint32
}

func NewMemoryStore(startLedger uint32) *MemoryStore {
	return &MemoryStore{
		processed: make(map[string]bool),
		cursor:    startLedger,
	}
}

func (s *MemoryStore) IsProcessed(eventID string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.processed[eventID]
}

func (s *MemoryStore) MarkProcessed(eventID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.processed[eventID] {
		return fmt.Errorf("event %s already processed", eventID)
	}
	s.processed[eventID] = true
	return nil
}

func (s *MemoryStore) GetCursor() uint32 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.cursor
}

func (s *MemoryStore) SetCursor(ledger uint32) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if ledger < s.cursor {
		return fmt.Errorf("cursor cannot regress from %d to %d", s.cursor, ledger)
	}
	s.cursor = ledger
	return nil
}
