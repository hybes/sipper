CREATE TABLE setup_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  user_id text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  created_by text REFERENCES auth_user(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz,
  FOREIGN KEY (organisation_id,user_id) REFERENCES organisation_members(organisation_id,user_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX one_pending_setup_link ON setup_links(organisation_id,user_id) WHERE used_at IS NULL AND revoked_at IS NULL;
