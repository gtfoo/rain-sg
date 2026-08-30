#!/usr/bin/env bash
#
# Deploy rain-sg. Runs on the droplet as `deploy`, invoked by GitHub Actions.
#
# This app is unusual among the six: it has NO native modules, so the bundle is
# built in Actions on Node 22 and rsynced here. The droplet never runs
# `next build` and never sees its ~275MB peak — which is the reason a sixth app
# fits on a 1GB box at all. If a native module ever appears, this script must
# grow the constructing ABI guard that the others carry.
set -euo pipefail

APP_DIR=${APP_DIR:-/home/deploy/rain-sg}
SERVICE=${SERVICE:-rain}
LOCK=/var/lock/droplet-deploy.lock

log() { echo "[$(date -u +%H:%M:%S)] $*"; }

# ---------------------------------------------------------------- shared lock
# Exact path, not a variant. Mode 0666 because root (manual redeploys) and
# deploy (CI) both open it; a root-owned lock file is one CI cannot open.
if { touch "$LOCK" && chmod 0666 "$LOCK"; } 2>/dev/null || [ -w "$LOCK" ]; then
  exec 9>>"$LOCK"
  if ! flock -w 1800 9; then
    echo "!! another deploy held the lock for 30 minutes" >&2
    exit 1
  fi
  log "holding $LOCK"
else
  # Warn and proceed: failing to serialise is bad, failing to deploy is worse.
  echo "!! WARNING: cannot open $LOCK - proceeding WITHOUT serialisation" >&2
fi

cd "$APP_DIR"

# No nvm, no version pin. `nvm use` does nothing on this box but DOES fire on a
# dev machine that has nvm, pinning that build to the wrong version.
log "node $(node -v), npm $(npm -v)"

# ------------------------------------------------------- verify what CI sent
# The bundle arrives prebuilt. Check it is actually here before restarting
# anything: a missing static directory produces HTML that returns 200 with
# every asset 404ing, which is invisible to any status-code check and has
# shipped twice on this box.
[ -f .next/standalone/server.js ] || { echo "!! no standalone server.js - CI did not send a build" >&2; exit 1; }

ASSET=$(find .next/standalone/.next/static -type f 2>/dev/null | head -1)
if [ -z "$ASSET" ]; then
  echo "!! no files under .next/standalone/.next/static - refusing to call this deployed" >&2
  exit 1
fi
log "static output present: $(basename "$ASSET")"

# The model must ship with the bundle; without it every forecast 500s.
[ -f .next/standalone/src/model/model.json ] || [ -f src/model/model.json ] || {
  echo "!! model.json missing from the bundle" >&2; exit 1; }

# --------------------------------------------------------------- restart
log "restarting $SERVICE"
sudo systemctl restart "$SERVICE"

# ---------------------------------------------------------------- verify
# Status codes are not enough. Check the app answers, that it is bound to
# loopback only, and that a real asset returns 200.
for i in $(seq 1 30); do
  if curl -fsS -o /dev/null --max-time 5 "http://127.0.0.1:3004/"; then break; fi
  sleep 1
done
curl -fsS -o /dev/null --max-time 10 "http://127.0.0.1:3004/" || {
  echo "!! app did not answer on 3004"; sudo systemctl status "$SERVICE" --no-pager | tail -20; exit 1; }
log "app answering on 3004"

if ss -ltn 2>/dev/null | grep -q '0\.0\.0\.0:3004\|\[::\]:3004'; then
  echo "!! listening on all interfaces - Caddy must be the only entry point" >&2
  exit 1
fi
log "bound to loopback only"

# Prime the store so the first visitor is not served an empty forecast.
curl -fsS -o /dev/null --max-time 120 "http://127.0.0.1:3004/api/backfill?hours=2" || \
  log "warning: backfill did not complete (app is up regardless)"

log "deployed"
