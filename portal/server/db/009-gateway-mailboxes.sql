-- Asterisk probes both endpoint and AOR mailbox fields during startup. These
-- devices have no gateway MWI subscription yet; expose empty fields explicitly.
CREATE OR REPLACE VIEW gateway_ps_endpoints AS
SELECT username AS id,'sipper-tls'::text AS transport,username AS aors,username AS auth,
  'sipper-devices'::text AS context,'all'::text AS disallow,'opus,g722,ulaw,alaw'::text AS allow,
  'no'::text AS direct_media,'yes'::text AS rtp_symmetric,'yes'::text AS force_rport,
  'yes'::text AS rewrite_contact,'sdes'::text AS media_encryption,
  'no'::text AS allow_subscribe,'no'::text AS allow_transfer,
  'username,auth_username'::text AS identify_by,''::text AS mailboxes
FROM active_gateway_credentials;

CREATE OR REPLACE VIEW gateway_ps_aors AS
SELECT username AS id,1::integer AS max_contacts,'yes'::text AS remove_existing,
  60::integer AS minimum_expiration,600::integer AS maximum_expiration,
  300::integer AS default_expiration,0::integer AS qualify_frequency,''::text AS mailboxes
FROM active_gateway_credentials;
