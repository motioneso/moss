#!/usr/bin/env bash
# PreToolUse(Bash) guard: keep verification gates honest and off the shared database.
#
# Two blocks in one hook:
# 1. A piped gate masks its exit code. A shell pipeline reports the exit status
#    of the LAST command, so `pnpm verify:foundation | tail -20` exits 0 even
#    when every test failed. An agent then reads exit 0, reports "gate green"
#    in good faith, and the defect merges.
#
#    Measured 2026-07-27 over three weeks of transcripts: of 1,560 gate runs in this repo, 824 were
#    piped to tail/head and only 142 of those set pipefail — so 682 runs (44% of all gate runs)
#    could not have reported a failure. See the `verification-discipline` agent memory.
#
# 2. A bare database-touching command hits the shared dev database. Gates run
#    only through scripts/run-gate.sh, which points them at a throwaway server
#    (#2989). Anything the agent types directly — pnpm or direct vitest/tsx —
#    lands on jarv1s-postgres, which the dev instance also uses.
#
#    Matching is by command position, not substring: the command is split on
#    shell separators and each segment must START with the runner (after env
#    assignments), so `git commit -m "pnpm db:migrate"` and PR comment bodies
#    that merely quote a gate command are left alone. Runner flags between the
#    runner and the script (`pnpm -w`, `pnpm --filter x`) do not hide it.
#
#    Deliberate override: when Ben asks for a migration of the dev database
#    itself (not a gate), prefix the command with JARVIS_ALLOW_DIRECT_DB=1.
#    That token in command position disables this block — and only this block.
#
# Contract: stdin is the PreToolUse JSON payload. Exit 0 allows the call; exit 2 blocks it and
# sends stderr back to the model as the reason.
set -uo pipefail

payload=$(cat)

# jq is present in this repo's toolchain, but never hard-fail the hook on a missing dependency:
# a broken guard must not block every Bash call in the session.
command -v jq > /dev/null 2>&1 || exit 0

tool=$(printf '%s' "$payload" | jq -r '.tool_name // empty' 2> /dev/null)
[ "$tool" = "Bash" ] || exit 0

cmd=$(printf '%s' "$payload" | jq -r '.tool_input.command // empty' 2> /dev/null)
[ -n "$cmd" ] || exit 0

# Database-touching commands first (#2989). The hook only ever sees what the
# agent typed: the gate's own pnpm runs inside scripts/run-gate.sh, detached,
# never through the agent's Bash tool — so any database-touching command here
# is by definition NOT launched through run-gate.sh, and would hit the shared
# dev database. Blocked piped or bare, with or without pipefail: pipefail
# fixes the exit code but not the database. One plain line pointing at the
# skill.
db_override_re='(^|[;&|])[[:space:]]*JARVIS_ALLOW_DIRECT_DB=1([[:space:]]|$)'
db_override=0
if printf '%s' "$cmd" | grep -qE "$db_override_re"; then
  db_override=1
fi

# Runner flags that may sit between the runner and the script name, with an
# optional value (`pnpm -w`, `pnpm -s`, `pnpm --filter x`, `--silent`).
db_flags='([[:space:]]+(--filter([= ][[:space:]]*[^[:space:]]+)?|--[a-zA-Z][a-zA-Z-]*|-[a-zA-Z]+))*'
db_scripts='(verify:foundation|test:integration|test:uat-seed|db:migrate)([[:space:]]|$)'
db_runner_re="^(pnpm|npm|yarn|turbo|npx)${db_flags}[[:space:]]+(run[[:space:]]+)?${db_scripts}"
db_runner_vitest_re="^(pnpm|npm|yarn|turbo|npx)${db_flags}[[:space:]]+vitest[[:space:]]+run[[:space:]]+[^[:space:]]*(integration|uat/seed)"
db_vitest_re='^(npx[[:space:]]+)?(vitest|tsx)([[:space:]]+-[^[:space:]]+)*[[:space:]]+(run[[:space:]]+)?[^[:space:]]*(integration|uat/seed|test-integration\.ts|migrate\.ts)'

db_blocked=0
segments="$(printf '%s' "$cmd" | tr '|&;' '\n')"
while IFS= read -r seg; do
  # Leading `sudo`/wrappers and VAR=value assignments do not move the command
  # out of command position.
  seg="$(printf '%s' "$seg" | sed -E 's/^[[:space:]]+//; s/^(sudo|doas|env)[[:space:]]+//')"
  while printf '%s' "$seg" | grep -qE '^[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]+[[:space:]]+'; do
    seg="$(printf '%s' "$seg" | sed -E 's/^[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]+[[:space:]]+//')"
  done
  if printf '%s' "$seg" | grep -qE "$db_runner_re" ||
    printf '%s' "$seg" | grep -qE "$db_runner_vitest_re" ||
    printf '%s' "$seg" | grep -qE "$db_vitest_re"; then
    db_blocked=1
    break
  fi
done <<<"$segments"

if [ "$db_blocked" = "1" ] && [ "$db_override" = "0" ]; then
  echo "BLOCKED: database-touching tests and migrates run only through the verify-gate skill (scripts/run-gate.sh)." >&2
  exit 2
fi

# Explicit opt-outs for the pipe check below. Either construct makes the
# pipeline report the real failure, so the command is safe and the author has
# clearly thought about it. (Database-touching commands never reach this —
# they are blocked above with or without pipefail.)
case "$cmd" in
  *pipefail* | *PIPESTATUS*) exit 0 ;;
esac

# Neutralise `||` before scanning, so boolean OR is never mistaken for a pipe.
scan=${cmd//\|\|/ @@OR@@ }

# Match: a package-runner gate invocation, followed later on the same command by a real pipe.
# A pipe BEFORE the gate is fine (`echo x | pnpm test` still reports pnpm's status), which is
# why the gate token has to appear first in the pattern.
gate_re='(pnpm|npm|turbo)[[:space:]]+(run[[:space:]]+)?[a-z0-9:_-]*(verify|test|lint|typecheck|format|build|check|audit|migrate)[a-z0-9:_-]*[^|]*\|'

if printf '%s' "$scan" | grep -qE "$gate_re"; then
  cat >&2 <<'MSG'
BLOCKED: this pipes a verification gate into another command, which masks its exit code.

A pipeline reports the LAST command's status, so `pnpm lint | tail -20` exits 0 even when the
gate failed. Exit 0 here does not mean green.

Run it so the real status survives:

    pnpm lint > /tmp/lint.log 2>&1; echo "EXIT=$?"

then read the exit code, then read the log. If you genuinely need the pipe, put
`set -o pipefail;` in front of it, or test ${PIPESTATUS[0]} instead of $?.
MSG
  exit 2
fi

exit 0
