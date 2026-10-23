#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
deployment="${SIPPER_DEPLOYMENT_ENV:-/etc/sipper/deployment.env}"
# Read only this simple selector; never source an environment file as shell code.
mode=$(sed -n 's/^SIPPER_DEPLOYMENT_MODE=//p' "$deployment")
case "$mode" in
  ''|standalone) ;;
  shared) set -- -f "$root/infra/compose.shared-host.yml" "$@" ;;
  *) printf '%s\n' 'Unknown Sipper deployment mode.' >&2; exit 1 ;;
esac
exec docker compose --env-file "$deployment" \
  -f "$root/infra/compose.app.yml" -f "$root/infra/compose.meetings.yml" \
  -f "$root/infra/compose.gateway.yml" -f "$root/infra/compose.single-host.yml" "$@"
