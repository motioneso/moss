#!/usr/bin/env bash
# Failed launch (#2473): a gate whose runner never starts must fail loudly at
# start and report DEAD with the reason — never silent RUNNING, never another
# run's result, and never a stranded runner. Uses throwaway repos and fake
# docker/pnpm/setsid plus a private gate dir.
#
# NOTE on style: under set -e, a command expected to fail must use if/|| form
# (a bare failing statement, even followed by rc=$?, kills the shell first).
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

# Build a throwaway repo with the script under test plus instant fake
# docker/pnpm. Prints "<repo> <bindir> <gatedir>". The caller registers them
# in SCRATCH (appending here would be lost: this runs in a command
# substitution subshell).
new_env() {
  local r bin g
  r="$(mktemp -d)"; bin="$(mktemp -d)"; g="$(mktemp -d)"
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
exit 0
EOF
  chmod +x "$bin/docker"
  cat >"$bin/pnpm" <<'EOF'
#!/usr/bin/env bash
sleep 1; exit 0
EOF
  chmod +x "$bin/pnpm"
  echo "$r $bin $g"
}

# --- T1: broken launcher fails loud with the launcher's own reason ---------
read R1 B1 G1 <<<"$(new_env)"
SCRATCH="$SCRATCH $R1 $B1 $G1"
cat >"$B1/setsid" <<'EOF'
#!/usr/bin/env bash
echo "fake setsid: cannot launch" >&2
exit 127
EOF
chmod +x "$B1/setsid"
export PATH="$B1:/usr/bin:/bin"
export JARVIS_GATE_DIR="$G1" JARVIS_PG_CONTAINER="fake-postgres"
export JARVIS_GATE_LAUNCH_WAIT_SECS=5
if ( cd "$R1" && ./scripts/run-gate.sh start --gate fake-fast-gate >"$G1/start.out" 2>&1 ); then
  fail "T1: start exited 0 despite the runner never launching"
fi
LOG1="$(ls -t "$G1"/*.log | head -1)"
grep -q '^### LAUNCH_FAILED ' "$LOG1" || fail "T1: log missing launch marker"
if ( cd "$R1" && ./scripts/run-gate.sh status --log "$LOG1" >"$G1/status.out" 2>&1 ); then
  fail "T1: status exited 0, want DEAD(2)"
else
  rc=$?
  [ "$rc" -eq 2 ] || fail "T1: status gave $rc, want 2"
fi
grep -q 'fake setsid' "$G1/status.out" || fail "T1: DEAD line missing launcher reason"
if ( cd "$R1" && ./scripts/run-gate.sh wait --log "$LOG1" --timeout 5 >/dev/null 2>&1 ); then
  fail "T1: wait exited 0, want DEAD(2)"
else
  rc=$?
  [ "$rc" -eq 2 ] || fail "T1: wait gave $rc, want 2"
fi
pass "broken launcher fails loud with its own reason"

# --- T2: SIGKILLed start must not let wait report the previous run ---------
read R2 B2 G2 <<<"$(new_env)"
SCRATCH="$SCRATCH $R2 $B2 $G2"
cat >"$B2/docker" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = "exec" ]; then sleep 60; fi
exit 0
EOF
chmod +x "$B2/docker"
export PATH="$B2:/usr/bin:/bin"
export JARVIS_GATE_DIR="$G2" JARVIS_PG_CONTAINER="fake-postgres"
export JARVIS_GATE_LAUNCH_GRACE_SECS=4
# A prior green run whose result must never leak into the next wait.
( cd "$R2" && ./scripts/run-gate.sh start --gate fake-fast-gate >"$G2/good.out" 2>&1 ) \
  || fail "T2: setup run did not start"
GOOD_LOG="$(awk -F= '/^LOG=/ {print $2}' "$G2/good.out")"
[ -n "$GOOD_LOG" ] || fail "T2: no LOG from setup run"
( cd "$R2" && ./scripts/run-gate.sh wait --follow --log "$GOOD_LOG" >/dev/null 2>&1 ) \
  || fail "T2: setup run did not pass"
sleep 2
# A second start in its own session, killed while provisioning: the pointer
# already names the new log, but there is no PID and no marker (SIGKILL runs
# no trap), so only the backstop can report it.
( cd "$R2" && setsid ./scripts/run-gate.sh start --gate fake-fast-gate >"$G2/bad.out" 2>&1 & echo $! >"$G2/spid" )
sleep 3
kill -KILL "$(cat "$G2/spid")" 2>/dev/null || true
sleep 6
PTR2="$(cat "$G2"/*.current 2>/dev/null || true)"
[ -n "$PTR2" ] || fail "T2: no pointer after killed start"
[ "$PTR2" != "$GOOD_LOG" ] || fail "T2: pointer still names the previous run"
if ( cd "$R2" && ./scripts/run-gate.sh wait --timeout 10 >"$G2/wait.out" 2>&1 ); then
  echo "--- wait.out:"; cat "$G2/wait.out"; fail "T2: wait exited 0, want 2"
