#!/usr/bin/env bash
set -euo pipefail
umask 077
: "${PGHOST:?Set PGHOST}" "${PGDATABASE:?Set PGDATABASE}" "${PGUSER:?Set PGUSER}"
: "${SIPPER_RESTORE_DATABASE:?Explicitly name the empty target database}"
: "${SIPPER_RESTORE_IDENTITY:?Mount the private age recovery identity}"
: "${SIPPER_RESTORE_INPUT:?Set the source .dump.age path}"
export PGSSLMODE="${PGSSLMODE:-verify-full}"
export PGCONNECT_TIMEOUT="${PGCONNECT_TIMEOUT:-10}"
[[ "$SIPPER_RESTORE_DATABASE" == "$PGDATABASE" && "$PGDATABASE" != postgres && "$PGDATABASE" != template* ]] || { echo 'The explicit restore target must match a dedicated empty database.' >&2; exit 1; }
[[ "$SIPPER_RESTORE_INPUT" == *.dump.age && -s "$SIPPER_RESTORE_INPUT" ]] || { echo 'A non-empty .dump.age archive is required.' >&2; exit 1; }
# Never decrypt to an ordinary volume. Authenticate the entire archive before
# executing SQL, including the final age stream tag; discard it on any failure.
[[ "$(stat -f -c %T /restore)" == tmpfs ]] || { echo 'Mount /restore as a sufficiently large private tmpfs.' >&2; exit 1; }
archive=$(mktemp /restore/sipper-restore.XXXXXX)
trap 'rm -f -- "$archive"' EXIT
age --decrypt --identity "$SIPPER_RESTORE_IDENTITY" "$SIPPER_RESTORE_INPUT" > "$archive"
objects=$(psql --no-password -X -A -t -v ON_ERROR_STOP=1 -c "SELECT
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema') +
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema')")
[[ "$objects" == 0 ]] || { echo 'Restore refused: target database contains objects.' >&2; exit 1; }
# Restore into a new database owned by its application role. Never drop/clean a
# populated database or silently import source-cluster roles and permissions.
# COMMIT is emitted only after both stages succeed. If pg_restore fails, psql
# disconnects with an open transaction and PostgreSQL rolls it back. On success
# the hold and restored data become visible together, never an unheld snapshot.
{
  echo 'BEGIN;'
  pg_restore --exit-on-error --no-owner --no-privileges --file=- "$archive"
  cat /usr/local/share/sipper/recovery-reset.sql
  echo 'COMMIT;'
} | psql --no-password -X -q -v ON_ERROR_STOP=1
echo 'Database restored under recovery hold. Reconcile access and billing before database-release.sh --reconciled.'
