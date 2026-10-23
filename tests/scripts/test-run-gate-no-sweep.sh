#!/usr/bin/env bash
# Opt-in no-sweep start (#3529): `start --no-sweep` must skip the global
# leftover-container sweep while keeping ordinary own creation, provisioning
# and cleanup. The omitted-flag control must keep the default sweep. Uses a
# stateful fake docker plus fake pnpm/node/python3 and throwaway repos, all
# confined to the caller-supplied owned root. No real Docker is touched.
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

# Stop only a mocked runner this script launched, named by its exact log and
# reached through its own fake tool environment. Never removes the root.
stop_active() {
  [ -n "$ACTIVE_CASE" ] || return 0
  local dir="$ROOT/$ACTIVE_CASE" log rc=0
  log="$(cat "$dir/receipts/log" 2>/dev/null || true)"
  [ -n "$log" ] && [ -f "$log" ] || return 0
  grep -qF '### FINAL rc=' "$log" 2>/dev/null && return 0
  grep -qF '### LAUNCH_FAILED ' "$log" 2>/dev/null && return 0
  (
    export PATH="$dir/bin:/usr/bin:/bin"
    export JARVIS_GATE_DIR="$dir/logs" FAKE_DOCKER_STATE="$dir/state"
    cd "$dir/repo" && ./scripts/run-gate.sh stop --log "$log" >/dev/null 2>&1
  ) || rc=$?
  [ "$rc" = "0" ] || echo "WARN: stop for $ACTIVE_CASE exited $rc" >&2
  return 0
}
trap '[ "$BASHPID" = "$MAINPID" ] && stop_active' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

containers_of() { cat "$1/state/containers" 2>/dev/null || true; }
container_of_log() { grep -m 1 '^### GATE_CONTAINER ' "$1" | awk '{print $3}'; }

# Build one case under the owned root: throwaway repo holding the copied
# script, a stateful fake docker and instant fake pnpm/node/python3.
new_case() {
  local case_name="$1" dir="$ROOT/$1"
  mkdir -p "$dir/repo/scripts" "$dir/bin" "$dir/state" "$dir/logs" "$dir/receipts"
  : >"$dir/state/containers"
  : >"$dir/state/calls"
  printf '%s\n' "jarv1s-gate-stale-orphan|" "other-app|4242" >"$dir/state/containers"
  cp "$dir/state/containers" "$dir/receipts/foreign.before"
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
  run)
    name=""; prev=""; startpid=""
    for a in "$@"; do
      if [ "$prev" = "--name" ]; then name="$a"; fi
      case "$a" in jarv1s.gate.startpid=*) startpid="${a#*=}" ;; esac
      prev="$a"
    done
    [ -n "$name" ] || exit 9
    printf '%s|%s\n' "$name" "$startpid" >>"$state"
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
  ps)
    cut -d'|' -f1 "$state" 2>/dev/null || true
    ;;
  inspect)
    name="${*: -1}"
    awk -F'|' -v n="$name" '$1 == n { print $2 }' "$state" 2>/dev/null || true
    ;;
esac
exit 0
EOF
  cat >"$dir/bin/pnpm" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  --version) echo "9.9.9-fake" ;;
  fake-fast-gate) sleep 1; exit 0 ;;
  fake-fail-gate) sleep 1; exit 3 ;;
  db:migrate) exit 0 ;;
  *) echo "unexpected pnpm script: $1" >&2; exit 9 ;;
esac
EOF
  printf '#!/usr/bin/env bash\necho "v99.88.77-fake"\n' >"$dir/bin/node"
  # Synthetic port only. The fake opens no socket.
  printf '#!/usr/bin/env bash\necho 55433\n' >"$dir/bin/python3"
  chmod +x "$dir/bin/docker" "$dir/bin/pnpm" "$dir/bin/node" "$dir/bin/python3"
  local tool seen
  for tool in docker pnpm node python3; do
    seen="$(PATH="$dir/bin:/usr/bin:/bin" command -v "$tool")"
    [ "$seen" = "$dir/bin/$tool" ] || fail "$case_name: $tool escapes to host tool $seen"
  done
}

