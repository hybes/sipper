-- A recovered controller must collect new observations, even if its identity
-- survives the outage. Legacy observations remain historical until refreshed.
ALTER TABLE gateway_nodes ADD COLUMN registration_generation uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE gateway_credentials ADD COLUMN registration_generation uuid;
ALTER TABLE gateway_upstream_registrations ADD COLUMN registration_generation uuid;
