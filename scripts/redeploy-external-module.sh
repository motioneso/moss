#!/usr/bin/env bash
# Rebuild an external module and get it back to enabled on a LOCAL DEV instance.
#
# Why this exists as a script rather than a list of steps in a handoff doc: the manual sequence has
# a race that is easy to lose to and hard to see. Rebuilding changes the package hash;
# `db:reconcile` then DISABLES the module on purpose (drift), and re-enabling it captures whatever
# hash the API currently holds in its boot-time discovery cache. So the API must be running the NEW
# code before the enable — and `curl /health` does NOT prove that, because during a `tsx watch`
# restart the OLD process is still listening and answers 200 quite happily. Enable against that and
# it stores the stale hash, the new process boots, sees the real on-disk hash, calls it drift, and
# the module disappears from the UI minutes later with nothing obviously wrong in any log.
#
# This waits on the LISTENING PID CHANGING, not on a health check, and then re-verifies after a
# settle delay that the module is still enabled rather than trusting the enable's own response.
#
# Dev only. It refuses to touch the production compose stack.
#
# Usage:  scripts/redeploy-external-module.sh <module-id> [api-port]
# Auth:   export JARVIS_DEV_EMAIL=... JARVIS_DEV_PASSWORD=...
#         (never hardcode these here — this file is committed)

set -euo pipefail

MODULE_ID="${1:?usage: redeploy-external-module.sh <module-id> [api-port]}"
# #1722: this used to default to 3097, which nothing listens on. The from-source dev API reads
# PORT and falls back to 3000 (apps/api/src/server.ts), so read it the same way rather than
# holding a second opinion about the port — a hardcoded guess fails as a bare connection error
# that never names the port as the cause.
API_PORT="${2:-${PORT:-3000}}"
API="http://127.0.0.1:${API_PORT}"
SETTLE_SECONDS="${SETTLE_SECONDS:-8}"
SOURCE_DIR="external-modules/${MODULE_ID}"
STAGED_DIR="data/modules/${MODULE_ID}"

if [[ ! "$MODULE_ID" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] ||
  [[ ! -d "$SOURCE_DIR" ]] || [[ ! -d "$STAGED_DIR" ]]; then
  echo "refusing: ${MODULE_ID} is not an installed external module" >&2
  exit 2
fi

# The prod API is not on this host's dev ports, but a mistyped port should stop rather than
# authenticate somewhere unexpected. 1533 is the production instance.
if [[ "$API_PORT" == "1533" ]]; then
  echo "refusing: port 1533 is the production instance" >&2
  exit 2
fi

: "${JARVIS_DEV_EMAIL:?set JARVIS_DEV_EMAIL}"
: "${JARVIS_DEV_PASSWORD:?set JARVIS_DEV_PASSWORD}"

listening_pid() {
  ss -lptnH "sport = :${API_PORT}" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2
}

echo "==> building ${MODULE_ID}"
pnpm "build:external:${MODULE_ID}"

echo "==> restaging ${MODULE_ID}"
rsync -a --delete \
  --include='/dist/***' \
  --include='/sql/***' \
  --include='/jarvis.module.json' \
  --include='/package.json' \
  --exclude='*' \
  "${SOURCE_DIR}/" "${STAGED_DIR}/"

echo "==> reconciling (expect drifted=1 — that is the rebuild disabling it, by design)"
pnpm db:reconcile

BEFORE_PID="$(listening_pid || true)"
echo "==> restarting api (pid before: ${BEFORE_PID:-none})"
touch apps/api/src/server.ts

# Wait for a DIFFERENT pid to own the port. A health check here would pass against the old process.
echo "==> waiting for the api process to actually turn over"
for _ in $(seq 1 90); do
  NOW_PID="$(listening_pid || true)"
  if [[ -n "$NOW_PID" && "$NOW_PID" != "$BEFORE_PID" ]]; then
    break
  fi
  sleep 2
done
NOW_PID="$(listening_pid || true)"
if [[ -z "$NOW_PID" || "$NOW_PID" == "$BEFORE_PID" ]]; then
  echo "api did not restart (pid still ${BEFORE_PID:-none}) — not enabling against stale discovery" >&2
  exit 1
fi
echo "==> api restarted (pid now: ${NOW_PID})"

JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT

# better-auth: the email/password route is /api/auth/sign-in/email, not /api/auth/sign-in.
curl -sf -c "$JAR" -X POST "${API}/api/auth/sign-in/email" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"${JARVIS_DEV_EMAIL}\",\"password\":\"${JARVIS_DEV_PASSWORD}\"}" \
  -o /dev/null

echo "==> enabling ${MODULE_ID}"
curl -sf -b "$JAR" -X POST "${API}/api/admin/external-modules/${MODULE_ID}" \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true}' -o /dev/null

echo "==> reloading worker"
touch apps/worker/src/worker.ts

# The enable's own 200 is not proof it stuck: the failure this script exists to prevent shows up a
# few seconds later, when a late-booting process re-checks the hash. Ask again.
echo "==> settling ${SETTLE_SECONDS}s, then re-verifying"
sleep "$SETTLE_SECONDS"

STATUS_JSON="$(curl -sf -b "$JAR" "${API}/api/admin/external-modules")"
# JSON goes through the environment, not stdin — stdin is carrying the python script itself.
STATUS_JSON="$STATUS_JSON" python3 - "$MODULE_ID" <<'PY'
import json, os, sys
module_id = sys.argv[1]
for m in json.loads(os.environ["STATUS_JSON"])["modules"]:
    if m["id"] == module_id:
        ok = m["status"] == "enabled" and m["active"] and not m["drifted"]
        print(f"{module_id}: status={m['status']} active={m['active']} drifted={m['drifted']}")
        if not ok:
            print(f"FAILED — {m.get('disabledReason') or 'not enabled'}", file=sys.stderr)
            sys.exit(1)
        print("OK — enabled and holding")
        break
else:
    print(f"{module_id} not found", file=sys.stderr)
    sys.exit(1)
PY
