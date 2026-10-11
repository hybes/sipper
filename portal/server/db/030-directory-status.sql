ALTER TABLE organisation_members ADD COLUMN share_status boolean NOT NULL DEFAULT false;
ALTER TABLE directory_contacts ADD COLUMN member_user_id text,
  ADD CONSTRAINT directory_contact_member FOREIGN KEY (organisation_id,member_user_id)
    REFERENCES organisation_members(organisation_id,user_id) ON DELETE SET NULL (member_user_id);
