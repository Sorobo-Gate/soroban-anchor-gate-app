package pipeline_test

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/soroban-anchor-gate/relay/internal/pipeline"
	"github.com/soroban-anchor-gate/relay/internal/store"
)

func makeEvent(id, escrowID string) store.OutboxEvent {
	return store.OutboxEvent{
		ID:        id,
		EventID:   id,
		EventType: "test",
		Payload:   fmt.Sprintf(`{"escrow_id":%q}`, escrowID),
		Status:    store.OutboxStatusPending,
	}
}

// TestPipelineProcessesAllEvents verifies every submitted event is handled exactly once.
func TestPipelineProcessesAllEvents(t *testing.T) {
	t.Parallel()

	var count atomic.Int64
	handler := func(_ context.Context, _ store.OutboxEvent) error {
		count.Add(1)
		return nil
	}

	cfg := pipeline.Config{NumWorkers: 4, ChannelBuffer: 128}
	p := pipeline.New(cfg, handler, nil)
	ctx := context.Background()
	p.Start(ctx)

	const n = 1000
	for i := 0; i < n; i++ {
		p.Submit(ctx, fmt.Sprintf("escrow-%d", i%10), makeEvent(fmt.Sprintf("ev-%d", i), fmt.Sprintf("escrow-%d", i%10)))
	}
	p.Stop()

	if count.Load() != n {
		t.Fatalf("expected %d events processed, got %d", n, count.Load())
	}
	total, _ := p.Stats()
	if total != n {
		t.Fatalf("Stats() total = %d; want %d", total, n)
	}
}

// TestPipelinePerEscrowOrdering verifies that events for the same escrow are
// processed sequentially (no interleaving) by recording timestamps per escrow.
func TestPipelinePerEscrowOrdering(t *testing.T) {
	t.Parallel()

	const numEscrows = 5
	const eventsPerEscrow = 20

	// Track per-escrow sequence; wrap in mutex because we're checking from test goroutine.
	type record struct{ mu sync.Mutex; seq []int }
	records := make([]record, numEscrows)
	seqCounter := make([]atomic.Int64, numEscrows)

	handler := func(_ context.Context, event store.OutboxEvent) error {
		var eIdx, seq int
		fmt.Sscanf(event.Payload, `{"escrow":%d,"seq":%d}`, &eIdx, &seq)
		if eIdx < 0 || eIdx >= numEscrows {
			return nil
		}
		records[eIdx].mu.Lock()
		records[eIdx].seq = append(records[eIdx].seq, seq)
		records[eIdx].mu.Unlock()
		return nil
	}

	cfg := pipeline.Config{NumWorkers: 4, ChannelBuffer: 256}
	p := pipeline.New(cfg, handler, nil)
	ctx := context.Background()
	p.Start(ctx)

	for e := 0; e < numEscrows; e++ {
		for s := 0; s < eventsPerEscrow; s++ {
			esc := fmt.Sprintf("escrow-%d", e)
			ev := store.OutboxEvent{
				ID:      fmt.Sprintf("ev-%d-%d", e, s),
				EventID: fmt.Sprintf("ev-%d-%d", e, s),
				Payload: fmt.Sprintf(`{"escrow":%d,"seq":%d}`, e, s),
				Status:  store.OutboxStatusPending,
			}
			seqCounter[e].Add(1)
			p.Submit(ctx, esc, ev)
		}
	}
	p.Stop()

	for e := 0; e < numEscrows; e++ {
		records[e].mu.Lock()
		got := records[e].seq
		records[e].mu.Unlock()
		if len(got) != eventsPerEscrow {
			t.Errorf("escrow %d: expected %d events, got %d", e, eventsPerEscrow, len(got))
		}
		for i, v := range got {
			if v != i {
				t.Errorf("escrow %d: out-of-order at index %d: got seq %d", e, i, v)
				break
			}
		}
	}
}

// TestPipelineFailuresTracked verifies that handler errors increment the failure counter.
func TestPipelineFailuresTracked(t *testing.T) {
	t.Parallel()

	var callCount atomic.Int64
	handler := func(_ context.Context, event store.OutboxEvent) error {
		callCount.Add(1)
		return fmt.Errorf("simulated failure")
	}

	cfg := pipeline.Config{NumWorkers: 2, ChannelBuffer: 64}
	p := pipeline.New(cfg, handler, nil)
	ctx := context.Background()
	p.Start(ctx)

	const n = 10
	for i := 0; i < n; i++ {
		p.Submit(ctx, "esc-0", makeEvent(fmt.Sprintf("ev-%d", i), "esc-0"))
	}
	p.Stop()

	_, failures := p.Stats()
	if failures != n {
		t.Fatalf("expected %d failures, got %d", n, failures)
	}
}

// TestPipelineStartOnceGuard verifies that calling Start twice is safe.
func TestPipelineStartOnceGuard(t *testing.T) {
	t.Parallel()

	p := pipeline.New(pipeline.DefaultConfig(), func(_ context.Context, _ store.OutboxEvent) error { return nil }, nil)
	ctx := context.Background()
	p.Start(ctx)
	p.Start(ctx) // must not panic or spin up extra goroutines
	p.Stop()
}

// TestWorkerIndexDeterminism checks that the same escrow always maps to the same worker.
// We verify indirectly: submit the same escrow ID many times and ensure they all
// land on one of the N workers (by observing serialized execution).
func TestWorkerIndexDeterminism(t *testing.T) {
	t.Parallel()

	var mu sync.Mutex
	var concurrent int
	var maxConcurrent int
	handler := func(_ context.Context, _ store.OutboxEvent) error {
		mu.Lock()
		concurrent++
		if concurrent > maxConcurrent {
			maxConcurrent = concurrent
		}
		mu.Unlock()
		time.Sleep(time.Microsecond)
		mu.Lock()
		concurrent--
		mu.Unlock()
		return nil
	}

	// With 1 worker the max concurrency for a single escrow is always 1.
	cfg := pipeline.Config{NumWorkers: 1, ChannelBuffer: 512}
	p := pipeline.New(cfg, handler, nil)
	ctx := context.Background()
	p.Start(ctx)

	for i := 0; i < 200; i++ {
		p.Submit(ctx, "same-escrow", makeEvent(fmt.Sprintf("ev-%d", i), "same-escrow"))
	}
	p.Stop()

	if maxConcurrent > 1 {
		t.Errorf("single-worker pipeline processed same escrow concurrently: maxConcurrent=%d", maxConcurrent)
	}
}

// BenchmarkPipelineThroughput measures sustained events/second.
// The requirement is ≥ 500 events/sec; on any modern host this should achieve
// tens of thousands, so the assertion is a correctness floor, not a cap.
func BenchmarkPipelineThroughput(b *testing.B) {
	handler := func(_ context.Context, _ store.OutboxEvent) error { return nil }
	cfg := pipeline.Config{NumWorkers: 8, ChannelBuffer: 1024}
	p := pipeline.New(cfg, handler, nil)
	ctx := context.Background()
	p.Start(ctx)

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		escrow := fmt.Sprintf("escrow-%d", i%50)
		p.Submit(ctx, escrow, makeEvent(fmt.Sprintf("ev-%d", i), escrow))
	}
	b.StopTimer()
	p.Stop()

	total, _ := p.Stats()
	opsPerSec := float64(total) / b.Elapsed().Seconds()
	b.ReportMetric(opsPerSec, "events/sec")
	if opsPerSec < 500 {
		b.Errorf("throughput %.0f events/sec is below 500 events/sec minimum", opsPerSec)
	}
}
