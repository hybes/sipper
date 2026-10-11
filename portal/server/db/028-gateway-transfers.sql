-- A transfer is an admitted operation on existing calls, not a new device grant.
-- Keep attempts across controller restarts. Terminal rows follow call retention.
CREATE TABLE gateway_transfers (
  id uuid PRIMARY KEY,
  gateway_id text NOT NULL,
  organisation_id uuid NOT NULL,
  call_id uuid NOT NULL,
  consultation_call_id uuid,
  device_id uuid NOT NULL,
  configuration_id uuid NOT NULL,
  configuration_revision integer NOT NULL CHECK (configuration_revision > 0),
  destination_envelope jsonb,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','completed','failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '45 seconds',
  completed_at timestamptz,
  CHECK ((consultation_call_id IS NULL) <> (destination_envelope IS NULL)),
  CHECK (consultation_call_id IS NULL OR consultation_call_id <> call_id),
  CHECK ((state='pending') = (completed_at IS NULL)),
  FOREIGN KEY (organisation_id,call_id) REFERENCES gateway_calls(organisation_id,id) ON DELETE CASCADE,
  FOREIGN KEY (organisation_id,consultation_call_id) REFERENCES gateway_calls(organisation_id,id) ON DELETE CASCADE,
  FOREIGN KEY (organisation_id,device_id) REFERENCES devices(organisation_id,id) ON DELETE CASCADE,
  FOREIGN KEY (organisation_id,configuration_id) REFERENCES sip_configurations(organisation_id,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX gateway_transfers_pending_call ON gateway_transfers(call_id) WHERE state='pending';
CREATE INDEX gateway_transfers_pending_consultation ON gateway_transfers(consultation_call_id) WHERE state='pending';

ALTER TABLE gateway_calls ADD COLUMN transferred_at timestamptz;
ALTER TABLE gateway_calls ADD COLUMN transferred_into uuid;
ALTER TABLE gateway_calls ADD FOREIGN KEY (organisation_id,transferred_into)
  REFERENCES gateway_calls(organisation_id,id) ON DELETE SET NULL (transferred_into);
