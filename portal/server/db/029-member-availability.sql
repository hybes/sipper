-- A person's stated availability, independent of SIP/push observations and DND.
ALTER TABLE organisation_members
  ADD COLUMN availability text NOT NULL DEFAULT 'unset'
    CHECK (availability IN ('unset','available','away','busy'));