else
  rc=$?
  [ "$rc" -eq 2 ] || { echo "--- wait.out:"; cat "$G2/wait.out"; fail "T2: wait gave $rc, want 2"; }
fi
grep -qi 'dead' "$G2/wait.out" || fail "T2: wait output is not a DEAD verdict"
pass "killed start makes wait report DEAD, not the previous run"

# --- T3: late runner is stopped, not stranded with a permanent DEAD --------
read R3 B3 G3 <<<"$(new_env)"
SCRATCH="$SCRATCH $R3 $B3 $G3"
cat >"$B3/setsid" <<EOF
#!/usr/bin/env bash
sleep 4
exec "$REAL_SETSID" "\$@"
EOF
chmod +x "$B3/setsid"
export PATH="$B3:/usr/bin:/bin"
export JARVIS_GATE_DIR="$G3" JARVIS_PG_CONTAINER="fake-postgres"
export JARVIS_GATE_LAUNCH_WAIT_SECS=2
unset JARVIS_GATE_LAUNCH_GRACE_SECS
if ( cd "$R3" && ./scripts/run-gate.sh start --gate fake-fast-gate >"$G3/start.out" 2>&1 ); then
  fail "T3: timed-out start exited 0"
fi
LOG3="$(ls -t "$G3"/*.log | head -1)"
sleep 6
if ps -eo args 2>/dev/null | grep -F "__run $LOG3" | grep -v grep | grep -q .; then
  fail "T3: runner still alive after the launch timeout"
fi
if ( cd "$R3" && ./scripts/run-gate.sh status --log "$LOG3" >/dev/null 2>&1 ); then
  fail "T3: status exited 0, want DEAD(2)"
else
  rc=$?
  [ "$rc" -eq 2 ] || fail "T3: status gave $rc, want 2"
fi
pass "late runner is stopped, verdict is DEAD"
# A finished run still wins over the marker: sentinel first, always.
printf '### GATE   pnpm x\n### START  t\n### PID    999999\n### LAUNCH_FAILED stale marker\n### END    t\n### FINAL rc=0\n' >"$G3/sentinel.log"
( cd "$R3" && ./scripts/run-gate.sh status --log "$G3/sentinel.log" >"$G3/s.out" 2>&1 ) \
  || fail "T3: sentinel did not win over the marker"
grep -q '^DONE rc=0' "$G3/s.out" || fail "T3: expected DONE rc=0"
pass "sentinel wins over a stale marker"

# --- T4: header-only and headerless logs ------------------------------------
read R4 B4 G4 <<<"$(new_env)"
SCRATCH="$SCRATCH $R4 $B4 $G4"
export PATH="$B4:/usr/bin:/bin"
printf '### GATE   pnpm verify:foundation\n### CWD    /tmp/old\n### START  t\n' >"$G4/fresh-header.log"
if ( cd "$R4" && ./scripts/run-gate.sh status --log "$G4/fresh-header.log" >/dev/null 2>&1 ); then
  fail "T4: fresh header-only log exited 0, want RUNNING(3)"
else
  rc=$?
  [ "$rc" -eq 3 ] || fail "T4: fresh header-only log gave $rc, want 3"
fi
printf '### GATE   pnpm verify:foundation\n### CWD    /tmp/old\n### START  t\n' >"$G4/stale-header.log"
touch -d '5 minutes ago' "$G4/stale-header.log"
if ( cd "$R4" && ./scripts/run-gate.sh status --log "$G4/stale-header.log" >"$G4/s2.out" 2>&1 ); then
  fail "T4: stale header-only log exited 0, want DEAD(2)"
else
  rc=$?
  [ "$rc" -eq 2 ] || fail "T4: stale header-only log gave $rc, want 2"
fi
printf 'some foreign log without our header\n' >"$G4/foreign.log"
if ( cd "$R4" && ./scripts/run-gate.sh status --log "$G4/foreign.log" >/dev/null 2>&1 ); then
  fail "T4: fresh foreign log exited 0, want RUNNING(3)"
else
  rc=$?
  [ "$rc" -eq 3 ] || fail "T4: fresh foreign log gave $rc, want 3"
fi
pass "header-only and foreign logs use the right bounds"

# --- T5: start killed before setup finishes still reports its own run ------
read R5 B5 G5 <<<"$(new_env)"
SCRATCH="$SCRATCH $R5 $B5 $G5"
cat >"$B5/docker" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = "inspect" ] && [ "${SLOW_INSPECT:-0}" = "1" ]; then sleep 60; fi
exit 0
EOF
chmod +x "$B5/docker"
export PATH="$B5:/usr/bin:/bin"
export JARVIS_GATE_DIR="$G5" JARVIS_PG_CONTAINER="fake-postgres"
export JARVIS_GATE_LAUNCH_GRACE_SECS=4
# A prior green run whose result must never leak into the next wait.
if ( cd "$R5" && ./scripts/run-gate.sh start --gate fake-fast-gate >"$G5/good.out" 2>&1 ); then
  GOOD5="$(awk -F= '/^LOG=/ {print $2}' "$G5/good.out")"
