-- Outgoing observations use the existing call lifecycle and retention policy.
-- Keep only account/device references; never store the dialled destination.
ALTER TABLE gateway_calls
  ADD COLUMN direction text NOT NULL DEFAULT 'incoming' CHECK (direction IN ('incoming','outgoing')),
  ADD COLUMN origin_device_id uuid,
  ADD COLUMN configuration_revision integer CHECK (configuration_revision > 0),
  ADD FOREIGN KEY (organisation_id,origin_device_id) REFERENCES devices(organisation_id,id) ON DELETE SET NULL (origin_device_id),
  ADD CHECK (direction <> 'outgoing' OR (caller_envelope IS NULL AND winner_device_id IS NULL AND claim_until IS NULL AND state <> 'answering' AND configuration_revision IS NOT NULL)),
  ADD CHECK (direction <> 'incoming' OR origin_device_id IS NULL);
