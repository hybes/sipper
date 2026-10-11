-- Better Auth creates auth_sso_provider before this migration. Its public
-- provider-management endpoints are deliberately not exposed by Sipper.
-- The auth adapter uses text identifiers; the platform uses UUID customer IDs.
ALTER TABLE auth_sso_provider ADD COLUMN customer_id uuid GENERATED ALWAYS AS (organisation_id::uuid) STORED REFERENCES organisations(id) ON DELETE CASCADE;
ALTER TABLE auth_sso_provider ALTER COLUMN organisation_id SET NOT NULL;
CREATE UNIQUE INDEX sso_customer_unique ON auth_sso_provider(customer_id);
CREATE UNIQUE INDEX sso_verified_domain_unique ON auth_sso_provider(domain) WHERE domain_verified=true;
ALTER TABLE auth_sso_provider ADD CHECK (NOT enabled OR domain_verified);
CREATE TABLE sso_configurations (
  id text PRIMARY KEY,
  provider_id text NOT NULL REFERENCES auth_sso_provider(id) ON DELETE CASCADE,
  envelope jsonb NOT NULL,
  UNIQUE (provider_id,id)
);
ALTER TABLE auth_sso_provider ADD CONSTRAINT sso_configuration_owner_fk
  FOREIGN KEY (id,oidc_config) REFERENCES sso_configurations(provider_id,id) DEFERRABLE INITIALLY DEFERRED;
