#!/usr/bin/env bash
set -euo pipefail

task_tmp="$(mktemp -d)"
trap 'rm -rf "$task_tmp"' EXIT
mkdir -p "$task_tmp/bin" "$task_tmp/state/jarv1s-coordinator-watchdog"

cat >"$task_tmp/bin/herdr" <<'EOF'
#!/usr/bin/env bash
if [ "$*" = "pane list" ]; then
  printf '%s\n' "$WATCHDOG_TEST_PANE_JSON"
  exit 0
fi
exit 2
EOF
chmod +x "$task_tmp/bin/herdr"

state_file="$task_tmp/state/jarv1s-coordinator-watchdog/state.json"
printf '%s\n' '{"revision":"7","last_change":1,"last_nudge":0}' >"$state_file"

working_json='{"result":{"panes":[{"label":"Coordinator","pane_id":"w1:p1","revision":7,"agent_status":"working"}]}}'
output="$(PATH="$task_tmp/bin:$PATH" XDG_STATE_HOME="$task_tmp/state" WATCHDOG_TEST_PANE_JSON="$working_json" COORDINATOR_WATCHDOG_IDLE_SECONDS=1 COORDINATOR_WATCHDOG_DRY_RUN=1 scripts/ops/coordinator-watchdog.sh)"
[ -z "$output" ]
[ "$(jq -r '.last_change' "$state_file")" -gt 1 ]

printf '%s\n' '{"revision":"7","last_change":1,"last_nudge":0}' >"$state_file"
idle_json='{"result":{"panes":[{"label":"Coordinator","pane_id":"w1:p1","revision":7,"agent_status":"idle"}]}}'
output="$(PATH="$task_tmp/bin:$PATH" XDG_STATE_HOME="$task_tmp/state" WATCHDOG_TEST_PANE_JSON="$idle_json" COORDINATOR_WATCHDOG_IDLE_SECONDS=1 COORDINATOR_WATCHDOG_DRY_RUN=1 scripts/ops/coordinator-watchdog.sh)"
grep -q 'idle for .*s, nudging' <<<"$output"

echo "coordinator watchdog tests passed"
