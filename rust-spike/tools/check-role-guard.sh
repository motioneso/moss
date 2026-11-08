#!/usr/bin/env bash
# Shows that the Rust Tasks server refuses to start on a database role that could escape row
# security, and that its own role check is what refuses. Changes roles only in the gate's own
# throwaway Postgres server.
#
#   scripts/run-gate.sh start --gate rust-spike/tools/check-role-guard.sh
#
# Exits 0 only when every step behaves as expected.
set -euo pipefail
[ "${JARVIS_GATE_RUN:-}" = "1" ] || { echo "refusing: not inside a gate run" >&2; exit 3; }
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
export PATH="$HOME/.cargo/bin:$PATH"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$root/rust-spike/target}"
work="$root/rust-spike/target/role-guard"
rm -rf "$work"
mkdir -p "$work"

container=$(docker ps --filter "publish=$MOSS_PGPORT" --format '{{.Names}}')
if [ -z "$container" ] || [ "$(wc -l <<<"$container")" -ne 1 ]; then
  echo "cannot find the gate's Postgres container" >&2
  exit 2
fi
admin() { docker exec "$container" psql -U postgres -d postgres -At -c "$1"; }

# The server as built, and a copy from git HEAD with the bypass check switched off.
(cd "$root/rust-spike" && cargo build --release --quiet -p tasks)
cp "$CARGO_TARGET_DIR/release/tasks" "$work/tasks"
src="$work/src-no-guard"
mkdir -p "$src"
git -C "$root" archive HEAD rust-spike | tar -x -C "$src"
db_rs="$src/rust-spike/safety-core/src/db.rs"
cp "$db_rs" "$db_rs.orig"
sed -i 's/if superuser || bypass {/if false \&\& (superuser || bypass) {/' "$db_rs"
if cmp -s "$db_rs" "$db_rs.orig"; then
  echo "the check removal did not apply to db.rs" >&2
  exit 2
fi
(cd "$src/rust-spike" && CARGO_TARGET_DIR="$work/target" cargo build --release --quiet -p tasks)
cp "$work/target/release/tasks" "$work/tasks-no-guard"

# The copied source is only needed for the build. Left in the tree, it trips repo-wide checks.
rm -rf "$src"

copy=moss_roleguard
port=$(devports claim js-36-roleguard)
cleanup() {
  admin 'ALTER ROLE jarvis_app_runtime NOBYPASSRLS NOSUPERUSER' >/dev/null || true
  admin "DROP DATABASE IF EXISTS $copy WITH (FORCE)" >/dev/null || true
  devports release "$port" >/dev/null 2>&1 || true
}
trap cleanup EXIT
admin "DROP DATABASE IF EXISTS $copy WITH (FORCE)" >/dev/null
admin "CREATE DATABASE $copy TEMPLATE \"$MOSS_PGDATABASE\"" >/dev/null
docker exec -i "$container" psql -U postgres -d "$copy" -q -v ON_ERROR_STOP=1 \
  < "$root/rust-spike/tasks/sql/0001_spike_job_queue.sql" >/dev/null
app="${MOSS_APP_DATABASE_URL%/*}/$copy"
worker="${MOSS_WORKER_DATABASE_URL%/*}/$copy"
auth="${MOSS_AUTH_DATABASE_URL%/*}/$copy"
migration="${MOSS_MIGRATION_DATABASE_URL%/*}/$copy"

failed=0

# step <label> <starts|refuses> <binary> <app url> <worker url> <auth url> [text the output must contain]
step() {
  local label=$1 want=$2 bin=$3 app_url=$4 worker_url=$5 auth_url=$6 needle=${7:-} rc got=refuses ok=yes
  set +e
  MOSS_APP_DATABASE_URL=$app_url MOSS_WORKER_DATABASE_URL=$worker_url \
    MOSS_AUTH_DATABASE_URL=$auth_url TASKS_SPIKE_PORT=$port \
    timeout 8 "$bin" > "$work/out" 2>&1
  rc=$?
  set -e
  if [ "$rc" -eq 124 ] && grep -q 'listening on' "$work/out"; then got=starts; fi
  [ "$got" = "$want" ] || ok=no
  if [ -n "$needle" ] && ! grep -qF -- "$needle" "$work/out"; then ok=no; fi
  printf '%s: %s (wanted %s) | %s\n' "$label" "$got" "$want" \
    "$(sed -E 's#postgres(ql)?://[^ "]*#<url>#g' "$work/out" | tail -1)"
  if [ "$ok" = no ]; then
    echo "  UNEXPECTED"
    failed=$((failed + 1))
  fi
}

step "1 normal roles" starts "$work/tasks" "$app" "$worker" "$auth" "listening on"
step "2 app connection on the migration role" refuses "$work/tasks" "$migration" "$worker" "$auth" \
  "connected as jarvis_migration_owner, expected jarvis_app_runtime"
step "3 worker connection on the app role" refuses "$work/tasks" "$app" "$app" "$auth" \
  "connected as jarvis_app_runtime, expected jarvis_worker_runtime"
step "3b sign-in connection on the app role" refuses "$work/tasks" "$app" "$worker" "$app" \
  "connected as jarvis_app_runtime, expected jarvis_auth_runtime"

admin 'ALTER ROLE jarvis_app_runtime BYPASSRLS' >/dev/null
step "4 app role can bypass row security" refuses "$work/tasks" "$app" "$worker" "$auth" \
  "role jarvis_app_runtime can bypass row-level security; refusing to start"
step "5 same, with the check switched off" starts "$work/tasks-no-guard" "$app" "$worker" "$auth" \
  "listening on"
admin 'ALTER ROLE jarvis_app_runtime NOBYPASSRLS SUPERUSER' >/dev/null
step "6 app role is a superuser" refuses "$work/tasks" "$app" "$worker" "$auth" \
  "role jarvis_app_runtime can bypass row-level security; refusing to start"
step "7 same, with the check switched off" starts "$work/tasks-no-guard" "$app" "$worker" "$auth" \
  "listening on"
admin 'ALTER ROLE jarvis_app_runtime NOSUPERUSER' >/dev/null

echo "app role after reset: $(admin "SELECT 'superuser=' || rolsuper || ' bypass=' || rolbypassrls FROM pg_roles WHERE rolname = 'jarvis_app_runtime'")"
[ "$failed" -eq 0 ]
