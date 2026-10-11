ALTER TABLE jobs ADD COLUMN created_at timestamptz;
ALTER TABLE jobs ADD COLUMN last_attempt_at timestamptz;

-- Invitation creation and its email job commit in the same transaction.
-- Other legacy jobs have no reliable creation timestamp; leave those unknown.
UPDATE jobs j SET created_at=i.created_at FROM invitations i
WHERE j.kind='email' AND j.deduplication_key='invitation:'||i.id::text;
UPDATE jobs j SET created_at=i.created_at FROM workspace_invitations i
WHERE j.kind='email' AND j.deduplication_key='workspace-invitation:'||i.id::text;
ALTER TABLE jobs ALTER COLUMN created_at SET DEFAULT now();

CREATE INDEX jobs_failed_email_time ON jobs (created_at DESC NULLS LAST,id DESC)
WHERE kind='email' AND completed_at IS NULL AND attempts>=10;
