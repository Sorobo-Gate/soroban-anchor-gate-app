package store

import (
	"path/filepath"
	"testing"
)

func TestMemoryStore_Idempotency(t *testing.T) {
	s := NewMemoryStore(100)

	if s.IsProcessed("event-1") {
		t.Fatalf("expected event-1 to not be processed")
	}

	if err := s.MarkProcessed("event-1"); err != nil {
		t.Fatalf("failed to mark event-1 processed: %v", err)
	}

	if !s.IsProcessed("event-1") {
		t.Fatalf("expected event-1 to be marked processed")
	}

	if err := s.MarkProcessed("event-1"); err == nil {
		t.Fatalf("expected duplicate processing to return error")
	}
}

func TestMemoryStore_ProcessingLifecycle(t *testing.T) {
	s := NewMemoryStore(100)

	if err := s.RecordObserved("ev-10"); err != nil {
		t.Fatalf("unexpected error observing event: %v", err)
	}
	state, ok := s.GetEventState("ev-10")
	if !ok || state != StateObserved {
		t.Fatalf("expected state %s, got %s", StateObserved, state)
	}

	if err := s.ClaimForProcessing("ev-10"); err != nil {
		t.Fatalf("unexpected error claiming event: %v", err)
	}
	state, _ = s.GetEventState("ev-10")
	if state != StateProcessing {
		t.Fatalf("expected state %s, got %s", StateProcessing, state)
	}

	// Claiming again while processing should fail
	if err := s.ClaimForProcessing("ev-10"); err == nil {
		t.Fatalf("expected error claiming already processing event")
	}

	if err := s.MarkCompleted("ev-10"); err != nil {
		t.Fatalf("unexpected error completing event: %v", err)
	}
	if !s.IsProcessed("ev-10") {
		t.Fatalf("expected event to be marked processed after completion")
	}
}

func TestMemoryStore_Cursor(t *testing.T) {
	s := NewMemoryStore(100)

	if s.GetCursor() != 100 {
		t.Fatalf("expected initial cursor 100, got %d", s.GetCursor())
	}

	if err := s.SetCursor(105); err != nil {
		t.Fatalf("failed to advance cursor: %v", err)
	}

	if s.GetCursor() != 105 {
		t.Fatalf("expected cursor 105, got %d", s.GetCursor())
	}

	if err := s.SetCursor(102); err == nil {
		t.Fatalf("expected cursor regression error")
	}
}

func TestDurableFileStore_PersistenceAndRestartRecovery(t *testing.T) {
	tempDir := t.TempDir()
	storePath := filepath.Join(tempDir, "relay_state.json")

	// 1. Initial process session
	store1, err := NewDurableFileStore(storePath, 500)
	if err != nil {
		t.Fatalf("failed to create durable store: %v", err)
	}

	if err := store1.SetCursor(550); err != nil {
		t.Fatalf("failed to advance cursor: %v", err)
	}
	if err := store1.RecordObserved("ev-persisted-1"); err != nil {
		t.Fatalf("failed to observe event: %v", err)
	}
	if err := store1.ClaimForProcessing("ev-persisted-1"); err != nil {
		t.Fatalf("failed to claim event: %v", err)
	}
	if err := store1.MarkCompleted("ev-persisted-1"); err != nil {
		t.Fatalf("failed to complete event: %v", err)
	}

	if err := store1.RecordObserved("ev-persisted-failed"); err != nil {
		t.Fatalf("failed to observe failed event: %v", err)
	}
	if err := store1.MarkFailed("ev-persisted-failed", "network timeout"); err != nil {
		t.Fatalf("failed to mark failed: %v", err)
	}

	if err := store1.Close(); err != nil {
		t.Fatalf("failed to close store: %v", err)
	}

	// 2. Simulated restart recovery in new process session
	store2, err := NewDurableFileStore(storePath, 500)
	if err != nil {
		t.Fatalf("failed to restore durable store on restart: %v", err)
	}

	// Cursor must be restored to 550, not start at default 500
	if store2.GetCursor() != 550 {
		t.Fatalf("expected recovered cursor 550, got %d", store2.GetCursor())
	}

	// Completed event must remain completed
	if !store2.IsProcessed("ev-persisted-1") {
		t.Fatalf("expected ev-persisted-1 to remain completed after restart")
	}
	state1, ok1 := store2.GetEventState("ev-persisted-1")
	if !ok1 || state1 != StateCompleted {
		t.Fatalf("expected state %s, got %s", StateCompleted, state1)
	}

	// Failed event must retain failure record
	stateFailed, okFailed := store2.GetEventState("ev-persisted-failed")
	if !okFailed || stateFailed != StateFailed {
		t.Fatalf("expected state %s, got %s", StateFailed, stateFailed)
	}
}
