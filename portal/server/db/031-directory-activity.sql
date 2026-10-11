-- Manual status consent does not authorise sharing observed call activity.
ALTER TABLE organisation_members ADD COLUMN share_activity boolean NOT NULL DEFAULT false;
