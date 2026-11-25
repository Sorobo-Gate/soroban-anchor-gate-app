package worker

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/soroban-anchor-gate/relay/internal/store"
)

func TestOutboxWorker_BatchProcessingAndAdvisoryLocking(t *testing.T) {
	st := store.NewMemoryOutboxStore()
	ctx := context.Background()

	// Ingest 5 events
	var events []store.OutboxEvent
	for i := 1; i <= 5; i++ {
		events = append(events, store.OutboxEvent{
			EventID:   fmt.Sprintf("ev-%d", i),
			EventType: "disbursed",
			Payload:   fmt.Sprintf(`{"escrow_id":%d}`, i),
		})
	}
	_ = st.InsertLedgerEventsAtomic(ctx, 10, events)

	var handledCount int32
	handler := func(ctx context.Context, ev store.OutboxEvent) error {
		atomic.AddInt32(&handledCount, 1)
		return nil
	}

	cfg := OutboxWorkerConfig{
		BatchSize:      3, // fetch in batches of 3
		PollInterval:   20 * time.Millisecond,
		AdvisoryLockID: 999111,
		MaxRetries:     3,
	}

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	worker1 := NewOutboxWorker(st, handler, cfg, logger)

	// Process one batch of 3
	processed, err := worker1.ProcessBatch(ctx)
	if err != nil {
		t.Fatalf("ProcessBatch failed: %v", err)
	}
	if processed != 3 {
		t.Fatalf("expected 3 events processed, got %d", processed)
	}

	// Verify advisory lock contention: if lock is held externally, worker should skip
	_, _ = st.AcquireAdvisoryLock(ctx, cfg.AdvisoryLockID)
	skipped, err := worker1.ProcessBatch(ctx)
	if err != nil {
		t.Fatalf("ProcessBatch with external lock failed: %v", err)
	}
	if skipped != 0 {
		t.Fatalf("expected 0 events processed while locked, got %d", skipped)
	}
	_ = st.ReleaseAdvisoryLock(ctx, cfg.AdvisoryLockID)

	// Process remaining batch
	processed, err = worker1.ProcessBatch(ctx)
	if err != nil {
		t.Fatalf("ProcessBatch failed: %v", err)
	}
	if processed != 2 {
		t.Fatalf("expected remaining 2 events processed, got %d", processed)
	}

	if atomic.LoadInt32(&handledCount) != 5 {
		t.Fatalf("expected 5 total events handled, got %d", atomic.LoadInt32(&handledCount))
	}
}

func TestOutboxWorker_RetriesAndFailureThreshold(t *testing.T) {
	st := store.NewMemoryOutboxStore()
	ctx := context.Background()

	ev := store.OutboxEvent{
		EventID:    "flaky-ev",
		EventType:  "disbursed",
		Payload:    `{"test":true}`,
		MaxRetries: 2,
	}
	_ = st.InsertLedgerEventsAtomic(ctx, 20, []store.OutboxEvent{ev})

	var attempts int32
	failingHandler := func(ctx context.Context, ev store.OutboxEvent) error {
		atomic.AddInt32(&attempts, 1)
		return errors.New("temporary downstream failure")
	}

	cfg := OutboxWorkerConfig{
		BatchSize:      5,
		PollInterval:   20 * time.Millisecond,
		AdvisoryLockID: 888222,
		MaxRetries:     2,
	}

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	w := NewOutboxWorker(st, failingHandler, cfg, logger)

	// Attempt 1: fails, increments retry_count to 1
	_, _ = w.ProcessBatch(ctx)
	item, _ := st.GetEvent(ctx, "flaky-ev")
	if item.RetryCount != 1 || item.Status != store.OutboxStatusPending {
		t.Fatalf("expected retry_count=1, status=pending, got retry_count=%d, status=%s", item.RetryCount, item.Status)
	}

	// Attempt 2: fails, reaches max_retries 2 -> marked failed
	_, _ = w.ProcessBatch(ctx)
	item, _ = st.GetEvent(ctx, "flaky-ev")
	if item.RetryCount != 2 || item.Status != store.OutboxStatusFailed {
		t.Fatalf("expected retry_count=2, status=failed, got retry_count=%d, status=%s", item.RetryCount, item.Status)
	}
}

