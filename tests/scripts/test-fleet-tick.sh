#!/usr/bin/env bash
# Tests for scripts/fleet/tick.sh. Everything external is stubbed with PATH
# shims (fleetctl, herdr, gh, claude, needs-ben, git ls-remote), so no network,
# no real agents, and no real record writes happen here.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tick="$repo_root/scripts/fleet/tick.sh"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/logs" "$tmp/needs-ben/queue" "$tmp/needs-ben/sent" "$tmp/needs-ben/replies"

export SHIM_LOG_DIR="$tmp/logs"
real_git="$(command -v git)"

# --- PATH shims ---------------------------------------------------------------

cat >"$tmp/bin/fleetctl" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$SHIM_LOG_DIR/fleetctl.log"
EOF

cat >"$tmp/bin/herdr" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$SHIM_LOG_DIR/herdr.log"
no_agents='{"result":{"agents":[]}}'
case "$1 $2" in
  "agent list") printf '%s\n' "${HERDR_AGENTS_JSON:-$no_agents}" ;;
  "pane list")  printf '%s\n' '{"result":{"panes":[{"pane_id":"w1:p1"}]}}' ;;
esac
EOF

cat >"$tmp/bin/gh" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$SHIM_LOG_DIR/gh.log"
no_items='{"items":[]}'
case "$1 $2" in
  "project item-list") printf '%s\n' "${GH_PROJECT_JSON:-$no_items}" ;;
  "issue develop")     printf '%s\n' "${GH_ISSUE_BRANCHES:-}" ;;
  "pr list")           printf '%s\n' "${GH_PR_LIST:-}" ;;
  "pr checks")         printf '%s\n' "${GH_CHECKS:-[]}" ;;
  "pr view")
    case "$*" in
      *"--json files"*)    printf '%s\n' "${GH_PR_FILES:-}" ;;
      *"--json comments"*) printf '%s\n' "${GH_PR_COMMENTS:-}" ;;
      *"--json state"*)    printf '%s\n' "${GH_PR_STATE:-OPEN}" ;;
    esac ;;
esac
EOF

cat >"$tmp/bin/claude" <<'EOF'
#!/usr/bin/env bash
echo "claude called" >> "$SHIM_LOG_DIR/claude.log"
printf '%s\n' "${CLAUDE_ANSWER:-PARK}"
EOF

cat >"$tmp/bin/other-judge" <<'EOF'
#!/usr/bin/env bash
echo "other-judge called" >> "$SHIM_LOG_DIR/other-judge.log"
printf '%s\n' "PARK"
EOF

cat >"$tmp/bin/needs-ben" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$SHIM_LOG_DIR/needs-ben.log"
EOF

# Match on the git SUBCOMMAND, never the whole argument string: paths in the
# arguments (this repo lives under .claude/worktrees/) would otherwise trip the
# worktree pattern and swallow unrelated calls like git config.
cat >"$tmp/bin/git" <<EOF
#!/usr/bin/env bash
if [ "\${1:-}" = "-C" ]; then sub="\${3:-}"; else sub="\${1:-}"; fi
case "\$sub" in
  ls-remote) printf '%s\n' "\${GIT_LSREMOTE_OUT:-}"; exit 0 ;;
  show-ref)  exit 1 ;;
  worktree)  echo "\$*" >> "\$SHIM_LOG_DIR/git.log"; exit 0 ;;
  *)         exec "$real_git" "\$@" ;;
esac
EOF

chmod +x "$tmp/bin/"*

# --- helpers --------------------------------------------------------------------

template="$tmp/brief-template.md"
printf '%s\n' '# Build issue ${ISSUE}' 'Tier: ${TIER}. Branch: ${BRANCH}. Worktree: ${WORKTREE}.' > "$template"

now_iso="$(date -Iseconds)"

new_state() { # fresh state dir, echoes its path
  local d
  d="$(mktemp -d "$tmp/state-XXXX")"
  mkdir -p "$d/tasks"
  echo "$d"
}

write_record() { # <state-dir> <issue> <json>
  printf '%s\n' "$3" > "$1/tasks/$2.json"
}

