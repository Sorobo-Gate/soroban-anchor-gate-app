-- 000003_outbox_and_processed_ledgers.up.sql
CREATE TABLE IF NOT EXISTS outbox_events (
    id VARCHAR(128) PRIMARY KEY,
    event_id VARCHAR(128) NOT NULL UNIQUE,
    event_type VARCHAR(64) NOT NULL,
    payload TEXT NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'pending',
    retry_count INT NOT NULL DEFAULT 0,
    max_retries INT NOT NULL DEFAULT 5,
    last_error TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    processed_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_outbox_events_status_created ON outbox_events(status, created_at);

CREATE TABLE IF NOT EXISTS processed_ledgers (
    ledger_sequence BIGINT PRIMARY KEY,
    event_count INT NOT NULL DEFAULT 0,
    processed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
