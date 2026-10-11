-- Existing nodes have no recorded heartbeat time; do not invent one on migration.
ALTER TABLE gateway_nodes ADD COLUMN last_heartbeat_at timestamptz;
CREATE INDEX gateway_calls_customer_history ON gateway_calls (organisation_id,created_at DESC,id DESC);
CREATE INDEX jobs_pending_kind_time ON jobs (kind,available_at) WHERE completed_at IS NULL;
