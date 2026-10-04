#!/usr/bin/env bash
# Throwaway gate server (#2989): each start launches its own pgvector Postgres
# container on a free loopback port with generous shm, points the gate at it,
# and removes it on every ending (pass, fail, stop, aborted start). Each start
# also sweeps leftover gate containers whose run is no longer alive. Uses a
# stateful fake docker (plus instant fake pnpm/node) and throwaway repos.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN_GATE_SRC="$REPO_ROOT/scripts/run-gate.sh"
REAL_SETSID="$(command -v setsid)"
MAINPID=$$
SCRATCH=""

cleanup() { [ -z "$SCRATCH" ] || rm -rf $SCRATCH; }
# BASHPID guard: subshells inherit the EXIT trap, but only the main shell may
# clean up, or an early subshell exit would delete dirs still in use.
trap '[ "$BASHPID" = "$MAINPID" ] && cleanup' EXIT

fail() { echo "FAIL: $1" >&2; exit 1; }
pass() { echo "ok: $1"; }

containers_of() { cat "$1/state/containers" 2>/dev/null || true; }

# Build a throwaway repo with the script under test plus a stateful fake
# docker and instant fake pnpm/node. Prints "<repo> <bindir> <gatedir>".
new_env() {
  local r bin g
  r="$(mktemp -d)"; bin="$(mktemp -d)"; g="$(mktemp -d)"
  mkdir -p "$g/state"
  : >"$g/state/containers"
  : >"$g/state/calls"
  git init -q -b main "$r"
  git -C "$r" config user.email gate-test@example.com
  git -C "$r" config user.name gate-test
  mkdir -p "$r/scripts"
  cp "$RUN_GATE_SRC" "$r/scripts/run-gate.sh"
  echo base >"$r/file.txt"
  git -C "$r" add -A
  git -C "$r" commit -qm base
  cat >"$bin/docker" <<'EOF'
#!/usr/bin/env bash
# Stateful fake: tracks `run --name` creations (with their startpid label) in
# $FAKE_DOCKER_STATE/containers as `name|startpid` lines. Answers pg_isready
# (unless FAKE_DOCKER_NEVER_READY=1, or the container is held by
# FAKE_DOCKER_HOLD_FIRST=1), psql, rm, ps, and inspect (startpid label).
state="${FAKE_DOCKER_STATE:?}/containers"
calls="${FAKE_DOCKER_STATE:?}/calls"
held="${FAKE_DOCKER_STATE:?}/held"
printf '%s\n' "docker $*" >>"$calls"
case "${1:-}" in
  run)
    name=""
    prev=""
    startpid=""
    for a in "$@"; do
      if [ "$prev" = "--name" ]; then name="$a"; fi
      case "$a" in jarv1s.gate.startpid=*) startpid="${a#*=}" ;; esac
      prev="$a"
    done
    [ -n "$name" ] || exit 9
    printf '%s|%s\n' "$name" "$startpid" >>"$state"
    if [ "${FAKE_DOCKER_HOLD_FIRST:-0}" = "1" ] && [ ! -f "$held" ]; then
      printf '%s\n' "$name" >"$held"
    fi
    ;;
  exec)
    # Container is the first non-flag arg (calls pass -e PGOPTIONS=... first).
    shift
    container=""
    for a in "$@"; do
      case "$a" in
        -e | PGOPTIONS=*) continue ;;
        -*) continue ;;
        *)
          if [ -z "$container" ]; then container="$a"; fi
          ;;
      esac
    done
    [ -n "$container" ] || exit 8
    grep -q "^${container}|" "$state" 2>/dev/null || exit 7
    for a in "$@"; do
      if [ "$a" = "pg_isready" ]; then
        if [ "${FAKE_DOCKER_NEVER_READY:-0}" = "1" ]; then exit 1; fi
        if [ -f "$held" ] && grep -qxF "$container" "$held" 2>/dev/null; then exit 1; fi
      fi
    done
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
  chmod +x "$bin/docker"
  cat >"$bin/pnpm" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  --version) echo "9.9.9-fake" ;;
  fake-fast-gate) sleep 1; exit 0 ;;
  fake-fail-gate) sleep 1; exit 3 ;;
  fake-slow-gate) sleep 60; exit 0 ;;
  *) echo "unexpected pnpm script: $1" >&2; exit 9 ;;
esac
EOF
  chmod +x "$bin/pnpm"
  cat >"$bin/node" <<'EOF'
#!/usr/bin/env bash
echo "v99.88.77-fake"
EOF
  chmod +x "$bin/node"
  echo "$r $bin $g"
}