else
  fail "T5: setup run did not start"
fi
[ -n "$GOOD5" ] || fail "T5: no LOG from setup run"
if ( cd "$R5" && ./scripts/run-gate.sh wait --follow --log "$GOOD5" >/dev/null 2>&1 ); then
  :
else
  fail "T5: setup run did not pass"
fi
[ ! -e "$GOOD5.launch-err" ] || fail "T5: healthy run left its error sidecar behind"
sleep 2
# A second start, killed while still checking setup: the pointer must already
# name the new log, so the next wait reports this run (DEAD), not the green one.
export SLOW_INSPECT=1
( cd "$R5" && setsid ./scripts/run-gate.sh start --gate fake-fast-gate >"$G5/bad.out" 2>&1 & echo $! >"$G5/spid" )
sleep 3
kill -KILL "$(cat "$G5/spid")" 2>/dev/null || true
unset SLOW_INSPECT
sleep 6
PTR5="$(cat "$G5"/*.current 2>/dev/null || true)"
[ -n "$PTR5" ] || fail "T5: no pointer after killed start"
[ "$PTR5" != "$GOOD5" ] || fail "T5: pointer still names the previous run"
if ( cd "$R5" && ./scripts/run-gate.sh wait --timeout 10 >"$G5/wait.out" 2>&1 ); then
  echo "--- wait.out:"; cat "$G5/wait.out"; fail "T5: wait exited 0, want 2"
else
  rc=$?
  [ "$rc" -eq 2 ] || { echo "--- wait.out:"; cat "$G5/wait.out"; fail "T5: wait gave $rc, want 2"; }
fi
grep -qi 'dead' "$G5/wait.out" || fail "T5: wait output is not a DEAD verdict"
pass "early-killed start makes wait report DEAD, not the previous run"

# --- T6: nohup notice must not hide the real launch error -------------------
read R6 B6 G6 <<<"$(new_env)"
SCRATCH="$SCRATCH $R6 $B6 $G6"
cat >"$B6/setsid" <<'EOF'
#!/usr/bin/env bash
echo "nohup: ignoring input and appending output to 'nohup.out'" >&2
echo "fake setsid: cannot launch" >&2
exit 127
EOF
chmod +x "$B6/setsid"
export PATH="$B6:/usr/bin:/bin"
export JARVIS_GATE_DIR="$G6" JARVIS_PG_CONTAINER="fake-postgres"
export JARVIS_GATE_LAUNCH_WAIT_SECS=5
if ( cd "$R6" && ./scripts/run-gate.sh start --gate fake-fast-gate >"$G6/start.out" 2>&1 ); then
  fail "T6: start exited 0 despite the runner never launching"
fi
LOG6="$(ls -t "$G6"/*.log | head -1)"
if ( cd "$R6" && ./scripts/run-gate.sh status --log "$LOG6" >"$G6/status.out" 2>&1 ); then
  fail "T6: status exited 0, want DEAD(2)"
else
  rc=$?
  [ "$rc" -eq 2 ] || fail "T6: status gave $rc, want 2"
fi
grep -q 'fake setsid' "$G6/status.out" || fail "T6: DEAD line missing the real error"
if grep -q 'nohup:' "$G6/status.out"; then
  fail "T6: DEAD line shows the nohup notice instead"
fi
pass "nohup notice is filtered from the dead reason"

# --- T7: a real nohup error still becomes the dead reason -------------------
read R7 B7 G7 <<<"$(new_env)"
SCRATCH="$SCRATCH $R7 $B7 $G7"
# The launcher execs "$0" directly, so without the exec bit the real nohup
# reports "failed to run command ... Permission denied". Run everything
# through bash explicitly so only the launcher hits the missing bit.
chmod -x "$R7/scripts/run-gate.sh"
export PATH="$B7:/usr/bin:/bin"
export JARVIS_GATE_DIR="$G7" JARVIS_PG_CONTAINER="fake-postgres"
export JARVIS_GATE_LAUNCH_WAIT_SECS=5
if ( cd "$R7" && bash ./scripts/run-gate.sh start --gate fake-fast-gate >"$G7/start.out" 2>&1 ); then
  fail "T7: start exited 0 despite the failed launch"
fi
LOG7="$(ls -t "$G7"/*.log | head -1)"
if ( cd "$R7" && bash ./scripts/run-gate.sh status --log "$LOG7" >"$G7/status.out" 2>&1 ); then
  fail "T7: status exited 0, want DEAD(2)"
else
  rc=$?
  [ "$rc" -eq 2 ] || fail "T7: status gave $rc, want 2"
fi
grep -qi 'permission denied' "$G7/status.out" \
  || fail "T7: DEAD line hides the real error: $(cat "$G7/status.out")"
pass "real launcher error survives the nohup filter"

echo "run-gate failed-launch tests passed"
