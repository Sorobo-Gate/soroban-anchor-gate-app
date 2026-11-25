package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sync"
	"time"
)

var (
	ErrLedgerAlreadyProcessed = errors.New("ledger sequence has already been processed")
	ErrEventNotFound          = errors.New("outbox event not found")
	ErrLockNotAcquired        = errors.New("could not acquire advisory lock")
)

const (
	OutboxStatusPending    = "pending"
	OutboxStatusProcessing = "processing"
	OutboxStatusCompleted  = "completed"
	OutboxStatusFailed     = "failed"
)

// OutboxEvent represents a durable write-ahead transaction outbox record.
type OutboxEvent struct {
	ID          string     `json:"id"`
	EventID     string     `json:"event_id"`
	EventType   string     `json:"event_type"`
	Payload     string     `json:"payload"`
	Status      string     `json:"status"`
	RetryCount  int        `json:"retry_count"`
	MaxRetries  int        `json:"max_retries"`
	LastError   string     `json:"last_error,omitempty"`
	CreatedAt   time.Time  `json:"created_at"`
	UpdatedAt   time.Time  `json:"updated_at"`
	ProcessedAt *time.Time `json:"processed_at,omitempty"`
}

// OutboxStore defines the interface for durable transactional outbox operations.
type OutboxStore interface {
	InsertLedgerEventsAtomic(ctx context.Context, ledgerSeq uint32, events []OutboxEvent) error
	FetchPendingBatch(ctx context.Context, batchSize int) ([]OutboxEvent, error)
	MarkEventProcessing(ctx context.Context, eventID string) error
	MarkEventCompleted(ctx context.Context, eventID string) error
	MarkEventFailed(ctx context.Context, eventID string, reason string) error
	IsLedgerProcessed(ctx context.Context, ledgerSeq uint32) (bool, error)
	AcquireAdvisoryLock(ctx context.Context, lockID int64) (bool, error)
	ReleaseAdvisoryLock(ctx context.Context, lockID int64) error
	GetEvent(ctx context.Context, eventID string) (*OutboxEvent, error)
}

// PostgresOutboxStore implements OutboxStore backed by PostgreSQL.
type PostgresOutboxStore struct {
	db *sql.DB
}

// NewPostgresOutboxStore creates a new PostgreSQL-backed OutboxStore.
func NewPostgresOutboxStore(db *sql.DB) *PostgresOutboxStore {
	return &PostgresOutboxStore{db: db}
}

