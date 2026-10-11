CREATE TABLE conversations (
  id uuid PRIMARY KEY,
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('direct','group')),
  title text NOT NULL DEFAULT '' CHECK (length(title)<=160),
  direct_key text,
  created_by text REFERENCES auth_user(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_sequence bigint NOT NULL DEFAULT 0 CHECK (last_sequence>=0),
  UNIQUE (organisation_id,id),
  UNIQUE (organisation_id,direct_key),
  CHECK ((kind='direct' AND direct_key IS NOT NULL AND title='') OR (kind='group' AND direct_key IS NULL AND length(title)>0))
);
CREATE TABLE conversation_members (
  organisation_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  user_id text NOT NULL,
  last_read_sequence bigint NOT NULL DEFAULT 0 CHECK (last_read_sequence>=0),
  PRIMARY KEY (conversation_id,user_id),
  FOREIGN KEY (organisation_id,conversation_id) REFERENCES conversations(organisation_id,id) ON DELETE CASCADE,
  FOREIGN KEY (organisation_id,user_id) REFERENCES organisation_members(organisation_id,user_id) ON DELETE CASCADE
);
CREATE INDEX conversation_members_user ON conversation_members (organisation_id,user_id,conversation_id);
CREATE TABLE text_messages (
  id uuid PRIMARY KEY,
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  organisation_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  sender_id text REFERENCES auth_user(id) ON DELETE SET NULL,
  envelope jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organisation_id,conversation_id) REFERENCES conversations(organisation_id,id) ON DELETE CASCADE
);
CREATE INDEX text_messages_conversation ON text_messages (conversation_id,sequence DESC);
CREATE INDEX text_messages_retention ON text_messages (created_at);
