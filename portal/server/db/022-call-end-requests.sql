-- A request is not confirmation that SIP/media has ended. Keep it pending until
-- the owning gateway reports the actual result, including across recovery.
ALTER TABLE gateway_calls ADD COLUMN end_requested_at timestamptz;
ALTER TABLE gateway_calls DROP CONSTRAINT gateway_calls_end_reason_check;
ALTER TABLE gateway_calls ADD CHECK (end_reason IN ('caller_cancelled','completed','rejected','timed_out','failed','admin_ended'));
