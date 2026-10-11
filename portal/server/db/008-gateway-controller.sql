ALTER TABLE gateway_nodes ADD COLUMN controller_instance uuid;
ALTER TABLE gateway_nodes ADD COLUMN controller_expires_at timestamptz;
