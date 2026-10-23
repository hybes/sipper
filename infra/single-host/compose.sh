#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
exec docker compose --env-file "${SIPPER_DEPLOYMENT_ENV:-/etc/sipper/deployment.env}" \
  -f "$root/infra/compose.app.yml" -f "$root/infra/compose.meetings.yml" \
  -f "$root/infra/compose.gateway.yml" -f "$root/infra/compose.single-host.yml" "$@"
