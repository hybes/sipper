ALTER TABLE organisation_members
  ADD COLUMN do_not_disturb boolean NOT NULL DEFAULT false,
  ADD COLUMN calling_preference_updated_at timestamptz;
