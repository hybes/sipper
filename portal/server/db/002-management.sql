CREATE TABLE group_configurations (
  organisation_id uuid NOT NULL,
  group_id uuid NOT NULL,
  configuration_id uuid NOT NULL,
  PRIMARY KEY (group_id, configuration_id),
  FOREIGN KEY (organisation_id, group_id) REFERENCES groups(organisation_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organisation_id, configuration_id) REFERENCES sip_configurations(organisation_id, id) ON DELETE CASCADE
);
CREATE INDEX jobs_available ON jobs(available_at) WHERE completed_at IS NULL;
CREATE INDEX device_organisation ON devices(organisation_id);
CREATE INDEX memberships_user ON organisation_members(user_id);

-- Enabling MFA must invalidate sessions issued before the second factor was proved.
-- Better Auth creates a fresh session after completing the factor transition.
CREATE FUNCTION invalidate_sessions_on_factor_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."twoFactorEnabled" IS DISTINCT FROM OLD."twoFactorEnabled" THEN
    DELETE FROM auth_session WHERE "userId"=NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER factor_change AFTER UPDATE OF "twoFactorEnabled" ON auth_user
FOR EACH ROW EXECUTE FUNCTION invalidate_sessions_on_factor_change();