clear_logs() {
  rm -f "$SHIM_LOG_DIR"/*.log
}

run_tick() { # <state-dir> [extra env KEY=VAL...]; dry-run unless FLEET_DRY_RUN passed
  local state="$1"
  shift
  PATH="$tmp/bin:$PATH" \
    JARV1S_FLEET_STATE="$state" \
    FLEET_BRIEF_TEMPLATE="$template" \
    NEEDS_BEN_DIR="$tmp/needs-ben" \
    FLEET_DRY_RUN=1 \
    env "$@" "$tick"
}

run_tick_live() { # non-dry: everything still stubbed via PATH shims
  local state="$1"
  shift
  PATH="$tmp/bin:$PATH" \
    JARV1S_FLEET_STATE="$state" \
    FLEET_BRIEF_TEMPLATE="$template" \
    NEEDS_BEN_DIR="$tmp/needs-ben" \
    env "$@" "$tick"
}

pass() { echo "PASS: $1"; }

# --- 1. STOP file: exit 0 without acting ------------------------------------------

state="$(new_state)"
write_record "$state" 101 '{"issue":101,"status":"queued","tier":"routine","relays":0,"spec":"docs/x.md"}'
touch "$state/STOP"
out="$(run_tick "$state")"
[ -z "$out" ]
pass "STOP file exits silently without acting"

# --- 2. queued dispatches when under cap ------------------------------------------

state="$(new_state)"
write_record "$state" 101 '{"issue":101,"status":"queued","tier":"routine","relays":0,"spec":"docs/x.md"}'
out="$(run_tick "$state")"
grep -q "DRY: git .*worktree add" <<<"$out"
grep -q "DRY: herdr agent start fleet-lane-101" <<<"$out"
grep -q "DRY: fleetctl set 101 status=building" <<<"$out"
pass "queued lane dispatches when under cap and budget"

# --- 3. queued does not dispatch at the lane cap -----------------------------------

state="$(new_state)"
for i in 1 2 3; do
  write_record "$state" "20$i" "{\"issue\":20$i,\"status\":\"building\",\"agent\":\"a$i\",\"relays\":0,\"updated_at\":\"$now_iso\"}"
done
write_record "$state" 101 '{"issue":101,"status":"queued","tier":"routine","relays":0,"spec":"docs/x.md"}'
out="$(run_tick "$state")"
if grep -q "worktree add" <<<"$out"; then false; fi
pass "queued lane does not dispatch when 3 lanes are live"

# --- 4. queued does not dispatch when the spawn budget is spent --------------------

state="$(new_state)"
write_record "$state" 101 '{"issue":101,"status":"queued","tier":"routine","relays":0,"spec":"docs/x.md"}'
for i in $(seq 1 12); do
  printf '{"ts":"%s","issue":%s,"msg":"spawn: build agent a%s"}\n' "$now_iso" "$i" "$i"
done > "$state/log.jsonl"
out="$(run_tick "$state")"
if grep -q "worktree add" <<<"$out"; then false; fi
pass "queued lane does not dispatch when 12 spawns already happened tonight"

# --- 5. qa-green security tier parks for sign-off ----------------------------------

state="$(new_state)"
write_record "$state" 105 '{"issue":105,"status":"qa-green","tier":"security","pr":55,"relays":0,"spec":"docs/x.md"}'
out="$(GH_PR_FILES="apps/api/src/thing.ts" GH_PR_COMMENTS="" run_tick "$state")"
grep -q "fleetctl set 105 status=blocked" <<<"$out"
grep -qi "sign-off" <<<"$out"
if grep -q "pr merge" <<<"$out"; then false; fi
pass "qa-green security tier parks instead of merging"

# --- 6. qa-green user-facing without live-path proof parks --------------------------

state="$(new_state)"
write_record "$state" 106 '{"issue":106,"status":"qa-green","tier":"routine","pr":56,"relays":0,"spec":"docs/x.md"}'
out="$(GH_PR_FILES="apps/web/src/App.tsx" GH_PR_COMMENTS="looks good to me" run_tick "$state")"
grep -q "code-complete, unverified" <<<"$out"
if grep -q "pr merge" <<<"$out"; then false; fi
pass "qa-green user-facing PR without proof parks as code-complete, unverified"

# --- 6b. qa-green user-facing WITH proof merges on auto ----------------------------

state="$(new_state)"
write_record "$state" 107 '{"issue":107,"status":"qa-green","tier":"routine","pr":57,"relays":0,"spec":"docs/x.md"}'
out="$(GH_PR_FILES="apps/web/src/App.tsx" GH_PR_COMMENTS="Live-path proof: exercised on the dev box, screenshots attached." run_tick "$state")"
grep -q "DRY: gh pr merge 57 --squash --auto" <<<"$out"
pass "qa-green with live-path proof enables auto-merge (squash, never admin)"

# --- 7. relays >= 2 parks with needs re-slice ---------------------------------------

state="$(new_state)"
write_record "$state" 110 "{\"issue\":110,\"status\":\"building\",\"agent\":\"a\",\"relays\":2,\"updated_at\":\"$now_iso\"}"
out="$(run_tick "$state")"
grep -q "needs re-slice" <<<"$out"
pass "a lane relayed twice parks with reason needs re-slice"

# --- 8. expired DEPUTY file means no deputy call ------------------------------------

state="$(new_state)"
write_record "$state" 108 '{"issue":108,"status":"blocked","tier":"routine","blocked_reason":"stuck on a decision","relays":0}'
printf 'until=%s\n' "$(date -d '1 hour ago' +%Y-%m-%dT%H:%M)" > "$state/DEPUTY"
echo "108: stuck on a decision" > "$tmp/needs-ben/sent/entry-108.msg"
touch -d '30 minutes ago' "$tmp/needs-ben/sent/entry-108.msg"
out="$(run_tick "$state")"
if grep -qi "deputy" <<<"$out"; then false; fi
pass "expired DEPUTY file means no deputy call"

# --- 8b. active DEPUTY file does trigger the deputy call ----------------------------

printf 'until=%s\n' "$(date -d '1 hour' +%Y-%m-%dT%H:%M)" > "$state/DEPUTY"
out="$(run_tick "$state")"
grep -q "DRY: claude -p \[deputy for lane 108" <<<"$out"
pass "active DEPUTY file triggers the deputy call after 20 minutes with no reply"

# --- 8c. the judgment command is swappable, no model name baked in ------------------

out="$(run_tick "$state" FLEET_JUDGE_CMD='some-other-provider run')"
grep -q "DRY: some-other-provider run \[deputy for lane 108" <<<"$out"
if grep -qiE "claude-(fable|opus|sonnet|haiku)" <<<"$out"; then false; fi
pass "deputy honours FLEET_JUDGE_CMD and pins no model name"

# --- 9. intake adopts an issue with an open PR at pr-open ---------------------------

state="$(new_state)"
clear_logs
project_json='{"items":[{"status":"Ready","labels":["task"],"content":{"type":"Issue","number":201,"title":"Add widget","body":"plain feature"}}]}'
run_tick_live "$state" GH_PROJECT_JSON="$project_json" GH_ISSUE_BRANCHES=$'feat/201-widget\trepo' GH_PR_LIST="77" CLAUDE_ANSWER="ROUTINE" >/dev/null
grep -q "add 201 spec=https://github.com/.*/issues/201 tier=routine" "$SHIM_LOG_DIR/fleetctl.log"
grep -q "set 201 status=pr-open pr=77 branch=feat/201-widget" "$SHIM_LOG_DIR/fleetctl.log"
pass "intake adopts an issue with an open PR at pr-open"

# --- 10. intake adopts an issue with a branch but no PR at queued -------------------

state="$(new_state)"
clear_logs
# Real board value is "In progress" with a lowercase p; the match must not care.
project_json='{"items":[{"status":"In progress","labels":["task"],"content":{"type":"Issue","number":202,"title":"Fix export","body":"touches exports"}}]}'
run_tick_live "$state" GH_PROJECT_JSON="$project_json" GH_ISSUE_BRANCHES=$'fix/202-export\trepo' GH_PR_LIST="" CLAUDE_ANSWER="SENSITIVE" >/dev/null
grep -q "add 202 spec=https://github.com/.*/issues/202 tier=sensitive" "$SHIM_LOG_DIR/fleetctl.log"
grep -q "set 202 branch=fix/202-export" "$SHIM_LOG_DIR/fleetctl.log"
grep -q "resume brief" "$SHIM_LOG_DIR/fleetctl.log"
pass "intake adopts an issue with a branch but no PR at queued, marked for resume"

# --- 11. intake skips only a lane whose agent is live right now ---------------------

state="$(new_state)"
clear_logs
project_json='{"items":[{"status":"Ready","labels":["task"],"content":{"type":"Issue","number":203,"title":"Tidy thing","body":"x"}}]}'
agents_json='{"result":{"agents":[{"name":"mine-203","pane_id":"w1:p9"}]}}'
run_tick_live "$state" GH_PROJECT_JSON="$project_json" HERDR_AGENTS_JSON="$agents_json" CLAUDE_ANSWER="ROUTINE" >/dev/null
grep -q "log 203 intake skipped" "$SHIM_LOG_DIR/fleetctl.log"
if grep -q "add 203" "$SHIM_LOG_DIR/fleetctl.log"; then false; fi
pass "intake skips a lane only while its agent is live, and logs it"

# --- 12. deputy CAN sign off a security-tier merge ----------------------------------

state="$(new_state)"
clear_logs
write_record "$state" 301 '{"issue":301,"status":"blocked","tier":"security","pr":88,"blocked_reason":"security tier: merge needs Ben sign-off","relays":0}'
printf 'until=%s\n' "$(date -d '1 hour' +%Y-%m-%dT%H:%M)" > "$state/DEPUTY"
echo "301: security tier: merge needs Ben sign-off" > "$tmp/needs-ben/sent/entry-301.msg"
touch -d '30 minutes ago' "$tmp/needs-ben/sent/entry-301.msg"
run_tick_live "$state" CLAUDE_ANSWER="MERGE" >/dev/null
grep -q "pr merge 88 --squash --auto" "$SHIM_LOG_DIR/gh.log"
grep -q "set 301 status=merging" "$SHIM_LOG_DIR/fleetctl.log"
grep -q "DEPUTY security merge sign-off" "$SHIM_LOG_DIR/fleetctl.log"
pass "deputy can sign off a security-tier merge, flagged for the morning board"

# --- 13. deputy MERGE that would cross the hard floor resolves to park ---------------

state="$(new_state)"
clear_logs
write_record "$state" 302 '{"issue":302,"status":"blocked","tier":"routine","pr":89,"blocked_reason":"code-complete, unverified","relays":0}'
printf 'until=%s\n' "$(date -d '1 hour' +%Y-%m-%dT%H:%M)" > "$state/DEPUTY"
echo "302: code-complete, unverified" > "$tmp/needs-ben/sent/entry-302.msg"
touch -d '30 minutes ago' "$tmp/needs-ben/sent/entry-302.msg"
run_tick_live "$state" CLAUDE_ANSWER="MERGE" >/dev/null
if grep -q "pr merge 89" "$SHIM_LOG_DIR/gh.log"; then false; fi
grep -q "MERGE refused" "$SHIM_LOG_DIR/fleetctl.log"
pass "deputy cannot merge past the live-path check; the lane stays parked"

# --- 14. settings.json is read, and the environment still wins ---------------------

state="$(new_state)"
write_record "$state" 401 '{"issue":401,"status":"queued","tier":"routine","relays":0,"spec":"docs/x.md"}'
printf '{"laneCap": 0}\n' > "$state/settings.json"
out="$(run_tick "$state")"
if grep -q "worktree add" <<<"$out"; then false; fi
pass "laneCap from settings.json is honoured (0 lanes means nothing dispatches)"

out="$(run_tick "$state" FLEET_LANE_CAP=1)"
grep -q "DRY: herdr agent start fleet-lane-401" <<<"$out"
pass "an environment variable still overrides the settings file"

# --- 14b. judgeCmd from settings drives judgment calls ------------------------------

state="$(new_state)"
stale_iso="$(date -Iseconds -d '40 minutes ago')"
write_record "$state" 402 "{\"issue\":402,\"status\":\"building\",\"agent\":\"gone-agent\",\"relays\":0,\"updated_at\":\"$stale_iso\"}"
printf '{"judgeCmd": "other-judge run"}\n' > "$state/settings.json"
run_tick_live "$state" >/dev/null
grep -q "other-judge called" "$SHIM_LOG_DIR/other-judge.log"
pass "judgeCmd from settings.json drives the dead-lane judgment call"

# --- 14c. a malformed settings file falls back to the built-in numbers --------------

state="$(new_state)"
write_record "$state" 403 '{"issue":403,"status":"queued","tier":"routine","relays":0,"spec":"docs/x.md"}'
printf '{"laneCap": "lots"}\n' > "$state/settings.json"
out="$(run_tick "$state")"
grep -q "DRY: herdr agent start fleet-lane-403" <<<"$out"
pass "a non-numeric laneCap falls back to the built-in cap instead of breaking the tick"

echo "fleet tick tests passed"
