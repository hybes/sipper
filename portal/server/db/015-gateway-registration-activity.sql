-- Keep the latest contact snapshot with its credential lifecycle; no SIP secrets
-- or raw Contact/Via headers are copied into the management activity fields.
ALTER TABLE gateway_credentials
  ADD COLUMN registration_state text CHECK (registration_state IN ('registered','unregistered')),
  ADD COLUMN registration_ip inet,
  ADD COLUMN registration_observed_at timestamptz,
  ADD COLUMN registration_controller uuid;