container_of_log() { grep -m 1 '^### GATE_CONTAINER ' "$1" | awk '{print $3}'; }

# --- T1: passing run removes its container ----------------------------------
read R1 B1 G1 <<<"$(new_env)"
SCRATCH="$SCRATCH $R1 $B1 $G1"
export PATH="$B1:/usr/bin:/bin"
export JARVIS_GATE_DIR="$G1" FAKE_DOCKER_STATE="$G1/state"
unset JARVIS_PG_CONTAINER
( cd "$R1" && ./scripts/run-gate.sh start --gate fake-fast-gate >"$G1/start.out" 2>&1 ) \
  || fail "T1: start failed"
LOG1="$(awk -F= '/^LOG=/ {print $2}' "$G1/start.out")"
[ -n "$LOG1" ] || fail "T1: no LOG from start"
C1="$(container_of_log "$LOG1")"
[ -n "$C1" ] || fail "T1: log missing ### GATE_CONTAINER"
case "$C1" in jarv1s-gate-*) ;; *) fail "T1: container name has no gate prefix [$C1]" ;; esac
grep -qF "$C1" "$G1/state/containers" || fail "T1: container not created"
( cd "$R1" && ./scripts/run-gate.sh wait --follow --log "$LOG1" >/dev/null 2>&1 ) \
  || fail "T1: wait failed"
grep -qF "### CLEANUP removed gate container $C1" "$LOG1" \
  || fail "T1: log missing container cleanup"
[ -z "$(containers_of "$G1")" ] || fail "T1: container left behind: $(containers_of "$G1")"
pass "passing run removes its container"

# --- T2: failing run removes its container ---------------------------------
read R2 B2 G2 <<<"$(new_env)"
SCRATCH="$SCRATCH $R2 $B2 $G2"
export PATH="$B2:/usr/bin:/bin"
export JARVIS_GATE_DIR="$G2" FAKE_DOCKER_STATE="$G2/state"
( cd "$R2" && ./scripts/run-gate.sh start --gate fake-fail-gate >"$G2/start.out" 2>&1 ) \
  || fail "T2: start failed"
LOG2="$(awk -F= '/^LOG=/ {print $2}' "$G2/start.out")"
C2="$(container_of_log "$LOG2")"
[ -n "$C2" ] || fail "T2: log missing ### GATE_CONTAINER"
if ( cd "$R2" && ./scripts/run-gate.sh wait --follow --log "$LOG2" >/dev/null 2>&1 ); then
  fail "T2: wait exited 0, want gate failure"
fi
grep -qF "### CLEANUP removed gate container $C2" "$LOG2" \
  || fail "T2: log missing container cleanup"
[ -z "$(containers_of "$G2")" ] || fail "T2: container left behind"
pass "failing run removes its container"

# --- T3: stopped run removes its container ---------------------------------
read R3 B3 G3 <<<"$(new_env)"
SCRATCH="$SCRATCH $R3 $B3 $G3"
export PATH="$B3:/usr/bin:/bin"
export JARVIS_GATE_DIR="$G3" FAKE_DOCKER_STATE="$G3/state"
( cd "$R3" && ./scripts/run-gate.sh start --gate fake-slow-gate >"$G3/start.out" 2>&1 ) \
  || fail "T3: start failed"
LOG3="$(awk -F= '/^LOG=/ {print $2}' "$G3/start.out")"
C3="$(container_of_log "$LOG3")"
sleep 3
( cd "$R3" && ./scripts/run-gate.sh stop --log "$LOG3" >/dev/null 2>&1 ) || true
grep -qF '### FINAL rc=' "$LOG3" || fail "T3: stop left no sentinel"
grep -qF "### CLEANUP removed gate container $C3" "$LOG3" \
  || fail "T3: log missing container cleanup"
[ -z "$(containers_of "$G3")" ] || fail "T3: container left behind"
pass "stopped run removes its container"

# --- T4: aborted start (broken launcher) removes its container -------------
read R4 B4 G4 <<<"$(new_env)"
SCRATCH="$SCRATCH $R4 $B4 $G4"
cat >"$B4/setsid" <<'EOF'
#!/usr/bin/env bash
echo "fake setsid: cannot launch" >&2
exit 127
EOF
chmod +x "$B4/setsid"
export PATH="$B4:/usr/bin:/bin"
export JARVIS_GATE_DIR="$G4" FAKE_DOCKER_STATE="$G4/state"
export JARVIS_GATE_LAUNCH_WAIT_SECS=5
if ( cd "$R4" && ./scripts/run-gate.sh start --gate fake-fast-gate >"$G4/start.out" 2>&1 ); then
  fail "T4: start exited 0 despite the runner never launching"
