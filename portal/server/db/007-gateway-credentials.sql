-- Readiness is a short lease from the calling service, never inferred from configuration.
CREATE TABLE gateway_nodes (
  id text PRIMARY KEY,
  host text NOT NULL,
  port integer NOT NULL CHECK (port BETWEEN 1 AND 65535),
  ready_until timestamptz NOT NULL
);
CREATE TABLE gateway_credentials (
  id uuid PRIMARY KEY,
  gateway_id text NOT NULL REFERENCES gateway_nodes(id),
  organisation_id uuid NOT NULL,
  device_id uuid NOT NULL,
  configuration_id uuid NOT NULL,
  username text NOT NULL UNIQUE,
  realm text NOT NULL,
  secret_envelope jsonb NOT NULL,
  password_digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (device_id, configuration_id),
  FOREIGN KEY (organisation_id, device_id) REFERENCES devices(organisation_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organisation_id, configuration_id) REFERENCES sip_configurations(organisation_id, id) ON DELETE CASCADE
);

-- Asterisk reads these on each new transaction. Do not add a sorcery memory cache:
-- a stored contact, known credential or old readiness lease is not current authority.
CREATE VIEW active_gateway_credentials AS
SELECT g.id,g.gateway_id,g.device_id,g.configuration_id,g.username,g.realm,g.password_digest
FROM gateway_credentials g
JOIN gateway_nodes n ON n.id=g.gateway_id AND n.host=g.realm AND n.ready_until>now()
JOIN eligible_gateway_devices e ON e.device_id=g.device_id AND e.configuration_id=g.configuration_id;

CREATE VIEW gateway_ps_endpoints AS
SELECT username AS id,'sipper-tls'::text AS transport,username AS aors,username AS auth,
  'sipper-devices'::text AS context,'all'::text AS disallow,'opus,g722,ulaw,alaw'::text AS allow,
  'no'::text AS direct_media,'yes'::text AS rtp_symmetric,'yes'::text AS force_rport,
  'yes'::text AS rewrite_contact,'sdes'::text AS media_encryption,
  'no'::text AS allow_subscribe,'no'::text AS allow_transfer,
  'username,auth_username'::text AS identify_by
FROM active_gateway_credentials;

CREATE VIEW gateway_ps_auths AS
SELECT username AS id,'digest'::text AS auth_type,username,realm,password_digest,
  'sha-256'::text AS supported_algorithms_uas
FROM active_gateway_credentials;

CREATE VIEW gateway_ps_aors AS
SELECT username AS id,1::integer AS max_contacts,'yes'::text AS remove_existing,
  60::integer AS minimum_expiration,600::integer AS maximum_expiration,
  300::integer AS default_expiration,0::integer AS qualify_frequency
FROM active_gateway_credentials;

-- The gateway DB role receives SELECT only on these three views. Contacts stay in
-- Asterisk's own runtime store; neither upstream passwords nor portal tables are granted.
