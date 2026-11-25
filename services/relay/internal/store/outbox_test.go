package store

import (
	"context"
	"errors"
	"testing"
)

func TestMemoryOutboxStore_AtomicLedgerInsertion(t *testing.T) {
	st := NewMemoryOutboxStore()
	ctx := context.Background()

	events := []OutboxEvent{
		{
			EventID:   "ev-1",
			EventType: "disbursed",
			Payload:   `{"escrow_id":1,"amount":"5000"}`,
		},
		{
			EventID:   "ev-2",
			EventType: "disbursed",
			Payload:   `{"escrow_id":2,"amount":"7500"}`,
		},
	}

	// 1. First atomic insertion
	err := st.InsertLedgerEventsAtomic(ctx, 100, events)
	if err != nil {
		t.Fatalf("InsertLedgerEventsAtomic failed: %v", err)
	}

	processed, err := st.IsLedgerProcessed(ctx, 100)
	if err != nil || !processed {
		t.Fatalf("expected ledger 100 to be processed, got %v, err=%v", processed, err)
	}

	if st.Cursor() != 100 {
		t.Fatalf("expected cursor 100, got %d", st.Cursor())
	}

	// 2. Duplicate insertion of same ledger must be rejected atomically
	err = st.InsertLedgerEventsAtomic(ctx, 100, events)
	if err == nil || !errors.Is(err, ErrLedgerAlreadyProcessed) {
		t.Fatalf("expected ErrLedgerAlreadyProcessed, got: %v", err)
	}

	// 3. Batch retrieval
	batch, err := st.FetchPendingBatch(ctx, 10)
	if err != nil {
		t.Fatalf("FetchPendingBatch failed: %v", err)
	}
	if len(batch) != 2 {
		t.Fatalf("expected 2 pending events, got %d", len(batch))
	}
}

func TestMemoryOutboxStore_StatusTransitions(t *testing.T) {
	st := NewMemoryOutboxStore()
	ctx := context.Background()

	ev := OutboxEvent{
		EventID:   "ev-test",
		EventType: "payout",
		Payload:   `{"id":42}`,
	}
	_ = st.InsertLedgerEventsAtomic(ctx, 50, []OutboxEvent{ev})

	// 1. Mark processing
	err := st.MarkEventProcessing(ctx, "ev-test")
	if err != nil {
		t.Fatalf("MarkEventProcessing failed: %v", err)
	}
	item, _ := st.GetEvent(ctx, "ev-test")
	if item.Status != OutboxStatusProcessing {
		t.Fatalf("expected status %s, got %s", OutboxStatusProcessing, item.Status)
	}

	// 2. Mark completed
	err = st.MarkEventCompleted(ctx, "ev-test")
	if err != nil {
		t.Fatalf("MarkEventCompleted failed: %v", err)
	}
	item, _ = st.GetEvent(ctx, "ev-test")
	if item.Status != OutboxStatusCompleted {
		t.Fatalf("expected status %s, got %s", OutboxStatusCompleted, item.Status)
	}
	if item.ProcessedAt == nil {
		t.Fatal("expected non-nil ProcessedAt")
	}

	// 3. Completed events should not be returned in pending batch
	batch, _ := st.FetchPendingBatch(ctx, 10)
	if len(batch) != 0 {
		t.Fatalf("expected 0 pending events after completion, got %d", len(batch))
	}
}

func TestMemoryOutboxStore_AdvisoryLock(t *testing.T) {
	st := NewMemoryOutboxStore()
	ctx := context.Background()

	lockID := int64(123456)

	// First acquire must succeed
	acquired, err := st.AcquireAdvisoryLock(ctx, lockID)
	if err != nil || !acquired {
		t.Fatalf("expected lock acquired, got %v, err=%v", acquired, err)
	}

	// Second acquire on same lock must fail (already locked)
	secondAcquire, err := st.AcquireAdvisoryLock(ctx, lockID)
	if err != nil || secondAcquire {
		t.Fatalf("expected second lock acquisition to fail, got %v", secondAcquire)
	}

	// Release lock
	err = st.ReleaseAdvisoryLock(ctx, lockID)
	if err != nil {
		t.Fatalf("ReleaseAdvisoryLock failed: %v", err)
	}

	// Third acquire after release must succeed
	thirdAcquire, err := st.AcquireAdvisoryLock(ctx, lockID)
	if err != nil || !thirdAcquire {
		t.Fatalf("expected third lock acquisition to succeed, got %v", thirdAcquire)
	}
}