// InsertLedgerEventsAtomic atomically inserts processed ledger metadata and outbox events in a single transaction.
func (s *PostgresOutboxStore) InsertLedgerEventsAtomic(ctx context.Context, ledgerSeq uint32, events []OutboxEvent) error {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return fmt.Errorf("failed to begin atomic outbox transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	// 1. Check if ledger already processed
	var existing int
	err = tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM processed_ledgers WHERE ledger_sequence = $1", ledgerSeq).Scan(&existing)
	if err != nil {
		return fmt.Errorf("failed to check processed_ledgers: %w", err)
	}
	if existing > 0 {
		return fmt.Errorf("%w: %d", ErrLedgerAlreadyProcessed, ledgerSeq)
	}

	// 2. Insert into processed_ledgers
	_, err = tx.ExecContext(ctx,
		"INSERT INTO processed_ledgers (ledger_sequence, event_count, processed_at) VALUES ($1, $2, NOW())",
		ledgerSeq, len(events),
	)
	if err != nil {
		return fmt.Errorf("failed to insert processed_ledgers: %w", err)
	}

	// 3. Insert each outbox event
	for _, ev := range events {
		id := ev.ID
		if id == "" {
			id = ev.EventID
		}
		maxRetries := ev.MaxRetries
		if maxRetries <= 0 {
			maxRetries = 5
		}

		_, err = tx.ExecContext(ctx, `
			INSERT INTO outbox_events (id, event_id, event_type, payload, status, retry_count, max_retries, created_at, updated_at)
			VALUES ($1, $2, $3, $4, 'pending', 0, $5, NOW(), NOW())
			ON CONFLICT (event_id) DO NOTHING;
		`, id, ev.EventID, ev.EventType, ev.Payload, maxRetries)
		if err != nil {
			return fmt.Errorf("failed to insert outbox_event %s: %w", ev.EventID, err)
		}
	}

	// 4. Update relay cursor
	_, err = tx.ExecContext(ctx, `
		INSERT INTO relay_cursor (id, last_ledger)
		VALUES (1, $1)
		ON CONFLICT (id) DO UPDATE
		SET last_ledger = EXCLUDED.last_ledger
		WHERE EXCLUDED.last_ledger >= relay_cursor.last_ledger;
	`, ledgerSeq)
	if err != nil {
		return fmt.Errorf("failed to advance relay_cursor: %w", err)
	}

	return tx.Commit()
}

// FetchPendingBatch retrieves pending events up to batchSize.
func (s *PostgresOutboxStore) FetchPendingBatch(ctx context.Context, batchSize int) ([]OutboxEvent, error) {
	if batchSize <= 0 {
		batchSize = 10
	}

	rows, err := s.db.QueryContext(ctx, `
		SELECT id, event_id, event_type, payload, status, retry_count, max_retries, COALESCE(last_error, ''), created_at, updated_at, processed_at
		FROM outbox_events
		WHERE status IN ('pending', 'failed') AND retry_count < max_retries
		ORDER BY created_at ASC
		LIMIT $1
	`, batchSize)
	if err != nil {
		return nil, fmt.Errorf("failed to query outbox_events: %w", err)
	}
	defer rows.Close()

	var events []OutboxEvent
	for rows.Next() {
		var ev OutboxEvent
		var processedAt sql.NullTime
		if err := rows.Scan(
			&ev.ID,
			&ev.EventID,
			&ev.EventType,
			&ev.Payload,
			&ev.Status,
			&ev.RetryCount,
			&ev.MaxRetries,
			&ev.LastError,
			&ev.CreatedAt,
			&ev.UpdatedAt,
			&processedAt,
		); err != nil {
			return nil, fmt.Errorf("failed to scan outbox_event: %w", err)
		}
		if processedAt.Valid {
			ev.ProcessedAt = &processedAt.Time
		}
		events = append(events, ev)
	}

	return events, rows.Err()
}

// MarkEventProcessing transitions an event to processing state.
func (s *PostgresOutboxStore) MarkEventProcessing(ctx context.Context, eventID string) error {
	res, err := s.db.ExecContext(ctx, `
		UPDATE outbox_events
		SET status = 'processing', updated_at = NOW()
		WHERE event_id = $1 AND status <> 'completed'
	`, eventID)
	if err != nil {
		return err
	}
	rows, _ := res.RowsAffected()
	if rows == 0 {
		return ErrEventNotFound
	}
	return nil
}

// MarkEventCompleted marks an outbox event completed with processing timestamp.
func (s *PostgresOutboxStore) MarkEventCompleted(ctx context.Context, eventID string) error {
	res, err := s.db.ExecContext(ctx, `
		UPDATE outbox_events
		SET status = 'completed', updated_at = NOW(), processed_at = NOW(), last_error = NULL
		WHERE event_id = $1
	`, eventID)
	if err != nil {
		return err
	}
	rows, _ := res.RowsAffected()
	if rows == 0 {
		return ErrEventNotFound
	}
	return nil
}

// MarkEventFailed increments retry count and sets last_error. If retries exceeded, sets status to 'failed'.
func (s *PostgresOutboxStore) MarkEventFailed(ctx context.Context, eventID string, reason string) error {
	res, err := s.db.ExecContext(ctx, `
		UPDATE outbox_events
		SET retry_count = retry_count + 1,
		    status = CASE WHEN retry_count + 1 >= max_retries THEN 'failed' ELSE 'pending' END,
		    last_error = $2,
		    updated_at = NOW()
		WHERE event_id = $1
	`, eventID, reason)
	if err != nil {
		return err
	}
	rows, _ := res.RowsAffected()
	if rows == 0 {
		return ErrEventNotFound
	}
	return nil
}

// IsLedgerProcessed checks if a ledger sequence is recorded in processed_ledgers.
func (s *PostgresOutboxStore) IsLedgerProcessed(ctx context.Context, ledgerSeq uint32) (bool, error) {
	var exists bool
	err := s.db.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM processed_ledgers WHERE ledger_sequence = $1)", ledgerSeq).Scan(&exists)
	return exists, err
}

// AcquireAdvisoryLock acquires a PostgreSQL session-level advisory lock.
func (s *PostgresOutboxStore) AcquireAdvisoryLock(ctx context.Context, lockID int64) (bool, error) {
	var acquired bool
	err := s.db.QueryRowContext(ctx, "SELECT pg_try_advisory_lock($1)", lockID).Scan(&acquired)
	return acquired, err
}

// ReleaseAdvisoryLock releases a PostgreSQL session-level advisory lock.
func (s *PostgresOutboxStore) ReleaseAdvisoryLock(ctx context.Context, lockID int64) error {
	var released bool
	err := s.db.QueryRowContext(ctx, "SELECT pg_advisory_unlock($1)", lockID).Scan(&released)
	return err
}

// GetEvent retrieves a single outbox event by event ID.
func (s *PostgresOutboxStore) GetEvent(ctx context.Context, eventID string) (*OutboxEvent, error) {
	var ev OutboxEvent
	var processedAt sql.NullTime
	err := s.db.QueryRowContext(ctx, `
		SELECT id, event_id, event_type, payload, status, retry_count, max_retries, COALESCE(last_error, ''), created_at, updated_at, processed_at
		FROM outbox_events
		WHERE event_id = $1
	`, eventID).Scan(
		&ev.ID,
		&ev.EventID,
		&ev.EventType,
		&ev.Payload,
		&ev.Status,
		&ev.RetryCount,
		&ev.MaxRetries,
		&ev.LastError,
		&ev.CreatedAt,
		&ev.UpdatedAt,
		&processedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrEventNotFound
	}
	if err != nil {
		return nil, err
	}
	if processedAt.Valid {
		ev.ProcessedAt = &processedAt.Time
	}
	return &ev, nil
}