fi
LOG4="$(ls -t "$G4"/*.log | head -1)"
grep -q '^### LAUNCH_FAILED ' "$LOG4" || fail "T4: log missing launch marker"
grep -qF 'removed gate container' "$LOG4" || fail "T4: log missing container cleanup"
[ -z "$(containers_of "$G4")" ] || fail "T4: container left behind"
pass "aborted start removes its container"

# --- T5: server that never readies fails loud with no container left -------
read R5 B5 G5 <<<"$(new_env)"
SCRATCH="$SCRATCH $R5 $B5 $G5"
export PATH="$B5:/usr/bin:/bin"
export JARVIS_GATE_DIR="$G5" FAKE_DOCKER_STATE="$G5/state"
export JARVIS_GATE_PGREADY_SECS=4 FAKE_DOCKER_NEVER_READY=1
unset JARVIS_GATE_LAUNCH_WAIT_SECS
if ( cd "$R5" && ./scripts/run-gate.sh start --gate fake-fast-gate >"$G5/start.out" 2>&1 ); then
  fail "T5: start exited 0 despite the server never readying"
fi
grep -qi 'did not accept connections' "$G5/start.out" \
  || fail "T5: start hid the readiness reason: $(cat "$G5/start.out")"
LOG5="$(ls -t "$G5"/*.log | head -1)"
if ( cd "$R5" && ./scripts/run-gate.sh status --log "$LOG5" >/dev/null 2>&1 ); then
  fail "T5: status exited 0, want DEAD(2)"
else
  rc=$?
  [ "$rc" -eq 2 ] || fail "T5: status gave $rc, want 2 (never-ready server must read DEAD, not RUNNING)"
fi
[ -z "$(containers_of "$G5")" ] || fail "T5: container left behind"
unset FAKE_DOCKER_NEVER_READY
pass "unready server fails loud with no container left"

# --- T6: sweep collects the stale, keeps the live --------------------------
read R6 B6 G6 <<<"$(new_env)"
SCRATCH="$SCRATCH $R6 $B6 $G6"
export PATH="$B6:/usr/bin:/bin"
export JARVIS_GATE_DIR="$G6" FAKE_DOCKER_STATE="$G6/state"
unset JARVIS_GATE_PGREADY_SECS
( cd "$R6" && ./scripts/run-gate.sh start --gate fake-slow-gate >"$G6/slow.out" 2>&1 ) \
  || fail "T6: slow start failed"
SLOW_LOG="$(awk -F= '/^LOG=/ {print $2}' "$G6/slow.out")"
SLOW_C="$(container_of_log "$SLOW_LOG")"
sleep 3
printf '%s\n' "jarv1s-gate-stale-orphan|" >>"$G6/state/containers"
( cd "$R6" && ./scripts/run-gate.sh start --gate fake-fast-gate >"$G6/fast.out" 2>&1 ) \
  || fail "T6: fast start failed"
FAST_LOG="$(awk -F= '/^LOG=/ {print $2}' "$G6/fast.out")"
FAST_C="$(container_of_log "$FAST_LOG")"
[ -n "$FAST_C" ] || fail "T6: fast log missing container"
[ "$FAST_C" != "$SLOW_C" ] || fail "T6: two runs share one container name"
grep -qF "jarv1s-gate-stale-orphan" "$G6/state/containers" \
  && fail "T6: sweep did not collect the stale container"
grep -qF "### SWEEP removed leftover gate container jarv1s-gate-stale-orphan" "$FAST_LOG" \
  || fail "T6: sweep left no record in the new log"
grep -qF "$SLOW_C" "$G6/state/containers" \
  || fail "T6: sweep collected a live run's container"
( cd "$R6" && ./scripts/run-gate.sh wait --follow --log "$FAST_LOG" >/dev/null 2>&1 ) \
  || fail "T6: fast wait failed"
( cd "$R6" && ./scripts/run-gate.sh stop --log "$SLOW_LOG" >/dev/null 2>&1 ) || true
[ -z "$(containers_of "$G6")" ] || fail "T6: containers left behind: $(containers_of "$G6")"
pass "sweep collects the stale container and keeps the live one"

