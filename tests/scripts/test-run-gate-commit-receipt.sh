#!/usr/bin/env bash
# Commit receipt (#2462): start records the tested commit and dirty-tree
# state in the run log, and status output repeats them.
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

# Fake pnpm: a fast script that finishes almost immediately.
cat >"$task_tmp/bin/pnpm" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  fake-fast-gate) sleep 2; exit 0 ;;
  *) echo "unexpected pnpm script: $1" >&2; exit 9 ;;
esac
EOF
chmod +x "$task_tmp/bin/pnpm"

export PATH="$task_tmp/bin:$PATH"
export JARVIS_GATE_DIR="$task_tmp/gatedir"
export JARVIS_PG_CONTAINER="fake-postgres"
RUN_GATE="$repo_root/scripts/run-gate.sh"

cd "$repo_root"
expected_commit="$(git rev-parse HEAD)"

start_out="$("$RUN_GATE" start --gate fake-fast-gate)"
log="$(echo "$start_out" | awk -F= '/^LOG=/ {print $2}')"
[ -n "$log" ] || { echo "no LOG path from start" >&2; exit 1; }

"$RUN_GATE" wait --follow --log "$log" >/dev/null

grep -q "^### COMMIT $expected_commit$" "$log" \
  || { echo "log missing tested commit $expected_commit" >&2; exit 1; }
grep -q '^### DIRTY ' "$log" \
  || { echo "log missing dirty-tree line" >&2; exit 1; }

status_out="$("$RUN_GATE" status --log "$log")"
echo "$status_out" | grep -q "$expected_commit" \
  || { echo "status output missing tested commit" >&2; echo "$status_out" >&2; exit 1; }
echo "$status_out" | grep -qi 'tree \(clean\|dirty\|unknown\)' \
  || { echo "status output missing tree state" >&2; echo "$status_out" >&2; exit 1; }

echo "run-gate commit receipt tests passed"
