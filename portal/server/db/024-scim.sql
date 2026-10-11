CREATE TABLE scim_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL UNIQUE REFERENCES organisations(id) ON DELETE CASCADE,
  token_hash text,
  token_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  rotated_at timestamptz,
  last_request_at timestamptz,
  request_window_at timestamptz NOT NULL DEFAULT now(),
  request_count integer NOT NULL DEFAULT 0,
  UNIQUE (organisation_id,id)
);
CREATE TABLE scim_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  user_id text REFERENCES auth_user(id) ON DELETE SET NULL,
  email text NOT NULL CHECK (email=lower(email)),
  external_id text,
  profile jsonb NOT NULL,
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  removed_membership boolean NOT NULL DEFAULT false,
  UNIQUE (organisation_id,id),
  FOREIGN KEY (organisation_id,connection_id) REFERENCES scim_connections(organisation_id,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX scim_user_email ON scim_users (organisation_id,email) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX scim_user_external ON scim_users (connection_id,external_id) WHERE deleted_at IS NULL AND external_id IS NOT NULL;
CREATE UNIQUE INDEX scim_user_identity ON scim_users (organisation_id,user_id) WHERE deleted_at IS NULL AND user_id IS NOT NULL;
CREATE INDEX scim_pending_email ON scim_users (email,organisation_id) WHERE user_id IS NULL AND active=true AND deleted_at IS NULL;
ALTER TABLE organisation_members ADD COLUMN scim_user_id uuid;
ALTER TABLE organisation_members ADD CONSTRAINT member_scim_customer FOREIGN KEY(organisation_id,scim_user_id) REFERENCES scim_users(organisation_id,id);
CREATE TABLE scim_groups (
  id uuid PRIMARY KEY,
  organisation_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  external_id text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id,id),
  UNIQUE (connection_id,external_id),
  FOREIGN KEY (organisation_id,id) REFERENCES groups(organisation_id,id) ON DELETE CASCADE,
  FOREIGN KEY (organisation_id,connection_id) REFERENCES scim_connections(organisation_id,id) ON DELETE CASCADE
);
CREATE TABLE scim_group_members (
  organisation_id uuid NOT NULL,
  group_id uuid NOT NULL,
  scim_user_id uuid NOT NULL,
  PRIMARY KEY (group_id,scim_user_id),
  FOREIGN KEY (organisation_id,group_id) REFERENCES scim_groups(organisation_id,id) ON DELETE CASCADE,
  FOREIGN KEY (organisation_id,scim_user_id) REFERENCES scim_users(organisation_id,id) ON DELETE CASCADE
);

-- Manual customer controls remain available. Reflect their effective state and
-- invalidate SCIM versions without allowing a connector to regain removed access.
CREATE FUNCTION update_scim_membership_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.scim_user_id IS NOT NULL AND (NEW.status,NEW.role,NEW.scim_user_id) IS DISTINCT FROM (OLD.status,OLD.role,OLD.scim_user_id) THEN
    UPDATE scim_users SET active=COALESCE(NEW.status='active' AND NEW.scim_user_id=OLD.scim_user_id,false),version=version+1,updated_at=now()
      WHERE id=OLD.scim_user_id AND deleted_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER scim_membership_changed AFTER UPDATE OF status,role,scim_user_id ON organisation_members
FOR EACH ROW EXECUTE FUNCTION update_scim_membership_version();
