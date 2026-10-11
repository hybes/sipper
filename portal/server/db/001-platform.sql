CREATE TABLE platform_owners (
  user_id text PRIMARY KEY REFERENCES auth_user(id) ON DELETE CASCADE,
  granted_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  kind text NOT NULL CHECK (kind IN ('reseller', 'business')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'billing')),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE TABLE organisations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id)
);
CREATE TABLE organisation_members (
  workspace_id uuid NOT NULL,
  organisation_id uuid NOT NULL,
  user_id text NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('admin', 'user')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, user_id),
  FOREIGN KEY (workspace_id, organisation_id) REFERENCES organisations(workspace_id, id) ON DELETE CASCADE
);
CREATE TABLE subscriptions (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('stripe', 'test')),
  customer_id text UNIQUE,
  subscription_id text UNIQUE,
  status text NOT NULL DEFAULT 'inactive',
  purchased_seats integer NOT NULL DEFAULT 0 CHECK (purchased_seats >= 0),
  paid_until timestamptz,
  grace_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- One purchased seat is consumed once per person per billing workspace, even across customers/devices.
CREATE TABLE seat_assignments (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE TABLE groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  UNIQUE (organisation_id, id)
);
CREATE TABLE group_members (
  organisation_id uuid NOT NULL,
  group_id uuid NOT NULL,
  user_id text NOT NULL,
  PRIMARY KEY (group_id, user_id),
  FOREIGN KEY (organisation_id, group_id) REFERENCES groups(organisation_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organisation_id, user_id) REFERENCES organisation_members(organisation_id, user_id) ON DELETE CASCADE
);
CREATE TABLE invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  organisation_id uuid NOT NULL,
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'user')),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_by text NOT NULL REFERENCES auth_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, organisation_id) REFERENCES organisations(workspace_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX one_pending_invitation ON invitations (organisation_id, lower(email)) WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE TABLE sip_configurations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  label text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('direct', 'gateway')),
  settings jsonb NOT NULL,
  secret_envelope jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, id)
);
CREATE TABLE sip_assignments (
  organisation_id uuid NOT NULL,
  configuration_id uuid NOT NULL,
  user_id text NOT NULL,
  PRIMARY KEY (configuration_id, user_id),
  FOREIGN KEY (organisation_id, configuration_id) REFERENCES sip_configurations(organisation_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organisation_id, user_id) REFERENCES organisation_members(organisation_id, user_id) ON DELETE CASCADE
);
CREATE TABLE devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL,
  user_id text NOT NULL,
  installation_id uuid NOT NULL,
  name text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('macos', 'windows', 'ios', 'android')),
  app_version text NOT NULL,
  os_version text NOT NULL,
  enrolled_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  applied_revision text,
  status jsonb NOT NULL DEFAULT '{}',
  UNIQUE (organisation_id, user_id, installation_id),
  FOREIGN KEY (organisation_id, user_id) REFERENCES organisation_members(organisation_id, user_id) ON DELETE CASCADE
);
CREATE TABLE audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  organisation_id uuid REFERENCES organisations(id) ON DELETE SET NULL,
  actor_id text REFERENCES auth_user(id) ON DELETE SET NULL,
  action text NOT NULL,
  target_id text,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_workspace_time ON audit_events(workspace_id, created_at DESC);
CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  deduplication_key text UNIQUE,
  payload jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  completed_at timestamptz,
  last_error text
);
CREATE TABLE billing_events (
  provider_event_id text PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
