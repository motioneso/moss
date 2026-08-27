#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
task_tmp="$(mktemp -d)"
trap 'rm -rf "$task_tmp"' EXIT
mkdir -p "$task_tmp/bin" "$task_tmp/gatedir"

# Fake docker: cmd_start only needs `inspect` to succeed (dev stack is "up")
# and `exec ... psql ...` to succeed (DROP/CREATE DATABASE). No real Postgres.
cat >"$task_tmp/bin/docker" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$task_tmp/bin/docker"

# Fake pnpm: a "fast" script that finishes almost immediately, and a "slow"
# one that outlives a short --timeout, standing in for a real 15-25 minute
# gate without needing one.
cat >"$task_tmp/bin/pnpm" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  fake-fast-gate) sleep 2; exit 0 ;;
  fake-slow-gate) sleep 20; exit 0 ;;
  *) echo "unexpected pnpm script: $1" >&2; exit 9 ;;
esac
EOF
chmod +x "$task_tmp/bin/pnpm"

export PATH="$task_tmp/bin:$PATH"
export JARVIS_GATE_DIR="$task_tmp/gatedir"
export JARVIS_PG_CONTAINER="fake-postgres"
RUN_GATE="$repo_root/scripts/run-gate.sh"

# --- wait --follow returns 0 once the fake gate finishes, in one call ---
"$RUN_GATE" start --gate fake-fast-gate >/dev/null

follow_rc=0
"$RUN_GATE" wait --follow >"$task_tmp/follow.out" 2>&1 &
follow_pid=$!
wait "$follow_pid" || follow_rc=$?
[ "$follow_rc" -eq 0 ] || { echo "expected wait --follow to return 0, got $follow_rc" >&2; cat "$task_tmp/follow.out" >&2; exit 1; }
grep -q '^DONE rc=0' "$task_tmp/follow.out"

# --- plain wait (no --follow) keeps its old bounded behavior ---
"$RUN_GATE" start --gate fake-slow-gate >/dev/null

bounded_rc=0
"$RUN_GATE" wait --timeout 2 >"$task_tmp/bounded.out" 2>&1 || bounded_rc=$?
[ "$bounded_rc" -eq 3 ] || { echo "expected plain wait --timeout to return 3, got $bounded_rc" >&2; cat "$task_tmp/bounded.out" >&2; exit 1; }
grep -q 'call wait again' "$task_tmp/bounded.out"

"$RUN_GATE" stop >/dev/null 2>&1 || true

echo "run-gate wait --follow tests passed"
