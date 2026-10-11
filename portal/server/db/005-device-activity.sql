-- Only the latest activity is retained. No request bodies, tokens or query strings.
ALTER TABLE devices
  ADD COLUMN last_login_at timestamptz,
  ADD COLUMN last_request_at timestamptz,
  ADD COLUMN last_request_ip inet,
  ADD COLUMN last_request_action text,
  ADD COLUMN last_configuration_at timestamptz,
  ADD COLUMN last_report_at timestamptz;
