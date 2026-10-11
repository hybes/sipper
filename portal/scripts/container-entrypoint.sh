#!/bin/sh
set -eu
case "${1:-}" in
  migrate) exec node --import tsx scripts/migrate.ts ;;
  portal|email|push|meeting) node --import tsx scripts/preflight.ts ;;
  *) echo 'Choose portal, email, push, meeting or migrate.' >&2; exit 64 ;;
esac
case "$1" in
  portal) exec node .output/server/index.mjs ;;
  email) exec node --import tsx scripts/worker.ts ;;
  push) exec node --import tsx scripts/push-worker.ts ;;
  meeting) exec node --import tsx scripts/meeting-worker.ts ;;
esac
