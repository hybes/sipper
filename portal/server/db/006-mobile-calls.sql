-- Push tokens are encrypted like SIP secrets. Provider replies never contain raw tokens here.
CREATE TABLE push_endpoints (
  device_id uuid PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('apns', 'fcm')),
  token_envelope jsonb NOT NULL,
  token_revision uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  last_push_at timestamptz,
  last_push_status text CHECK (last_push_status IN ('accepted','invalid_token','credentials','retry','rejected','not_configured')),
  last_wake_at timestamptz
);
ALTER TABLE devices ADD CONSTRAINT devices_organisation_id_unique UNIQUE (organisation_id, id);
CREATE TABLE gateway_calls (
  id uuid PRIMARY KEY,
  gateway_id text NOT NULL,
  organisation_id uuid NOT NULL,
  configuration_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'ringing' CHECK (state IN ('ringing','answering','answered','ended')),
  end_reason text CHECK (end_reason IN ('caller_cancelled','completed','rejected','timed_out','failed')),
  caller_envelope jsonb,
  winner_device_id uuid,
  claim_until timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, id),
  FOREIGN KEY (organisation_id, configuration_id) REFERENCES sip_configurations(organisation_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organisation_id, winner_device_id) REFERENCES devices(organisation_id, id) ON DELETE SET NULL (winner_device_id)
);
CREATE TABLE call_recipients (
  organisation_id uuid NOT NULL,
  call_id uuid NOT NULL,
  device_id uuid NOT NULL,
  woken_at timestamptz,
  declined_at timestamptz,
  PRIMARY KEY (call_id, device_id),
  FOREIGN KEY (organisation_id, call_id) REFERENCES gateway_calls(organisation_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organisation_id, device_id) REFERENCES devices(organisation_id, id) ON DELETE CASCADE
);
CREATE INDEX gateway_calls_live ON gateway_calls(expires_at) WHERE state IN ('ringing','answering');

-- Every admission and queued push re-evaluates this view. A cached token or prior recipient
-- row is not a licence, assignment or revocation decision.
CREATE VIEW eligible_gateway_devices AS
SELECT d.id AS device_id,d.user_id,d.platform,d.organisation_id,c.id AS configuration_id
FROM devices d
JOIN auth_user u ON u.id=d.user_id AND u."emailVerified"=true
JOIN organisation_members m ON m.organisation_id=d.organisation_id AND m.user_id=d.user_id AND m.status='active'
JOIN seat_assignments a ON a.workspace_id=m.workspace_id AND a.user_id=m.user_id
JOIN subscriptions s ON s.workspace_id=m.workspace_id
JOIN sip_configurations c ON c.organisation_id=d.organisation_id AND c.mode='gateway'
WHERE d.revoked_at IS NULL
AND (s.status IN ('active','trialing') OR (s.status='past_due' AND s.grace_until>now()))
AND (s.paid_until IS NULL OR s.paid_until>now() OR s.grace_until>now())
AND (SELECT count(*) FROM seat_assignments sa WHERE sa.workspace_id=m.workspace_id)<=s.purchased_seats
AND (EXISTS (SELECT 1 FROM sip_assignments a WHERE a.configuration_id=c.id AND a.user_id=d.user_id)
  OR EXISTS (SELECT 1 FROM group_configurations g JOIN group_members gm ON gm.group_id=g.group_id
    WHERE g.configuration_id=c.id AND gm.user_id=d.user_id));

-- Revocation immediately removes the provider token even when no worker is running.
CREATE FUNCTION remove_revoked_push_token() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.revoked_at IS NOT NULL THEN DELETE FROM push_endpoints WHERE device_id=NEW.id; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER revoke_push_token AFTER UPDATE OF revoked_at ON devices
FOR EACH ROW EXECUTE FUNCTION remove_revoked_push_token();
