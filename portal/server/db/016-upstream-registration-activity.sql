-- A latest observation belongs to the exact configuration and controller lease.
-- No upstream address, SIP response text, authentication fields or headers.
CREATE TABLE gateway_upstream_registrations (
  gateway_id text NOT NULL REFERENCES gateway_nodes(id) ON DELETE CASCADE,
  configuration_id uuid NOT NULL REFERENCES sip_configurations(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  state text NOT NULL CHECK (state IN ('registered','unregistered','failed')),
  observed_at timestamptz NOT NULL,
  controller_instance uuid NOT NULL,
  PRIMARY KEY (gateway_id, configuration_id)
);
