#!/usr/bin/env bash
set -euo pipefail
umask 077
: "${PGHOST:?Set PGHOST}" "${PGDATABASE:?Set PGDATABASE}" "${PGUSER:?Set PGUSER}"
: "${SIPPER_RESTORE_DATABASE:?Explicitly name the restored database}"
export PGSSLMODE="${PGSSLMODE:-verify-full}"
export PGCONNECT_TIMEOUT="${PGCONNECT_TIMEOUT:-10}"
[[ "${1:-}" == --reconciled && $# == 1 && "$SIPPER_RESTORE_DATABASE" == "$PGDATABASE" && "$PGDATABASE" != postgres && "$PGDATABASE" != template* ]] || {
  echo 'Reconcile the isolated restore, fence former services, then pass --reconciled with matching restore/database names.' >&2; exit 1;
}
psql --no-password -X -q -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
SET LOCAL search_path=pg_catalog,public;
DO $$
BEGIN
  PERFORM 1 FROM service_recovery WHERE singleton FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM service_recovery WHERE restored_at IS NOT NULL AND released_at IS NULL) THEN
    RAISE EXCEPTION 'The database is not under recovery hold';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()) THEN
    RAISE EXCEPTION 'Disconnect other processes before releasing recovery hold';
  END IF;
  IF EXISTS (SELECT 1 FROM auth_session) OR EXISTS (SELECT 1 FROM jobs WHERE completed_at IS NULL)
    OR EXISTS (SELECT 1 FROM gateway_nodes WHERE ready_until>now() OR controller_instance IS NOT NULL)
    OR EXISTS (SELECT 1 FROM gateway_credentials) OR EXISTS (SELECT 1 FROM push_endpoints)
    OR EXISTS (SELECT 1 FROM message_push_endpoints)
    OR EXISTS (SELECT 1 FROM meetings WHERE ended_at IS NULL)
    OR EXISTS (SELECT 1 FROM meeting_sessions WHERE revoked_at IS NULL) THEN
    RAISE EXCEPTION 'Restored sessions, queue or gateway state is not quarantined';
  END IF;
END $$;
-- --reconciled attests that former media processes are stopped/fenced. This
-- closes only snapshot calls whose real outcome is unknown after cold recovery.
UPDATE gateway_calls SET state='ended',end_reason='failed',caller_envelope=NULL,
  claim_until=NULL,updated_at=now(),version=version+1 WHERE state<>'ended';
INSERT INTO audit_events(action,details) VALUES ('service.restore_released',
  jsonb_build_object('databaseRole',current_user,'coldRecovery',true));
UPDATE service_recovery SET released_at=now() WHERE singleton;
COMMIT;
SQL
echo 'Recovery hold released. Start the checked application and fresh gateway processes; users must sign in again.'
