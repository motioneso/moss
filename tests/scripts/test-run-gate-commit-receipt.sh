#!/usr/bin/env bash
# Commit receipt (#2462): start records the tested commit and dirty-tree
# state in the run log; status repeats them. Each case builds a throwaway git
# repo and copies the script under test into it. Gate state and captures live
# outside the repo so they never pollute the status under test.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN_GATE_SRC="$REPO_ROOT/scripts/run-gate.sh"
REAL_GIT="$(command -v git)"
MAINPID=$$
SCRATCH=""

cleanup() { [ -z "$SCRATCH" ] || rm -rf $SCRATCH; }
# BASHPID guard: subshells inherit the EXIT trap, but only the main shell may
# clean up, or an early subshell exit would delete dirs still in use.
trap '[ "$BASHPID" = "$MAINPID" ] && cleanup' EXIT

fail() { echo "FAIL: $1" >&2; exit 1; }
pass() { echo "ok: $1"; }

# Build a throwaway repo containing the script under test, plus fake
# docker/pnpm. Prints "<repo> <bindir> <gatedir>", all separate temp dirs.
# The caller registers them in SCRATCH (appending inside this function would
# be lost: it runs in a command substitution subshell).
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
case "$1" in
  fake-fast-gate) sleep 2; exit 0 ;;
  *) echo "unexpected pnpm script: $1" >&2; exit 9 ;;
esac
EOF
  chmod +x "$bin/pnpm"
  echo "$r $bin $g"
}

# Start a gate inside $1 with PATH $2 and gate dir $3, wait for it, set LOG.
start_and_wait() {
  local r="$1" bin="$2" g="$3" why="$4"
  ( cd "$r" && PATH="$bin:/usr/bin:/bin" JARVIS_GATE_DIR="$g" \
    JARVIS_PG_CONTAINER=fake-postgres \
    ./scripts/run-gate.sh start --gate fake-fast-gate >"$g/start.out" 2>&1 ) \
    || fail "$why: start failed"
  LOG="$(awk -F= '/^LOG=/ {print $2}' "$g/start.out")"
  [ -n "$LOG" ] || fail "$why: no LOG path from start"
  ( cd "$r" && PATH="$bin:/usr/bin:/bin" JARVIS_GATE_DIR="$g" \
    ./scripts/run-gate.sh wait --follow --log "$LOG" >/dev/null 2>&1 ) \
    || fail "$why: wait failed"
}

gate_status() {
  ( cd "$1" && PATH="$2:/usr/bin:/bin" JARVIS_GATE_DIR="$3" \
    ./scripts/run-gate.sh status --log "$LOG" )
}

# --- case A: clean tree records clean -------------------------------------
read R_A BIN_A G_A <<<"$(new_env)"
SCRATCH="$SCRATCH $R_A $BIN_A $G_A"
export JARVIS_PG_CONTAINER="fake-postgres"
HEAD_A="$("$REAL_GIT" -C "$R_A" rev-parse HEAD)"
start_and_wait "$R_A" "$BIN_A" "$G_A" "clean"
grep -q "^### COMMIT $HEAD_A$" "$LOG" || fail "clean: log missing tested commit"
grep -q '^### DIRTY  clean$' "$LOG" || fail "clean: log missing DIRTY clean"
STATUS_A="$(gate_status "$R_A" "$BIN_A" "$G_A")" || fail "clean: status failed"
echo "$STATUS_A" | grep -q "$HEAD_A" || fail "clean: status missing commit"
echo "$STATUS_A" | grep -qi 'tree clean' || fail "clean: status missing tree state"
pass "clean tree records commit and clean"

# --- case B: one modified + one untracked file -----------------------------
read R_B BIN_B G_B <<<"$(new_env)"
SCRATCH="$SCRATCH $R_B $BIN_B $G_B"
echo change >>"$R_B/file.txt"
echo new >"$R_B/untracked.txt"
start_and_wait "$R_B" "$BIN_B" "$G_B" "dirty"
grep -q '^### DIRTY  dirty (2 files)$' "$LOG" || fail "dirty: want 'dirty (2 files)'"
grep -qF '### +  M file.txt' "$LOG" || fail "dirty: modified file not listed"
grep -qF '### + ?? untracked.txt' "$LOG" || fail "dirty: untracked file not listed"
pass "dirty tree lists both changed files"

# --- case C: about two thousand files must not kill start ------------------
read R_C BIN_C G_C <<<"$(new_env)"
SCRATCH="$SCRATCH $R_C $BIN_C $G_C"
# Long names (~100KB of status): a few hundred short names fit in one pipe
# write and do not trip the SIGPIPE failure this case guards against.
for i in $(seq 1 2000); do : >"$R_C/load-$i-$(printf '%040d' 0)"; done
start_and_wait "$R_C" "$BIN_C" "$G_C" "large"
PTR="$(cat "$G_C"/*.current 2>/dev/null || true)"
[ "$PTR" = "$LOG" ] || fail "large: pointer [$PTR] is not this run [$LOG]"
grep -q '^### DIRTY  dirty (2000 files)$' "$LOG" || fail "large: want 'dirty (2000 files)'"
PLUS="$(grep -c '^### + ' "$LOG" || true)"
[ "$PLUS" -eq 51 ] || fail "large: want 50 listed + truncation line, got $PLUS plus-lines"
grep -qF '### + ... and 1950 more' "$LOG" || fail "large: truncation line missing"
pass "2000-file tree starts cleanly with a capped list"

# --- case D: failed git status records unknown, never clean ----------------
read R_D BIN_D G_D <<<"$(new_env)"
SCRATCH="$SCRATCH $R_D $BIN_D $G_D"
mkdir "$R_D/gitbin"
cat >"$R_D/gitbin/git" <<EOF
#!/usr/bin/env bash
for a in "\$@"; do
  if [ "\$a" = "status" ]; then echo "fake git: status unavailable" >&2; exit 128; fi
done
exec "$REAL_GIT" "\$@"
EOF
chmod +x "$R_D/gitbin/git"
echo change >>"$R_D/file.txt"
echo new >"$R_D/untracked.txt"
HEAD_D="$("$REAL_GIT" -C "$R_D" rev-parse HEAD)"
start_and_wait "$R_D" "$R_D/gitbin:$BIN_D" "$G_D" "gitfail"
grep -q "^### COMMIT $HEAD_D$" "$LOG" || fail "gitfail: commit should still record"
grep -q '^### DIRTY  unknown (status failed)$' "$LOG" \
  || fail "gitfail: want unknown, got: $(grep '^### DIRTY' "$LOG" || echo none)"
pass "failed status records unknown, not clean"

echo "run-gate commit receipt tests passed"
