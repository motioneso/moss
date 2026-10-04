#!/usr/bin/env bash
# Evidence receipt (#2462): start records an input fingerprint (commit +
# status + file contents, so same-files-dirty with different bytes hashes
# differently), toolchain versions, and database-server identity in the run
# log; status repeats the fingerprint. Each case builds a throwaway git
# repo and copies the script under test into it. Gate state and captures
# live outside the repo so they never pollute the status under test.
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
# docker/pnpm/node. Prints "<repo> <bindir> <gatedir>", all separate temp dirs.
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
  --version) echo "9.9.9-fake" ;;
  fake-fast-gate) sleep 2; exit 0 ;;
  db:migrate) exit 0 ;;
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

fp_of() { grep -m 1 '^### FINGERPRINT ' "$1" 2>/dev/null | awk '{print $3}' || true; }

# --- case A: clean tree writes fingerprint, toolchain, postgres identity --
read R_A BIN_A G_A <<<"$(new_env)"
SCRATCH="$SCRATCH $R_A $BIN_A $G_A"
start_and_wait "$R_A" "$BIN_A" "$G_A" "clean"
FP_A="$(fp_of "$LOG")"
case "$FP_A" in
  sha256:*) [ "${#FP_A}" -eq 71 ] || fail "clean: malformed fingerprint [$FP_A]" ;;
  *) fail "clean: want sha256 fingerprint, got [$FP_A]" ;;
esac
grep -q '^### TOOLCHAIN node v99.88.77-fake pnpm 9.9.9-fake$' "$LOG" \
  || fail "clean: toolchain line missing: $(grep '^### TOOLCHAIN' "$LOG" || echo none)"
grep -q '^### POSTGRES unknown' "$LOG" \
  || fail "clean: postgres should be unknown under fake docker"
SHORT_A="$(printf '%s' "$FP_A" | sed 's/^sha256://' | cut -c1-12)"
STATUS_A="$(gate_status "$R_A" "$BIN_A" "$G_A")" || fail "clean: status failed"
echo "$STATUS_A" | grep -qF "$SHORT_A" || fail "clean: status missing fingerprint $SHORT_A"
pass "clean tree records fingerprint, toolchain, postgres identity"
LOG_A="$LOG"

# --- case B: identical tree, identical fingerprint -------------------------
start_and_wait "$R_A" "$BIN_A" "$G_A" "clean-again"
FP_A2="$(fp_of "$LOG")"
[ "$FP_A2" = "$FP_A" ] || fail "determinism: [$FP_A] vs [$FP_A2] on identical tree"
pass "fingerprint is deterministic on an unchanged tree"

# --- case C: modified tracked + untracked file changes the fingerprint -----
read R_C BIN_C G_C <<<"$(new_env)"
SCRATCH="$SCRATCH $R_C $BIN_C $G_C"
start_and_wait "$R_C" "$BIN_C" "$G_C" "clean-baseline"
FP_CLEAN="$(fp_of "$LOG")"
echo change >>"$R_C/file.txt"
echo new >"$R_C/untracked.txt"
start_and_wait "$R_C" "$BIN_C" "$G_C" "dirty"
FP_DIRTY="$(fp_of "$LOG")"
[ -n "$FP_DIRTY" ] || fail "dirty: no fingerprint recorded"
[ "$FP_DIRTY" != "$FP_CLEAN" ] || fail "dirty: fingerprint unchanged by dirty inputs"
pass "dirty inputs change the fingerprint"

# --- case D: same dirty set, different bytes, different fingerprint --------
# A status-text-only hash would collide here: the exact hole being closed.
echo "different bytes" >"$R_C/untracked.txt"
echo more >>"$R_C/file.txt"
start_and_wait "$R_C" "$BIN_C" "$G_C" "redirty"
FP_DIRTY2="$(fp_of "$LOG")"
[ "$FP_DIRTY2" != "$FP_DIRTY" ] || fail "content: fingerprint blind to byte changes"
pass "byte changes under an identical dirty set change the fingerprint"

# --- case E: failed git status records unknown, never blocks --------------
read R_E BIN_E G_E <<<"$(new_env)"
SCRATCH="$SCRATCH $R_E $BIN_E $G_E"
mkdir "$R_E/gitbin"
cat >"$R_E/gitbin/git" <<EOF
#!/usr/bin/env bash
for a in "\$@"; do
  if [ "\$a" = "status" ]; then echo "fake git: status unavailable" >&2; exit 128; fi
done
exec "$REAL_GIT" "\$@"
EOF
chmod +x "$R_E/gitbin/git"
echo change >>"$R_E/file.txt"
start_and_wait "$R_E" "$R_E/gitbin:$BIN_E" "$G_E" "gitfail"
grep -q '^### FINGERPRINT unknown' "$LOG" \
  || fail "gitfail: want unknown fingerprint, got: $(grep '^### FINGERPRINT' "$LOG" || echo none)"
pass "failed status records unknown fingerprint without blocking start"

echo "run-gate evidence tests passed"
