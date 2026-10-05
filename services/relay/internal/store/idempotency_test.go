package store

import (
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
