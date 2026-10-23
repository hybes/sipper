-- Run after migrations, connected to the sipper database as sipper_admin.
-- The gateway reads only the views that enforce current managed entitlements.
BEGIN;
GRANT CONNECT ON DATABASE sipper TO sipper_gateway;
GRANT USAGE ON SCHEMA public TO sipper_gateway;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM sipper_gateway;
GRANT SELECT ON gateway_ps_endpoints, gateway_ps_auths, gateway_ps_aors TO sipper_gateway;
COMMIT;
