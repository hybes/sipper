-- Chat uses normal notifications, never the VoIP/CallKit token.
CREATE TABLE message_push_endpoints (
  device_id uuid PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('apns','fcm')),
  token_envelope jsonb NOT NULL,
  token_revision uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  last_push_at timestamptz,
  last_push_status text CHECK (last_push_status IN ('accepted','invalid_token','credentials','retry','rejected','not_configured'))
);
CREATE VIEW eligible_message_devices AS
SELECT d.id AS device_id,d.user_id,d.platform,d.organisation_id
FROM devices d
JOIN auth_user u ON u.id=d.user_id AND u."emailVerified"
JOIN organisation_members m ON m.organisation_id=d.organisation_id AND m.user_id=d.user_id AND m.status='active'
JOIN seat_assignments a ON a.workspace_id=m.workspace_id AND a.user_id=m.user_id
JOIN subscriptions s ON s.workspace_id=m.workspace_id
WHERE d.revoked_at IS NULL AND d.platform IN ('ios','android')
AND (s.status IN ('active','trialing') OR (s.status='past_due' AND s.grace_until>now()))
AND (s.paid_until IS NULL OR s.paid_until>now() OR s.grace_until>now())
AND (SELECT count(*) FROM seat_assignments sa WHERE sa.workspace_id=m.workspace_id)<=s.purchased_seats
AND NOT EXISTS (SELECT 1 FROM service_recovery WHERE restored_at IS NOT NULL AND released_at IS NULL);
CREATE OR REPLACE FUNCTION remove_revoked_push_token() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.revoked_at IS NOT NULL THEN
    DELETE FROM push_endpoints WHERE device_id=NEW.id;
    DELETE FROM message_push_endpoints WHERE device_id=NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