# Run one gate lifecycle inside a case with its fake tools first on PATH.
# Extra environment pairs may precede the run-gate arguments after `--`.
run_in_case() {
  local case_name="$1"
  shift
  local dir="$ROOT/$case_name"
  (
    export PATH="$dir/bin:/usr/bin:/bin"
    export JARVIS_GATE_DIR="$dir/logs" FAKE_DOCKER_STATE="$dir/state"
    unset JARVIS_PG_CONTAINER
    cd "$dir/repo" && "$@"
  )
}

assert_no_sweep_effects() {
  local case_name="$1" dir="$ROOT/$1" own="$2"
  if grep -q '^docker ps' "$dir/state/calls"; then
    fail "$case_name: no-sweep start enumerated containers"
  fi
  if grep -q '^docker inspect' "$dir/state/calls"; then
    fail "$case_name: no-sweep start inspected a container"
  fi
  local removed
  while IFS= read -r removed; do
    [ "$removed" = "$own" ] || fail "$case_name: removed a foreign container: $removed"
  done < <(grep '^docker rm' "$dir/state/calls" | awk '{print $NF}' || true)
  cmp -s "$dir/receipts/foreign.before" "$dir/state/containers" \
    || fail "$case_name: foreign rows changed: $(containers_of "$dir")"
}

assert_own_lifecycle() {
  local case_name="$1" dir="$ROOT/$1" log="$2" own="$3"
  grep -q "^docker run .*--name $own " "$dir/state/calls" \
    || fail "$case_name: own container was not created"
  grep -q 'CREATE DATABASE' "$dir/state/calls" \
    || fail "$case_name: own database was not provisioned"
  grep -qF "### CLEANUP removed gate container $own" "$log" \
    || fail "$case_name: log missing own cleanup receipt"
}

# --- pass: no-sweep keeps both foreign rows and cleans its own -------------
ACTIVE_CASE="pass"
new_case pass
run_in_case pass ./scripts/run-gate.sh start --no-sweep --gate fake-fast-gate \
  >"$ROOT/pass/receipts/start.out" 2>&1 || fail "pass: start failed"
echo 0 >"$ROOT/pass/receipts/start.exit"
LOG="$(awk -F= '/^LOG=/ {print $2}' "$ROOT/pass/receipts/start.out")"
[ -n "$LOG" ] && [ -f "$LOG" ] || fail "pass: no exact LOG from start"
printf '%s\n' "$LOG" >"$ROOT/pass/receipts/log"
OWN="$(container_of_log "$LOG")"
[ -n "$OWN" ] || fail "pass: log missing own container"
rc=0
run_in_case pass ./scripts/run-gate.sh wait --follow --log "$LOG" \
  >"$ROOT/pass/receipts/wait.out" 2>&1 || rc=$?
echo "$rc" >"$ROOT/pass/receipts/wait.exit"
[ "$rc" = "0" ] || fail "pass: wait exited $rc, want 0"
assert_own_lifecycle pass "$LOG" "$OWN"
assert_no_sweep_effects pass "$OWN"
ACTIVE_CASE=""
pass "no-sweep passing run keeps foreign rows and removes its own container"

# --- fail: no-sweep keeps both foreign rows and cleans its own -------------
ACTIVE_CASE="fail"
new_case fail
run_in_case fail ./scripts/run-gate.sh start --no-sweep --gate fake-fail-gate \
  >"$ROOT/fail/receipts/start.out" 2>&1 || fail "fail: start failed"
echo 0 >"$ROOT/fail/receipts/start.exit"
LOG="$(awk -F= '/^LOG=/ {print $2}' "$ROOT/fail/receipts/start.out")"
[ -n "$LOG" ] && [ -f "$LOG" ] || fail "fail: no exact LOG from start"
printf '%s\n' "$LOG" >"$ROOT/fail/receipts/log"
OWN="$(container_of_log "$LOG")"
[ -n "$OWN" ] || fail "fail: log missing own container"
rc=0
run_in_case fail ./scripts/run-gate.sh wait --follow --log "$LOG" \
  >"$ROOT/fail/receipts/wait.out" 2>&1 || rc=$?
