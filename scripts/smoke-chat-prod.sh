#!/usr/bin/env bash
# Run the chat smoke check (scripts/smoke-chat.mjs) against a live deployment.
#
# Chat is the one surface where a green build proves almost nothing: #1361 and #1363 both shipped
# clean CI and a 200 from /api/chat/turn while the assistant could not reach a single tool. Run
# this after every deploy that touches chat, the permission hook, the CLI runner, or any module's
# assistant tools.
#
#   scripts/smoke-chat-prod.sh you@example.com
#
# CREDENTIAL HANDLING. The check needs an authenticated session, so this mints one — a row in
# app.auth_sessions, whose id IS the bearer token (migration 0046). Three rules follow from that:
#
#   1. It lives for ten minutes and is revoked on exit, including on failure, Ctrl-C, and error.
#      The trap is installed before the row is created, so there is no window where a leak can
#      outlive the script.
#   2. It is never printed, never passed as an argument (arguments are visible in `ps`), and never
#      written to the host. It goes into the container through an environment variable set on the
#      exec itself.
#   3. It belongs to a real user and can read that user's private data. Mint it for an account you
#      own; never for someone else's.
#
# The check runs INSIDE the app container against 127.0.0.1, so it exercises the same loopback the
# app itself uses and needs no TLS trust, no published port, and no host network access. It talks
# to its own chat surface ("smoke"), so probe turns land in a transcript of their own instead of
# the user's real drawer conversation.
set -euo pipefail

USER_EMAIL="${1:-${JARVIS_SMOKE_USER_EMAIL:-}}"
APP_CONTAINER="${JARVIS_SMOKE_APP_CONTAINER:-jarv1s-prod-jarv1s-1}"
DB_CONTAINER="${JARVIS_SMOKE_DB_CONTAINER:-moss-postgres}"
DB_NAME="${JARVIS_SMOKE_DB_NAME:-jarv1s}"
APP_URL="${JARVIS_SMOKE_BASE_URL:-http://127.0.0.1:3000}"

if [ -z "$USER_EMAIL" ]; then
  echo "usage: $0 <user-email>    (or set JARVIS_SMOKE_USER_EMAIL)" >&2
  exit 2
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Render a value as a SQL literal. standard_conforming_strings is on by default, so doubling the
# quote is the whole job. (Do NOT reach for psql's $$ dollar-quoting from bash: inside a
# double-quoted string `$$` expands to the shell's PID long before psql sees it.)
sql_lit() { printf "'%s'" "${1//\'/\'\'}"; }

# Statements go in on STDIN, never as an argument. `docker exec` arguments are visible to every
# process on the host via `ps`, and one of the statements below carries a live session token.
psql_q() { docker exec -i "$DB_CONTAINER" psql -U postgres -d "$DB_NAME" -tAq -v ON_ERROR_STOP=1 -f -; }

user_id="$(printf 'SELECT id FROM app.users WHERE email = %s;' "$(sql_lit "$USER_EMAIL")" | psql_q)"
if [ -z "$user_id" ]; then
  echo "no user with email ${USER_EMAIL} in ${DB_CONTAINER}/${DB_NAME}" >&2
  exit 2
fi

# Generate the token here rather than reading back a DB-side gen_random_uuid(): the value then
# never appears in a query result, a psql echo, or the server log.
token="$(cat /proc/sys/kernel/random/uuid)"

# A FRESH surface per run, unless the caller named one. Surfaces are separate conversations, and a
# live session replays its surface's prior turns into the new one — so a reused surface means each
# run is primed by the last, and the model may call a tool because it did so before rather than
# because it can. That biases the check toward passing, which is the one direction a smoke test must
# never lean. A surface nobody has spoken on is a genuinely cold session every time.
surface="${JARVIS_SMOKE_SURFACE:-smoke-$(tr -d - </proc/sys/kernel/random/uuid | cut -c1-8)}"

# Installed BEFORE the insert so an interrupt between the two still cleans up. Revocation is
# addressed by id, so it can never remove a session the script did not create.
cleanup() {
  printf 'DELETE FROM app.auth_sessions WHERE id = %s;' "$(sql_lit "$token")" |
    psql_q >/dev/null 2>&1 || true
  # Drop the throwaway conversation too, so a check that runs on every deploy does not slowly fill
  # the user's account with probe threads (chat_messages cascades from chat_threads). Only ever a
  # surface THIS script generated: the name pattern is the guard, so a caller-named surface — and
  # above all `drawer` — is never touched.
  case "$surface" in
    smoke-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f])
      printf 'DELETE FROM app.chat_threads WHERE owner_user_id = %s AND surface = %s;' \
        "$(sql_lit "$user_id")" "$(sql_lit "$surface")" | psql_q >/dev/null 2>&1 || true
      ;;
  esac
}
trap cleanup EXIT INT TERM

printf 'INSERT INTO app.auth_sessions (id, user_id, expires_at) VALUES (%s, %s, now() + interval %s);' \
  "$(sql_lit "$token")" "$(sql_lit "$user_id")" "$(sql_lit '10 minutes')" | psql_q >/dev/null

docker cp "${script_dir}/smoke-chat.mjs" "${APP_CONTAINER}:/tmp/smoke-chat.mjs" >/dev/null

echo "running chat smoke check as ${USER_EMAIL} against ${APP_URL} in ${APP_CONTAINER} (surface ${surface})"
set +e
docker exec \
  -e JARVIS_SMOKE_BASE_URL="$APP_URL" \
  -e JARVIS_SMOKE_TOKEN="$token" \
  -e JARVIS_SMOKE_SURFACE="$surface" \
  -e JARVIS_SMOKE_TIMEOUT_MS="${JARVIS_SMOKE_TIMEOUT_MS:-180000}" \
  "$APP_CONTAINER" node /tmp/smoke-chat.mjs
status=$?
set -e

docker exec "$APP_CONTAINER" rm -f /tmp/smoke-chat.mjs >/dev/null 2>&1 || true
exit "$status"
