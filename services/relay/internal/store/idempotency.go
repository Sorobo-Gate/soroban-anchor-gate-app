package store

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type ProcessingState string

const (
	StateObserved   ProcessingState = "observed"
	StateClaimed    ProcessingState = "claimed"
	StateProcessing ProcessingState = "processing"
	StateCompleted  ProcessingState = "completed"
	StateFailed     ProcessingState = "failed"
)

type EventRecord struct {
	EventID   string          `json:"event_id"`
	State     ProcessingState `json:"state"`
	UpdatedAt int64           `json:"updated_at"`
	Error     string          `json:"error,omitempty"`
}

type IdempotencyStore interface {
	IsProcessed(eventID string) bool
	GetEventState(eventID string) (ProcessingState, bool)
	RecordObserved(eventID string) error
	ClaimForProcessing(eventID string) error
	MarkCompleted(eventID string) error
	MarkFailed(eventID string, reason string) error
	MarkProcessed(eventID string) error
	GetCursor() uint32
	SetCursor(ledger uint32) error
	Close() error
}

type MemoryStore struct {
	mu      sync.RWMutex
	records map[string]EventRecord
	cursor  uint32
}

func NewMemoryStore(startLedger uint32) *MemoryStore {
	return &MemoryStore{
		records: make(map[string]EventRecord),
		cursor:  startLedger,
	}
}

func (s *MemoryStore) IsProcessed(eventID string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	rec, exists := s.records[eventID]
	return exists && rec.State == StateCompleted
}

func (s *MemoryStore) GetEventState(eventID string) (ProcessingState, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	rec, exists := s.records[eventID]
	if !exists {
		return "", false
	}
	return rec.State, true
}

func (s *MemoryStore) RecordObserved(eventID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if rec, exists := s.records[eventID]; exists && rec.State == StateCompleted {
		return fmt.Errorf("event %s already completed", eventID)
	}
	s.records[eventID] = EventRecord{
		EventID:   eventID,
		State:     StateObserved,
		UpdatedAt: time.Now().Unix(),
	}
	return nil
}

func (s *MemoryStore) ClaimForProcessing(eventID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	rec, exists := s.records[eventID]
	if exists && rec.State == StateCompleted {
		return fmt.Errorf("event %s already completed", eventID)
	}
	if exists && rec.State == StateProcessing {
		return fmt.Errorf("event %s is currently being processed", eventID)
	}
	s.records[eventID] = EventRecord{
		EventID:   eventID,
		State:     StateProcessing,
		UpdatedAt: time.Now().Unix(),
	}
	return nil
}

func (s *MemoryStore) MarkCompleted(eventID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if rec, exists := s.records[eventID]; exists && rec.State == StateCompleted {
		return fmt.Errorf("event %s already completed", eventID)
	}
	s.records[eventID] = EventRecord{
		EventID:   eventID,
		State:     StateCompleted,
		UpdatedAt: time.Now().Unix(),
	}
	return nil
}

func (s *MemoryStore) MarkFailed(eventID string, reason string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.records[eventID] = EventRecord{
		EventID:   eventID,
		State:     StateFailed,
		UpdatedAt: time.Now().Unix(),
		Error:     reason,
	}
	return nil
}

func (s *MemoryStore) MarkProcessed(eventID string) error {
	return s.MarkCompleted(eventID)
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

func (s *MemoryStore) Close() error {
	return nil
}

type DurableFileStore struct {
	mu       sync.RWMutex
	filePath string
	records  map[string]EventRecord
	cursor   uint32
}

type persistedState struct {
	Cursor  uint32                 `json:"cursor"`
	Records map[string]EventRecord `json:"records"`
}

func NewDurableFileStore(filePath string, defaultStartLedger uint32) (*DurableFileStore, error) {
	dir := filepath.Dir(filePath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, fmt.Errorf("create store directory: %w", err)
	}

	store := &DurableFileStore{
		filePath: filePath,
		records:  make(map[string]EventRecord),
		cursor:   defaultStartLedger,
	}

	if data, err := os.ReadFile(filePath); err == nil && len(data) > 0 {
		var state persistedState
		if err := json.Unmarshal(data, &state); err == nil {
			if state.Cursor >= defaultStartLedger {
				store.cursor = state.Cursor
			}
			if state.Records != nil {
				store.records = state.Records
			}
		}
	}

	return store, nil
}

func (s *DurableFileStore) saveLocked() error {
	state := persistedState{
		Cursor:  s.cursor,
		Records: s.records,
	}
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal store state: %w", err)
	}

	tmpFile := s.filePath + ".tmp"
	f, err := os.OpenFile(tmpFile, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0644)
	if err != nil {
		return fmt.Errorf("create temp state file: %w", err)
	}

	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		return fmt.Errorf("write temp state file: %w", err)
	}

	if err := f.Sync(); err != nil {
		_ = f.Close()
		return fmt.Errorf("fsync temp state file: %w", err)
	}

	if err := f.Close(); err != nil {
		return fmt.Errorf("close temp state file: %w", err)
	}

	if err := os.Rename(tmpFile, s.filePath); err != nil {
		return fmt.Errorf("atomic rename state file: %w", err)
	}

	return nil
}

func (s *DurableFileStore) IsProcessed(eventID string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	rec, exists := s.records[eventID]
	return exists && rec.State == StateCompleted
}

func (s *DurableFileStore) GetEventState(eventID string) (ProcessingState, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	rec, exists := s.records[eventID]
	if !exists {
		return "", false
	}
	return rec.State, true
}

func (s *DurableFileStore) RecordObserved(eventID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if rec, exists := s.records[eventID]; exists && rec.State == StateCompleted {
		return fmt.Errorf("event %s already completed", eventID)
	}
	s.records[eventID] = EventRecord{
		EventID:   eventID,
		State:     StateObserved,
		UpdatedAt: time.Now().Unix(),
	}
	return s.saveLocked()
}

func (s *DurableFileStore) ClaimForProcessing(eventID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	rec, exists := s.records[eventID]
	if exists && rec.State == StateCompleted {
		return fmt.Errorf("event %s already completed", eventID)
	}
	if exists && rec.State == StateProcessing {
		return fmt.Errorf("event %s is currently being processed", eventID)
	}
	s.records[eventID] = EventRecord{
		EventID:   eventID,
		State:     StateProcessing,
		UpdatedAt: time.Now().Unix(),
	}
	return s.saveLocked()
}

func (s *DurableFileStore) MarkCompleted(eventID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if rec, exists := s.records[eventID]; exists && rec.State == StateCompleted {
		return fmt.Errorf("event %s already completed", eventID)
	}
	s.records[eventID] = EventRecord{
		EventID:   eventID,
		State:     StateCompleted,
		UpdatedAt: time.Now().Unix(),
	}
	return s.saveLocked()
}

func (s *DurableFileStore) MarkFailed(eventID string, reason string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.records[eventID] = EventRecord{
		EventID:   eventID,
		State:     StateFailed,
		UpdatedAt: time.Now().Unix(),
		Error:     reason,
	}
	return s.saveLocked()
}

func (s *DurableFileStore) MarkProcessed(eventID string) error {
	return s.MarkCompleted(eventID)
}

func (s *DurableFileStore) GetCursor() uint32 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.cursor
}

func (s *DurableFileStore) SetCursor(ledger uint32) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if ledger < s.cursor {
		return fmt.Errorf("cursor cannot regress from %d to %d", s.cursor, ledger)
	}
	s.cursor = ledger
	return s.saveLocked()
}

func (s *DurableFileStore) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.saveLocked()
}
