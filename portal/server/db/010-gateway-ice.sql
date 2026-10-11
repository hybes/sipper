-- Managed clients offer ICE. Enable it on the device endpoint as well as RTP,
-- so a NATed/dual-stack client can select a reachable media candidate.
CREATE OR REPLACE VIEW gateway_ps_endpoints AS
SELECT username AS id,'sipper-tls'::text AS transport,username AS aors,username AS auth,
  'sipper-devices'::text AS context,'all'::text AS disallow,'opus,g722,ulaw,alaw'::text AS allow,
  'no'::text AS direct_media,'yes'::text AS rtp_symmetric,'yes'::text AS force_rport,
  'yes'::text AS rewrite_contact,'sdes'::text AS media_encryption,
  'no'::text AS allow_subscribe,'no'::text AS allow_transfer,
  'username,auth_username'::text AS identify_by,''::text AS mailboxes,
  'yes'::text AS ice_support
FROM active_gateway_credentials;
