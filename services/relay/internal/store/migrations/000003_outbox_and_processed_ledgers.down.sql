-- 000003_outbox_and_processed_ledgers.down.sql
DROP INDEX IF EXISTS idx_outbox_events_status_created;
DROP TABLE IF EXISTS outbox_events;
DROP TABLE IF EXISTS processed_ledgers;
