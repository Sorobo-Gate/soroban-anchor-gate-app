package worker

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/soroban-anchor-gate/relay/internal/store"
	"github.com/soroban-anchor-gate/relay/internal/telemetry"
)

// EventHandler defines the function signature for executing downstream business logic on an outbox event.
type EventHandler func(ctx context.Context, event store.OutboxEvent) error

// OutboxWorkerConfig holds operational tuning knobs for the outbox processor.
type OutboxWorkerConfig struct {
	BatchSize      int           // Number of pending events to fetch per polling iteration (default: 10)
	PollInterval   time.Duration // Duration between poll cycles (default: 500ms)
	AdvisoryLockID int64         // PostgreSQL advisory lock ID for leader election/coordination
	MaxRetries     int           // Maximum delivery retry attempts before marking event failed (default: 5)
}

// DefaultOutboxWorkerConfig returns production defaults for the background worker.
func DefaultOutboxWorkerConfig() OutboxWorkerConfig {
	return OutboxWorkerConfig{
		BatchSize:      10,
		PollInterval:   500 * time.Millisecond,
		AdvisoryLockID: 737475, // Unique key for relay outbox workers
		MaxRetries:     5,
	}
}

// OutboxWorker polls the durable outbox table with advisory locking and processes events reliably.
type OutboxWorker struct {
	store   store.OutboxStore
	handler EventHandler
	config  OutboxWorkerConfig
	logger  *slog.Logger
	metrics *telemetry.Metrics

	running  atomic.Bool
	stopChan chan struct{}
	wg       sync.WaitGroup
}

// NewOutboxWorker creates an initialized OutboxWorker.
func NewOutboxWorker(
	st store.OutboxStore,
	handler EventHandler,
	cfg OutboxWorkerConfig,
	logger *slog.Logger,
) *OutboxWorker {
	if cfg.BatchSize <= 0 {
		cfg.BatchSize = 10
	}
	if cfg.PollInterval <= 0 {
		cfg.PollInterval = 500 * time.Millisecond
	}
	if cfg.AdvisoryLockID == 0 {
		cfg.AdvisoryLockID = 737475
	}
	if cfg.MaxRetries <= 0 {
		cfg.MaxRetries = 5
	}
	if logger == nil {
		logger = slog.Default()
	}

	return &OutboxWorker{
		store:    st,
		handler:  handler,
		config:   cfg,
		logger:   logger,
		stopChan: make(chan struct{}),
	}
}

// SetMetrics attaches Prometheus metrics reporting.
func (w *OutboxWorker) SetMetrics(m *telemetry.Metrics) {
	w.metrics = m
}

// Start spawns the background worker polling loop.
func (w *OutboxWorker) Start(ctx context.Context) error {
	if !w.running.CompareAndSwap(false, true) {
		return errors.New("outbox worker is already running")
	}

	w.wg.Add(1)
	go w.run(ctx)
	w.logger.Info("Outbox background worker started",
		"batch_size", w.config.BatchSize,
		"poll_interval", w.config.PollInterval,
		"advisory_lock_id", w.config.AdvisoryLockID,
	)
	return nil
}

// Stop signals the background worker to shut down gracefully and blocks until complete.
func (w *OutboxWorker) Stop() {
	if w.running.CompareAndSwap(true, false) {
		close(w.stopChan)
		w.wg.Wait()
		w.logger.Info("Outbox background worker stopped cleanly")
	}
}

// run executes the periodic polling tick until context cancellation or Stop() call.
func (w *OutboxWorker) run(ctx context.Context) {
	defer w.wg.Done()

	ticker := time.NewTicker(w.config.PollInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-w.stopChan:
			return
		case <-ticker.C:
			processed, err := w.ProcessBatch(ctx)
			if err != nil && !errors.Is(err, context.Canceled) {
				w.logger.Error("Error executing outbox batch", "error", err)
			} else if processed > 0 {
				w.logger.Debug("Successfully processed outbox batch", "count", processed)
			}
		}
	}
}

// ProcessBatch acquires the advisory lock, fetches a batch of pending events, and processes them.
func (w *OutboxWorker) ProcessBatch(ctx context.Context) (int, error) {
	// 1. Acquire advisory lock to prevent multiple worker replicas from colliding
	locked, err := w.store.AcquireAdvisoryLock(ctx, w.config.AdvisoryLockID)
	if err != nil {
		return 0, fmt.Errorf("failed to acquire advisory lock: %w", err)
	}
	if !locked {
		w.logger.Debug("Advisory lock held by another worker instance, skipping tick", "lock_id", w.config.AdvisoryLockID)
		return 0, nil
	}
	defer func() {
		_ = w.store.ReleaseAdvisoryLock(ctx, w.config.AdvisoryLockID)
	}()

	// 2. Fetch batch of pending events
	events, err := w.store.FetchPendingBatch(ctx, w.config.BatchSize)
	if err != nil {
		return 0, fmt.Errorf("failed to fetch pending outbox events: %w", err)
	}
	if len(events) == 0 {
		return 0, nil
	}

	processedCount := 0

	// 3. Process each event sequentially within the locked batch
	for _, event := range events {
		select {
		case <-ctx.Done():
			return processedCount, ctx.Err()
		case <-w.stopChan:
			return processedCount, nil
		default:
		}

		if err := w.store.MarkEventProcessing(ctx, event.EventID); err != nil {
			w.logger.Warn("Failed to mark event processing", "event_id", event.EventID, "error", err)
			continue
		}

		// Execute downstream business handler
		handlerErr := w.handler(ctx, event)
		if handlerErr != nil {
			w.logger.Error("Event processing failed, recording retry",
				"event_id", event.EventID,
				"retry_count", event.RetryCount+1,
				"error", handlerErr,
			)
			_ = w.store.MarkEventFailed(ctx, event.EventID, handlerErr.Error())
		} else {
			if err := w.store.MarkEventCompleted(ctx, event.EventID); err != nil {
				w.logger.Error("Failed to mark event completed", "event_id", event.EventID, "error", err)
			} else {
				processedCount++
			}
		}
	}

	return processedCount, nil
}