// MemoryOutboxStore provides an in-memory, thread-safe implementation of OutboxStore.
type MemoryOutboxStore struct {
	mu              sync.RWMutex
	ledgers         map[uint32]time.Time
	events          map[string]*OutboxEvent
	cursor          uint32
	advisoryLocks   map[int64]bool
	advisoryLocksMu sync.Mutex
}

// NewMemoryOutboxStore creates an in-memory OutboxStore.
func NewMemoryOutboxStore() *MemoryOutboxStore {
	return &MemoryOutboxStore{
		ledgers:       make(map[uint32]time.Time),
		events:        make(map[string]*OutboxEvent),
		advisoryLocks: make(map[int64]bool),
	}
}

func (m *MemoryOutboxStore) InsertLedgerEventsAtomic(_ context.Context, ledgerSeq uint32, events []OutboxEvent) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if _, exists := m.ledgers[ledgerSeq]; exists {
		return fmt.Errorf("%w: %d", ErrLedgerAlreadyProcessed, ledgerSeq)
	}

	now := time.Now()
	m.ledgers[ledgerSeq] = now

	for _, ev := range events {
		id := ev.ID
		if id == "" {
			id = ev.EventID
		}
		maxRetries := ev.MaxRetries
		if maxRetries <= 0 {
			maxRetries = 5
		}

		if _, exists := m.events[ev.EventID]; !exists {
			m.events[ev.EventID] = &OutboxEvent{
				ID:         id,
				EventID:    ev.EventID,
				EventType:  ev.EventType,
				Payload:    ev.Payload,
				Status:     OutboxStatusPending,
				RetryCount: 0,
				MaxRetries: maxRetries,
				CreatedAt:  now,
				UpdatedAt:  now,
			}
		}
	}

	if ledgerSeq > m.cursor {
		m.cursor = ledgerSeq
	}
	return nil
}

func (m *MemoryOutboxStore) FetchPendingBatch(_ context.Context, batchSize int) ([]OutboxEvent, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	if batchSize <= 0 {
		batchSize = 10
	}

	var batch []OutboxEvent
	for _, ev := range m.events {
		if (ev.Status == OutboxStatusPending || ev.Status == OutboxStatusFailed) && ev.RetryCount < ev.MaxRetries {
			batch = append(batch, *ev)
			if len(batch) >= batchSize {
				break
			}
		}
	}
	return batch, nil
}

func (m *MemoryOutboxStore) MarkEventProcessing(_ context.Context, eventID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	ev, exists := m.events[eventID]
	if !exists {
		return ErrEventNotFound
	}
	if ev.Status == OutboxStatusCompleted {
		return nil
	}
	ev.Status = OutboxStatusProcessing
	ev.UpdatedAt = time.Now()
	return nil
}

func (m *MemoryOutboxStore) MarkEventCompleted(_ context.Context, eventID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	ev, exists := m.events[eventID]
	if !exists {
		return ErrEventNotFound
	}
	now := time.Now()
	ev.Status = OutboxStatusCompleted
	ev.UpdatedAt = now
	ev.ProcessedAt = &now
	ev.LastError = ""
	return nil
}

func (m *MemoryOutboxStore) MarkEventFailed(_ context.Context, eventID string, reason string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	ev, exists := m.events[eventID]
	if !exists {
		return ErrEventNotFound
	}
	ev.RetryCount++
	if ev.RetryCount >= ev.MaxRetries {
		ev.Status = OutboxStatusFailed
	} else {
		ev.Status = OutboxStatusPending
	}
	ev.LastError = reason
	ev.UpdatedAt = time.Now()
	return nil
}

func (m *MemoryOutboxStore) IsLedgerProcessed(_ context.Context, ledgerSeq uint32) (bool, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	_, exists := m.ledgers[ledgerSeq]
	return exists, nil
}

func (m *MemoryOutboxStore) AcquireAdvisoryLock(_ context.Context, lockID int64) (bool, error) {
	m.advisoryLocksMu.Lock()
	defer m.advisoryLocksMu.Unlock()

	if m.advisoryLocks[lockID] {
		return false, nil
	}
	m.advisoryLocks[lockID] = true
	return true, nil
}

func (m *MemoryOutboxStore) ReleaseAdvisoryLock(_ context.Context, lockID int64) error {
	m.advisoryLocksMu.Lock()
	defer m.advisoryLocksMu.Unlock()

	delete(m.advisoryLocks, lockID)
	return nil
}

func (m *MemoryOutboxStore) GetEvent(_ context.Context, eventID string) (*OutboxEvent, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	ev, exists := m.events[eventID]
	if !exists {
		return nil, ErrEventNotFound
	}
	copied := *ev
	return &copied, nil
}

// Cursor returns the latest recorded ledger sequence cursor.
func (m *MemoryOutboxStore) Cursor() uint32 {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.cursor
}
