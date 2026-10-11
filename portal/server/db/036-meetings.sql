CREATE TABLE meetings (
  id uuid PRIMARY KEY,
  organisation_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  media_room text NOT NULL UNIQUE,
  created_by text REFERENCES auth_user(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',
  ended_at timestamptz,
  control_confirmed_at timestamptz,
  UNIQUE (organisation_id,id),
  FOREIGN KEY (organisation_id,conversation_id) REFERENCES conversations(organisation_id,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX meeting_open_conversation ON meetings (conversation_id) WHERE ended_at IS NULL;
CREATE TABLE meeting_exclusions (
  meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  PRIMARY KEY (meeting_id,user_id)
);
CREATE TABLE meeting_sessions (
  id uuid PRIMARY KEY,
  organisation_id uuid NOT NULL,
  meeting_id uuid NOT NULL,
  media_room text NOT NULL,
  user_id text NOT NULL,
  device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  auth_session_id text REFERENCES auth_session(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  admitted_at timestamptz,
  control_confirmed_at timestamptz,
  FOREIGN KEY (organisation_id,meeting_id) REFERENCES meetings(organisation_id,id) ON DELETE CASCADE
);
CREATE INDEX meeting_sessions_live ON meeting_sessions (meeting_id) WHERE revoked_at IS NULL;

-- Queue opaque media identities, never SIP credentials or join tokens. These
-- triggers cover API, SCIM, billing and cascading account deletion paths alike.
CREATE FUNCTION meeting_session_withdrawn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF (OLD.device_id IS NOT NULL AND NEW.device_id IS NULL) OR NEW.auth_session_id IS NULL THEN NEW.revoked_at=coalesce(NEW.revoked_at,clock_timestamp()); END IF;
  END IF;
  IF TG_OP='DELETE' OR (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL) THEN
    INSERT INTO jobs(kind,deduplication_key,payload) VALUES('meeting_control','meeting_remove:'||OLD.id::text,
      jsonb_build_object('action','remove','room',OLD.media_room,'sessionId',OLD.id)) ON CONFLICT(deduplication_key) DO NOTHING;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER meeting_session_withdrawn BEFORE UPDATE OR DELETE ON meeting_sessions FOR EACH ROW EXECUTE FUNCTION meeting_session_withdrawn();
CREATE FUNCTION meeting_conversation_member_removed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE meeting_sessions s SET revoked_at=clock_timestamp() FROM meetings m WHERE s.meeting_id=m.id
    AND m.conversation_id=OLD.conversation_id AND s.user_id=OLD.user_id AND s.revoked_at IS NULL;
  RETURN OLD;
END;
$$;
CREATE TRIGGER meeting_conversation_member_removed BEFORE DELETE ON conversation_members FOR EACH ROW EXECUTE FUNCTION meeting_conversation_member_removed();
CREATE FUNCTION meeting_device_withdrawn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
    UPDATE meeting_sessions SET revoked_at=clock_timestamp() WHERE device_id=OLD.id AND revoked_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER meeting_device_withdrawn AFTER UPDATE OF revoked_at ON devices FOR EACH ROW EXECUTE FUNCTION meeting_device_withdrawn();
CREATE FUNCTION meeting_member_suspended() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status='active' AND NEW.status<>'active' THEN
    UPDATE meeting_sessions SET revoked_at=clock_timestamp() WHERE organisation_id=OLD.organisation_id AND user_id=OLD.user_id AND revoked_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER meeting_member_suspended AFTER UPDATE OF status ON organisation_members FOR EACH ROW EXECUTE FUNCTION meeting_member_suspended();
CREATE FUNCTION meeting_seat_released() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE meeting_sessions s SET revoked_at=clock_timestamp() FROM organisations o WHERE s.organisation_id=o.id
    AND o.workspace_id=OLD.workspace_id AND s.user_id=OLD.user_id AND s.revoked_at IS NULL;
  RETURN OLD;
END;
$$;
CREATE TRIGGER meeting_seat_released BEFORE DELETE ON seat_assignments FOR EACH ROW EXECUTE FUNCTION meeting_seat_released();
CREATE FUNCTION meeting_ended() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (OLD.ended_at IS NULL AND NEW.ended_at IS NOT NULL) THEN
    INSERT INTO jobs(kind,deduplication_key,payload) VALUES('meeting_control','meeting_end:'||OLD.id::text,
      jsonb_build_object('action','end','room',OLD.media_room,'meetingId',OLD.id)) ON CONFLICT(deduplication_key) DO NOTHING;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER meeting_ended BEFORE UPDATE OR DELETE ON meetings FOR EACH ROW EXECUTE FUNCTION meeting_ended();
ALTER TABLE worker_progress DROP CONSTRAINT worker_progress_kind_check;
ALTER TABLE worker_progress ADD CHECK (kind IN ('email','push','meeting'));