# --- T8: overlapping starts never sweep a server being brought up ---------
# The blocking review finding: start A is held before its server is ready
# while start B launches. B's sweep must keep A's server even though A's log
# has no runner PID yet (the name is reserved in A's log up front, and A's
# starting process is still alive). After A is killed, the next start
# collects its server.
read R8 B8 G8 <<<"$(new_env)"
SCRATCH="$SCRATCH $R8 $B8 $G8"
export PATH="$B8:/usr/bin:/bin"
export JARVIS_GATE_DIR="$G8" FAKE_DOCKER_STATE="$G8/state"
export JARVIS_GATE_PGREADY_SECS=120 JARVIS_GATE_LAUNCH_GRACE_SECS=4
export FAKE_DOCKER_HOLD_FIRST=1
( cd "$R8" && setsid ./scripts/run-gate.sh start --gate fake-fast-gate >"$G8/a.out" 2>&1 & echo $! >"$G8/apid" )
# Wait until A is actually stuck bringing its server up (not just slow to
# start), so B's sweep truly overlaps the bringing-up window.
for _i in $(seq 1 30); do
  [ -s "$G8/state/containers" ] && break
  sleep 1
done
[ -s "$G8/state/containers" ] || fail "T8: start A created no server"
sleep 2
A_PTR="$(cat "$G8"/*.current 2>/dev/null || true)"
[ -n "$A_PTR" ] || fail "T8: start A recorded no pointer"
A_C="$(container_of_log "$A_PTR")"
[ -n "$A_C" ] || fail "T8: start A's log reserves no container name"
( cd "$R8" && ./scripts/run-gate.sh start --gate fake-fast-gate >"$G8/b.out" 2>&1 ) \
  || fail "T8: overlapping start B failed"
B_LOG="$(awk -F= '/^LOG=/ {print $2}' "$G8/b.out")"
B_C="$(container_of_log "$B_LOG")"
[ "$B_C" != "$A_C" ] || fail "T8: overlapping runs share one container"
if grep -qF "### SWEEP removed leftover gate container $A_C" "$B_LOG"; then
  fail "T8: start B swept start A's server mid-launch"
fi
grep -qF "$A_C" "$G8/state/containers" || fail "T8: start A's server is gone after B's sweep"
( cd "$R8" && ./scripts/run-gate.sh wait --follow --log "$B_LOG" >/dev/null 2>&1 ) \
  || fail "T8: start B did not pass"
kill -KILL "$(cat "$G8/apid")" 2>/dev/null || true
sleep 6
unset FAKE_DOCKER_HOLD_FIRST
( cd "$R8" && ./scripts/run-gate.sh start --gate fake-fast-gate >"$G8/c.out" 2>&1 ) \
  || fail "T8: start C failed"
C_LOG="$(awk -F= '/^LOG=/ {print $2}' "$G8/c.out")"
grep -qF "### SWEEP removed leftover gate container $A_C" "$C_LOG" \
  || fail "T8: start C did not sweep start A's killed server"
( cd "$R8" && ./scripts/run-gate.sh wait --follow --log "$C_LOG" >/dev/null 2>&1 ) \
  || fail "T8: start C did not pass"
[ -z "$(containers_of "$G8")" ] || fail "T8: containers left behind: $(containers_of "$G8")"
pass "overlapping starts keep the server being brought up"

# --- T7: launch shape (image, loopback port, shm) ---------------------------
grep -qF -- '--shm-size="$GATE_SHM"' "$RUN_GATE_SRC" \
  || fail "T7: docker run lost its --shm-size"
grep -qF 'GATE_SHM="${JARVIS_GATE_PGSHM:-1g}"' "$RUN_GATE_SRC" \
  || fail "T7: default shm is not 1g"
grep -qF -- '-p "127.0.0.1:${port}:5432"' "$RUN_GATE_SRC" \
  || fail "T7: port is not published on loopback"
COMPOSE_IMAGE="$(grep -m 1 'image: pgvector' "$REPO_ROOT/infra/docker-compose.yml" | awk '{print $2}')"
SCRIPT_IMAGE="$(grep -m 1 'GATE_IMAGE="${JARVIS_GATE_PGIMAGE:-' "$RUN_GATE_SRC" | sed 's/.*:-\(.*\)}".*/\1/')"
[ -n "$COMPOSE_IMAGE" ] || fail "T7: no pgvector image in dev compose"
[ "$SCRIPT_IMAGE" = "$COMPOSE_IMAGE" ] \
  || fail "T7: gate image [$SCRIPT_IMAGE] drifts from dev compose [$COMPOSE_IMAGE]"
grep -q '^docker run ' "$G6/state/calls" \
  || fail "T7: no container launch recorded"
grep -qF "$COMPOSE_IMAGE" "$G6/state/calls" \
  || fail "T7: launched image is not the dev compose image"
pass "launch uses the dev image on a loopback port with 1g shm"

echo "run-gate own-postgres tests passed"