echo "$rc" >"$ROOT/fail/receipts/wait.exit"
[ "$rc" = "1" ] || fail "fail: wait exited $rc, want 1"
assert_own_lifecycle fail "$LOG" "$OWN"
assert_no_sweep_effects fail "$OWN"
ACTIVE_CASE=""
pass "no-sweep failing run keeps foreign rows and removes its own container"

# --- abort: broken launcher still cleans only its own ----------------------
ACTIVE_CASE="abort"
new_case abort
cat >"$ROOT/abort/bin/setsid" <<'EOF'
#!/usr/bin/env bash
echo "fake setsid: cannot launch" >&2
exit 127
EOF
chmod +x "$ROOT/abort/bin/setsid"
rc=0
run_in_case abort env JARVIS_GATE_LAUNCH_WAIT_SECS=3 \
  ./scripts/run-gate.sh start --no-sweep --gate fake-fast-gate \
  >"$ROOT/abort/receipts/start.out" 2>&1 || rc=$?
echo "$rc" >"$ROOT/abort/receipts/start.exit"
[ "$rc" != "0" ] || fail "abort: start exited 0 despite the broken launcher"
LOG="$(cat "$ROOT/abort/logs"/*.current 2>/dev/null || true)"
[ -n "$LOG" ] && [ -f "$LOG" ] || fail "abort: no exact log from the case pointer"
printf '%s\n' "$LOG" >"$ROOT/abort/receipts/log"
OWN="$(container_of_log "$LOG")"
[ -n "$OWN" ] || fail "abort: log missing own container"
grep -q '^### LAUNCH_FAILED ' "$LOG" || fail "abort: log missing launch marker"
assert_own_lifecycle abort "$LOG" "$OWN"
assert_no_sweep_effects abort "$OWN"
ACTIVE_CASE=""
pass "no-sweep aborted launch keeps foreign rows and removes its own container"

# --- default: omitted flag still sweeps the fake stale row ------------------
ACTIVE_CASE="default"
new_case default
run_in_case default ./scripts/run-gate.sh start --gate fake-fast-gate \
  >"$ROOT/default/receipts/start.out" 2>&1 || fail "default: start failed"
echo 0 >"$ROOT/default/receipts/start.exit"
LOG="$(awk -F= '/^LOG=/ {print $2}' "$ROOT/default/receipts/start.out")"
[ -n "$LOG" ] && [ -f "$LOG" ] || fail "default: no exact LOG from start"
printf '%s\n' "$LOG" >"$ROOT/default/receipts/log"
OWN="$(container_of_log "$LOG")"
[ -n "$OWN" ] || fail "default: log missing own container"
rc=0
run_in_case default ./scripts/run-gate.sh wait --follow --log "$LOG" \
  >"$ROOT/default/receipts/wait.out" 2>&1 || rc=$?
echo "$rc" >"$ROOT/default/receipts/wait.exit"
[ "$rc" = "0" ] || fail "default: wait exited $rc, want 0"
grep -q '^docker ps' "$ROOT/default/state/calls" \
  || fail "default: omitted flag did not enumerate containers"
grep -qF "### SWEEP removed leftover gate container jarv1s-gate-stale-orphan" "$LOG" \
  || fail "default: omitted flag did not sweep the stale row"
assert_own_lifecycle default "$LOG" "$OWN"
printf '%s\n' "other-app|4242" >"$ROOT/default/receipts/foreign.expected"
cmp -s "$ROOT/default/receipts/foreign.expected" "$ROOT/default/state/containers" \
  || fail "default: unexpected rows left: $(containers_of "$ROOT/default")"
ACTIVE_CASE=""
pass "omitted flag keeps the default sweep"

echo "run-gate no-sweep tests passed"
