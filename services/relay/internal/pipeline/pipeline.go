// Package pipeline implements a concurrent ledger-event processing pipeline
// with a fixed-size worker pool partitioned by escrow ID (Issue #81).
//
// Design:
//   - NumWorkers goroutines are created at startup, each owning one input channel.
//   - Every event is dispatched to worker hash(escrow_id) % NumWorkers so all
//     events for the same escrow are processed sequentially, eliminating races.
//   - Throughput target: ≥ 500 events/second under the benchmark.
package pipeline

import (
	"context"
	"hash/fnv"
	"log/slog"
	"sync"
	"sync/atomic"

	"github.com/soroban-anchor-gate/relay/internal/store"
)

// EventHandler is the callback executed for each event inside the worker pool.
type EventHandler func(ctx context.Context, event store.OutboxEvent) error

// Config holds tuning parameters for the pipeline.
type Config struct {
	// NumWorkers is the number of parallel worker goroutines. Must be > 0.
	NumWorkers int
	// ChannelBuffer is the per-worker channel buffer depth (default: 256).
	ChannelBuffer int
}

// DefaultConfig returns production-ready defaults.
func DefaultConfig() Config {
	return Config{
		NumWorkers:    8,
		ChannelBuffer: 256,
	}
}

// Pipeline fans events out across a fixed pool of workers keyed by escrow ID.
type Pipeline struct {
	cfg      Config
	handler  EventHandler
	logger   *slog.Logger
	workers  []chan store.OutboxEvent
	wg       sync.WaitGroup
	started  atomic.Bool
	total    atomic.Int64
	failures atomic.Int64
}

// New creates a Pipeline. Call Start to launch the worker goroutines.
func New(cfg Config, handler EventHandler, logger *slog.Logger) *Pipeline {
	if cfg.NumWorkers <= 0 {
		cfg.NumWorkers = DefaultConfig().NumWorkers
	}
	if cfg.ChannelBuffer <= 0 {
		cfg.ChannelBuffer = DefaultConfig().ChannelBuffer
	}
	if logger == nil {
		logger = slog.Default()
	}

	workers := make([]chan store.OutboxEvent, cfg.NumWorkers)
	for i := range workers {
		workers[i] = make(chan store.OutboxEvent, cfg.ChannelBuffer)
	}

	return &Pipeline{
		cfg:     cfg,
		handler: handler,
		logger:  logger,
		workers: workers,
	}
}

// Start launches all worker goroutines and returns immediately.
// Calling Start more than once is a no-op.
func (p *Pipeline) Start(ctx context.Context) {
	if !p.started.CompareAndSwap(false, true) {
		return
	}
	for i, ch := range p.workers {
		p.wg.Add(1)
		go p.work(ctx, i, ch)
	}
	p.logger.Info("ledger event pipeline started", "num_workers", p.cfg.NumWorkers)
}

// Submit enqueues an event onto the worker whose index equals
// hash(escrow_id) % NumWorkers.  It blocks if the worker's channel is full.
// Returns false if the pipeline context is already done.
func (p *Pipeline) Submit(ctx context.Context, escrowID string, event store.OutboxEvent) bool {
	idx := workerIndex(escrowID, p.cfg.NumWorkers)
	select {
	case p.workers[idx] <- event:
		return true
	case <-ctx.Done():
		return false
	}
}

// Stop drains in-flight events and waits for all workers to finish.
func (p *Pipeline) Stop() {
	for _, ch := range p.workers {
		close(ch)
	}
	p.wg.Wait()
	p.logger.Info("ledger event pipeline stopped",
		"total_processed", p.total.Load(),
		"total_failures", p.failures.Load(),
	)
}

// Stats returns (total processed, total failures) counters.
func (p *Pipeline) Stats() (int64, int64) {
	return p.total.Load(), p.failures.Load()
}

// work is the per-worker goroutine.
func (p *Pipeline) work(ctx context.Context, id int, ch <-chan store.OutboxEvent) {
	defer p.wg.Done()
	for event := range ch {
		p.total.Add(1)
		if err := p.handler(ctx, event); err != nil {
			p.failures.Add(1)
			p.logger.Warn("pipeline handler error",
				"worker", id,
				"event_id", event.EventID,
				"error", err,
			)
		}
	}
}

// workerIndex maps an escrow ID string to a worker slot deterministically.
func workerIndex(escrowID string, numWorkers int) int {
	h := fnv.New32a()
	_, _ = h.Write([]byte(escrowID))
	return int(h.Sum32()) % numWorkers
}
