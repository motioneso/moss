#!/usr/bin/env bash
# Failed launch (#2473): a gate whose runner never records its PID must fail
# loudly at start and report DEAD with the reason — never silent RUNNING.
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

cat >"$task_tmp/bin/pnpm" <<'EOF'
#!/usr/bin/env bash
sleep 1; exit 0
EOF
chmod +x "$task_tmp/bin/pnpm"

# Broken launcher: setsid always fails, so __run never executes and no PID
# ever lands in the log — the shape of the observed incident.
cat >"$task_tmp/bin/setsid" <<'EOF'
#!/usr/bin/env bash
echo "fake setsid: cannot launch" >&2
exit 127
EOF
chmod +x "$task_tmp/bin/setsid"

export PATH="$task_tmp/bin:$PATH"
export JARVIS_GATE_DIR="$task_tmp/gatedir"
export JARVIS_PG_CONTAINER="fake-postgres"
export JARVIS_GATE_LAUNCH_WAIT_SECS=5
RUN_GATE="$repo_root/scripts/run-gate.sh"

cd "$repo_root"

start_rc=0
"$RUN_GATE" start --gate fake-fast-gate >/dev/null 2>&1 || start_rc=$?
[ "$start_rc" -ne 0 ] \
  || { echo "start exited 0 despite the runner never launching" >&2; exit 1; }

log="$(ls -t "$task_tmp"/gatedir/*.log | head -1)"
grep -q '^### LAUNCH_FAILED ' "$log" \
  || { echo "log missing launch-failure marker" >&2; exit 1; }

status_rc=0
status_out="$("$RUN_GATE" status --log "$log" 2>&1)" || status_rc=$?
[ "$status_rc" -eq 2 ] \
  || { echo "status returned $status_rc, want 2 (DEAD)" >&2; exit 1; }
echo "$status_out" | grep -qi '^DEAD' \
  || { echo "status output missing DEAD" >&2; echo "$status_out" >&2; exit 1; }

wait_rc=0
"$RUN_GATE" wait --log "$log" --timeout 5 >/dev/null 2>&1 || wait_rc=$?
[ "$wait_rc" -eq 2 ] \
  || { echo "wait returned $wait_rc, want 2 (DEAD)" >&2; exit 1; }

echo "run-gate failed-launch tests passed"
