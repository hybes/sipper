#!/usr/bin/env bash
set -euo pipefail
umask 077
: "${PGHOST:?Set PGHOST}" "${PGDATABASE:?Set PGDATABASE}" "${PGUSER:?Set PGUSER}"
: "${SIPPER_BACKUP_RECIPIENTS:?Mount the age public recipients file}"
: "${SIPPER_BACKUP_OUTPUT:?Set the destination .dump.age path}"
export PGSSLMODE="${PGSSLMODE:-verify-full}"
export PGCONNECT_TIMEOUT="${PGCONNECT_TIMEOUT:-10}"
[[ "$SIPPER_BACKUP_OUTPUT" == *.dump.age && ! -e "$SIPPER_BACKUP_OUTPUT" ]] || { echo 'Use a new .dump.age destination.' >&2; exit 1; }
[[ -s "$SIPPER_BACKUP_RECIPIENTS" ]] || { echo 'The recipients file is missing or empty.' >&2; exit 1; }
partial=$(mktemp "$(dirname "$SIPPER_BACKUP_OUTPUT")/.sipper-backup.XXXXXX")
trap 'rm -f -- "$partial"' EXIT
# Only ciphertext reaches disk. pipefail prevents a failed dump being published
# as a successful backup. The recovery identity is not needed on this host.
pg_dump --format=custom --no-password | age --encrypt --recipients-file "$SIPPER_BACKUP_RECIPIENTS" > "$partial"
# Hard-link publication is atomic and refuses to overwrite an existing file.
ln -- "$partial" "$SIPPER_BACKUP_OUTPUT"
echo 'Encrypted database backup completed.'
