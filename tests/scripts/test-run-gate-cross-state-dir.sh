#!/usr/bin/env bash
# Cross-state-directory cleanup (#3672). A gate started with JARVIS_GATE_DIR keeps its log in that
# directory. A second gate starting with a different JARVIS_GATE_DIR sweeps containers globally, so
# judging liveness only by the caller's own logs treated the first run's live database server as an
# orphan and removed it. The container now records the exact log it was launched for, so a sweep
# from any state directory can judge that run and leave it alone. Real leftovers are still removed.
#
# Stateful fake docker plus fake pnpm/node/python3 and throwaway repos, all confined to the
# caller-supplied owned root. No real Docker is touched.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN_GATE_SRC="$REPO_ROOT/scripts/run-gate.sh"
ROOT="${N3_GATE_MOCK_ROOT:?N3_GATE_MOCK_ROOT must name an owned mock root}"
case "$ROOT" in
  /*) ;;
  *) echo "FAIL: N3_GATE_MOCK_ROOT must be absolute" >&2; exit 1 ;;
esac
[ -d "$ROOT" ] || { echo "FAIL: mock root missing: $ROOT" >&2; exit 1; }
[ -n "${TMPDIR:-}" ] && [ -d "$TMPDIR" ] || { echo "FAIL: owned TMPDIR missing" >&2; exit 1; }

MAINPID=$$
ACTIVE_CASE=""
fail() { echo "FAIL: $1" >&2; exit 1; }
pass() { echo "ok: $1"; }

# Stop only a mocked runner this script launched, named by its exact log and reached through its
# own fake tool environment. Never removes the root.
stop_active() {
  [ -n "$ACTIVE_CASE" ] || return 0
  local dir="$ROOT/$ACTIVE_CASE" log rc=0
  log="$(cat "$dir/receipts/log" 2>/dev/null || true)"
  [ -n "$log" ] && [ -f "$log" ] || return 0
  grep -qF '### FINAL rc=' "$log" 2>/dev/null && return 0
  grep -qF '### LAUNCH_FAILED ' "$log" 2>/dev/null && return 0
  (
    export PATH="$dir/bin:/usr/bin:/bin"
    export JARVIS_GATE_DIR="$dir/logs-b" FAKE_DOCKER_STATE="$dir/state"
    cd "$dir/repo" && ./scripts/run-gate.sh stop --log "$log" >/dev/null 2>&1
  ) || rc=$?
  [ "$rc" = "0" ] || echo "WARN: stop for $ACTIVE_CASE exited $rc" >&2
  return 0
}
trap '[ "$BASHPID" = "$MAINPID" ] && stop_active' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

containers_of() { cat "$1/state/containers" 2>/dev/null || true; }

# Build one case under the owned root: throwaway repo holding the copied script, a stateful fake
# docker that records each container's owner-log label, a fake ps that knows the fabricated live
# run, and instant fake pnpm/node/python3.
new_case() {
  local case_name="$1" dir="$ROOT/$1"
  mkdir -p "$dir/repo/scripts" "$dir/bin" "$dir/state" "$dir/logs-a" "$dir/logs-b" "$dir/receipts"
  : >"$dir/state/containers"
  : >"$dir/state/calls"
  cp "$RUN_GATE_SRC" "$dir/repo/scripts/run-gate.sh"
  echo base >"$dir/repo/file.txt"
  (
    export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
    git init -q -b main --template= "$dir/repo"
    git -C "$dir/repo" config user.email gate-test@example.com
    git -C "$dir/repo" config user.name gate-test
    git -C "$dir/repo" config core.hooksPath /dev/null
    git -C "$dir/repo" add -A
    git -C "$dir/repo" commit -qm base
  )
  cat >"$dir/bin/docker" <<'EOF'
#!/usr/bin/env bash
state="${FAKE_DOCKER_STATE:?}/containers"
calls="${FAKE_DOCKER_STATE:?}/calls"
printf '%s\n' "docker $*" >>"$calls"
case "${1:-}" in
  ps)
    cut -d'|' -f1 "$state" 2>/dev/null || true
    ;;
  inspect)
    name="${*: -1}"
    awk -F'|' -v n="$name" '$1 == n { print $3 }' "$state" 2>/dev/null || true
    ;;
  run)
    name=""; owner=""; startpid=""; prev=""
    for a in "$@"; do
      if [ "$prev" = "--name" ]; then name="$a"; fi
      case "$a" in
        jarv1s.gate.log=*) owner="${a#jarv1s.gate.log=}" ;;
        jarv1s.gate.startpid=*) startpid="${a#jarv1s.gate.startpid=}" ;;
      esac
      prev="$a"
    done
    [ -n "$name" ] || exit 9
    printf '%s|%s|%s\n' "$name" "$startpid" "$owner" >>"$state"
    ;;
  exec)
    shift
    container=""
    for a in "$@"; do
      case "$a" in
        -e | PGOPTIONS=*) continue ;;
        -*) continue ;;
        *) if [ -z "$container" ]; then container="$a"; fi ;;
      esac
    done
    [ -n "$container" ] || exit 8
    grep -q "^${container}|" "$state" 2>/dev/null || exit 7
    ;;
  rm)
    for a in "$@"; do
      case "$a" in -*) continue ;; esac
      grep -v "^${a}|" "$state" 2>/dev/null >"$state.tmp" || true
      mv "$state.tmp" "$state"
    done
    ;;
esac
exit 0
EOF
  cat >"$dir/bin/pnpm" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  --version) echo "9.9.9-fake" ;;
  fake-fast-gate) sleep 1; exit 0 ;;
  db:migrate) exit 0 ;;
  *) echo "unexpected pnpm script: $1" >&2; exit 9 ;;
esac
EOF
  printf '#!/usr/bin/env bash\necho "v99.88.77-fake"\n' >"$dir/bin/node"
  # Synthetic port only. The fake opens no socket.
  printf '#!/usr/bin/env bash\necho 55433\n' >"$dir/bin/python3"
  chmod +x "$dir/bin/docker" "$dir/bin/pnpm" "$dir/bin/node" "$dir/bin/python3"
}

# The fabricated live run in state directory A: one exact PID that is its own session leader and
# whose command line names its own log, which is what the verdict requires. Every other ps call is
# the real one, so the mocked runner's own processes are seen truthfully.
fake_ps() {
  local dir="$1" live_log="$2"
  cat >"$dir/bin/ps" <<EOF
#!/usr/bin/env bash
if [ "\${1:-}" = "-o" ] && [ "\${3:-}" = "-p" ] && [ "\${4:-}" = "4242" ]; then
  case "\${2:-}" in
    sid=) echo 4242 ;;
    args=) echo "bash scripts/run-gate.sh __run $live_log" ;;
  esac
  exit 0
fi
exec /usr/bin/ps "\$@"
EOF
  chmod +x "$dir/bin/ps"
  local tool seen
  for tool in docker pnpm node python3 ps; do
    seen="$(PATH="$dir/bin:/usr/bin:/bin" command -v "$tool")"
    [ "$seen" = "$dir/bin/$tool" ] || fail "case: $tool escapes to host tool $seen"
  done
}

# Run the gate inside state directory B, the caller that does the sweeping.
run_in_b() {
  local dir="$ROOT/$1"
  shift
  (
    export PATH="$dir/bin:/usr/bin:/bin"
    export JARVIS_GATE_DIR="$dir/logs-b" FAKE_DOCKER_STATE="$dir/state"
    unset JARVIS_PG_CONTAINER
    cd "$dir/repo" && "$@"
  )
}

ACTIVE_CASE="cross"
new_case cross
dir="$ROOT/cross"

# State directory A: a live run's log, with the exact shape the verdict reads.
live_log="$dir/logs-a/other_worktree-20260101-000000.log"
finished_log="$dir/logs-a/other_worktree-20251231-000000.log"
{
  echo "### GATE   pnpm fake-fast-gate"
  echo "### GATE_CONTAINER jarv1s-gate-other-20260101-000000-4242-1 (starting)"
  echo "### PID    4242"
} >"$live_log"
{
  echo "### GATE   pnpm fake-fast-gate"
  echo "### GATE_CONTAINER jarv1s-gate-other-20251231-000000-4242-2"
  echo "### PID    4242"
  echo "### FINAL rc=0"
} >"$finished_log"
fake_ps "$dir" "$live_log"

# Containers visible to the sweep: a live server from state directory A (labelled with its own
# log), a finished run's leftover in the same directory, a container whose log is gone, and an
# unrelated container this script must never touch.
printf '%s|%s|%s\n' \
  "jarv1s-gate-other-20260101-000000-4242-1" "4242" "$live_log" \
  "jarv1s-gate-other-20251231-000000-4242-2" "4242" "$finished_log" \
  "jarv1s-gate-lost-20260101-000000-4242-3" "4242" "$dir/logs-a/gone.log" \
  "other-app" "4242" "" >>"$dir/state/containers"
cp "$dir/state/containers" "$dir/receipts/containers.before"

run_in_b cross ./scripts/run-gate.sh start --gate fake-fast-gate \
  >"$dir/receipts/start.out" 2>&1 || fail "cross: start failed"
LOG="$(awk -F= '/^LOG=/ {print $2}' "$dir/receipts/start.out")"
[ -n "$LOG" ] && [ -f "$LOG" ] || fail "cross: no exact LOG from start"
printf '%s\n' "$LOG" >"$dir/receipts/log"
case "$LOG" in
  "$dir/logs-b/"*) ;;
  *) fail "cross: start wrote its log outside state directory B: $LOG" ;;
esac
rc=0
run_in_b cross ./scripts/run-gate.sh wait --follow --log "$LOG" \
  >"$dir/receipts/wait.out" 2>&1 || rc=$?
[ "$rc" = "0" ] || fail "cross: wait exited $rc, want 0"

removed() { grep '^docker rm' "$dir/state/calls" | grep -qF -- "$1"; }

removed "jarv1s-gate-other-20260101-000000-4242-1" &&
  fail "cross: removed the live server from another state directory"
grep -q "^jarv1s-gate-other-20260101-000000-4242-1|" "$dir/state/containers" ||
  fail "cross: live server from another state directory is gone"
grep -qF "### SWEEP removed leftover gate container jarv1s-gate-other-20251231-000000-4242-2" "$LOG" ||
  fail "cross: left the finished run's leftover server behind"
grep -qF "### SWEEP removed leftover gate container jarv1s-gate-lost-20260101-000000-4242-3" "$LOG" ||
  fail "cross: left the container with no owner log behind"
removed "other-app" && fail "cross: removed an unrelated container"
grep -q "^other-app|" "$dir/state/containers" || fail "cross: unrelated container is gone"

# The caller's own server is created and cleaned up exactly as before.
own="$(grep -m 1 '^### GATE_CONTAINER ' "$LOG" | awk '{print $3}')"
[ -n "$own" ] || fail "cross: log missing own container"
grep -qF "### CLEANUP removed gate container $own" "$LOG" || fail "cross: own server was not removed"
ACTIVE_CASE=""
pass "a sweep from another state directory keeps the live server and removes real leftovers"

echo "run-gate cross-state-directory tests passed"
