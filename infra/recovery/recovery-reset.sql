-- Cold database recovery only. All former application, worker and gateway
-- processes must remain fenced. Do not use this on a running service.
-- Keep durable customer/configuration/history data, discard snapshot authority
-- and observations that cannot establish what happened after the backup.
-- pg_restore's SQL leaves search_path empty; use our explicit application schema.
SET LOCAL search_path=pg_catalog,public;
INSERT INTO service_recovery(singleton,restored_at,released_at) VALUES (true,now(),NULL)
  ON CONFLICT(singleton) DO UPDATE SET restored_at=EXCLUDED.restored_at,released_at=NULL;
DELETE FROM "oauthAccessToken";
DELETE FROM "oauthRefreshToken";
DELETE FROM auth_session;
DELETE FROM auth_verification;
UPDATE invitations SET revoked_at=now() WHERE accepted_at IS NULL AND revoked_at IS NULL;
UPDATE workspace_invitations SET revoked_at=now() WHERE accepted_at IS NULL AND revoked_at IS NULL;
UPDATE setup_links SET revoked_at=now() WHERE used_at IS NULL AND revoked_at IS NULL;
UPDATE scim_connections SET token_hash=NULL,token_expires_at=NULL;
DELETE FROM push_endpoints;
DELETE FROM message_push_endpoints;
DELETE FROM gateway_credentials;
DELETE FROM gateway_upstream_registrations;
UPDATE gateway_nodes SET ready_until=now(),controller_instance=NULL,controller_expires_at=NULL,
  last_heartbeat_at=NULL,registration_generation=gen_random_uuid();
UPDATE devices SET applied_revision=NULL,status='{}';
DELETE FROM worker_progress;
-- Former SFU/signalling processes must be fenced too. Snapshot rooms cannot
-- retain join authority or be resumed after a cold database restore.
UPDATE meetings SET ended_at=coalesce(ended_at,now()),control_confirmed_at=NULL;
-- Stop replay of old invitations, password resets and push hints. Preserve the
-- job reference/outcome but erase payloads; completed historical jobs stay intact.
UPDATE jobs SET completed_at=now(),locked_until=NULL,lease_id=NULL,payload='{}',last_error='recovery_cancelled'
  WHERE completed_at IS NULL;
INSERT INTO audit_events(action,details) VALUES ('service.restore_quarantined',
  jsonb_build_object('databaseRole',current_user,'sessionsCleared',true,'pendingJobsCancelled',true));