func TestOutboxWorker_ZeroEventLossAcrossSimulatedDaemonCrash(t *testing.T) {
	st := store.NewMemoryOutboxStore()
	ctx := context.Background()

	// Ingest 30 events across 3 ledgers
	const totalEvents = 30
	var ledger1Events, ledger2Events, ledger3Events []store.OutboxEvent
	for i := 1; i <= 10; i++ {
		ledger1Events = append(ledger1Events, store.OutboxEvent{
			EventID:   fmt.Sprintf("crash-ev-%d", i),
			EventType: "disbursed",
			Payload:   fmt.Sprintf(`{"index":%d}`, i),
		})
	}
	for i := 11; i <= 20; i++ {
		ledger2Events = append(ledger2Events, store.OutboxEvent{
			EventID:   fmt.Sprintf("crash-ev-%d", i),
			EventType: "disbursed",
			Payload:   fmt.Sprintf(`{"index":%d}`, i),
		})
	}
	for i := 21; i <= 30; i++ {
		ledger3Events = append(ledger3Events, store.OutboxEvent{
			EventID:   fmt.Sprintf("crash-ev-%d", i),
			EventType: "disbursed",
			Payload:   fmt.Sprintf(`{"index":%d}`, i),
		})
	}

	_ = st.InsertLedgerEventsAtomic(ctx, 101, ledger1Events)
	_ = st.InsertLedgerEventsAtomic(ctx, 102, ledger2Events)
	_ = st.InsertLedgerEventsAtomic(ctx, 103, ledger3Events)

	var mu sync.Mutex
	processedMap := make(map[string]int)

	handler := func(ctx context.Context, ev store.OutboxEvent) error {
		mu.Lock()
		processedMap[ev.EventID]++
		mu.Unlock()
		return nil
	}

	cfg := OutboxWorkerConfig{
		BatchSize:      4,
		PollInterval:   15 * time.Millisecond,
		AdvisoryLockID: 777333,
		MaxRetries:     3,
	}

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))

	// 1. Start worker 1 (daemon instance 1)
	crashCtx, crashCancel := context.WithCancel(context.Background())
	worker1 := NewOutboxWorker(st, handler, cfg, logger)
	_ = worker1.Start(crashCtx)

	// Wait until at least 10 events are processed
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		count := len(processedMap)
		mu.Unlock()
		if count >= 10 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	// 2. Simulate Daemon Crash: Abrupt cancellation / termination
	crashCancel()
	worker1.Stop()

	mu.Lock()
	processedBeforeCrash := len(processedMap)
	mu.Unlock()
	t.Logf("Simulated crash occurred after %d events processed", processedBeforeCrash)

	// Verify that pending events remain in the durable outbox store
	pendingAfterCrash, err := st.FetchPendingBatch(ctx, totalEvents)
	if err != nil {
		t.Fatalf("FetchPendingBatch after crash failed: %v", err)
	}
	if len(pendingAfterCrash) != totalEvents-processedBeforeCrash {
		t.Fatalf("expected %d pending events in WAL/outbox after crash, got %d",
			totalEvents-processedBeforeCrash, len(pendingAfterCrash))
	}

	// 3. Daemon Reboot: Spin up new worker instance on the same durable store
	rebootCtx, rebootCancel := context.WithCancel(context.Background())
	defer rebootCancel()

	worker2 := NewOutboxWorker(st, handler, cfg, logger)
	_ = worker2.Start(rebootCtx)

	// Wait until all 30 events are processed
	rebootDeadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(rebootDeadline) {
		mu.Lock()
		count := len(processedMap)
		mu.Unlock()
		if count == totalEvents {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	worker2.Stop()

	// 4. Verify ZERO event loss and ZERO duplicates across the crash
	mu.Lock()
	finalCount := len(processedMap)
	duplicates := 0
	for eventID, times := range processedMap {
		if times > 1 {
			duplicates++
			t.Errorf("event %s was executed %d times (expected exactly 1)", eventID, times)
		}
	}
	mu.Unlock()

	if finalCount != totalEvents {
		t.Fatalf("ZERO EVENT LOSS VIOLATION: expected %d events processed, got %d", totalEvents, finalCount)
	}
	if duplicates > 0 {
		t.Fatalf("IDEMPOTENCY VIOLATION: %d events suffered duplicate execution across crash", duplicates)
	}

	// Verify all events in store have status 'completed'
	for i := 1; i <= totalEvents; i++ {
		evID := fmt.Sprintf("crash-ev-%d", i)
		ev, err := st.GetEvent(ctx, evID)
		if err != nil {
			t.Fatalf("failed to get event %s: %v", evID, err)
		}
		if ev.Status != store.OutboxStatusCompleted {
			t.Fatalf("event %s has status %s (expected %s)", evID, ev.Status, store.OutboxStatusCompleted)
		}
	}
}
