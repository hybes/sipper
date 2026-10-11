ALTER TABLE organisation_members DROP CONSTRAINT organisation_members_status_check;
ALTER TABLE organisation_members ADD CONSTRAINT organisation_members_status_check CHECK (status IN ('active','suspended','removed'));
ALTER TABLE organisation_members ADD COLUMN removed_at timestamptz;

-- Keep the membership and revoked devices so established calls, audit references and
-- diagnostic history survive removal. A new invitation is needed to join again.
CREATE INDEX membership_status ON organisation_members (organisation_id,status);
