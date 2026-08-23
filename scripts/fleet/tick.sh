#!/usr/bin/env bash
# Fleet daemon tick: one pass over every lane record, advance each one step, exit.
# Spec: docs/superpowers/specs/2026-08-23-fleet-daemon.md (issue #1894).
# Runs as a systemd oneshot on a 1-minute timer (see scripts/ops/systemd/).
#
# Safety rails, checked before anything else every tick:
#   - STOP file in the state dir: exit immediately, do nothing, say nothing.
#   - Spawn budget: at most 12 agent spawns per night (since 18:00 local); at the
#     cap, nothing new is dispatched.
#   - Deputy switch (deputyEnabled in settings.json): lets a one-shot model call
#     stand in for Ben on parked lanes, within a hard floor it may never cross.
#
# FLEET_DRY_RUN=1 prints every externally-visible action as "DRY: <command>"
# instead of running it (worktree add, herdr, gh writes, needs-ben, claude -p,
# and all record writes through fleetctl). Read-only queries (gh pr checks,
# gh pr view, herdr agent list, herdr pane list) still run so the state machine
# can be exercised against stubbed commands in tests.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
STATE_DIR="${JARV1S_FLEET_STATE:-$HOME/.local/state/jarv1s-fleet}"
TASKS_DIR="$STATE_DIR/tasks"
LOG_FILE="$STATE_DIR/log.jsonl"
BRIEFS_DIR="$STATE_DIR/briefs"
BRIEF_TEMPLATE="${FLEET_BRIEF_TEMPLATE:-$SCRIPT_DIR/brief-template.md}"
NEEDS_BEN_DIR="${NEEDS_BEN_DIR:-$HOME/.needs-ben}"
DRY="${FLEET_DRY_RUN:-0}"
# Configuration precedence, for every value below: environment variable wins,
# then settings.json in the state folder (written by the launcher's setup
# questions), then a built-in fallback that matches the daemon's original
# behaviour. The environment path exists so the service can be driven directly.
SETTINGS_FILE="$STATE_DIR/settings.json"

settings_get() { # <jq path, e.g. .laneCap> -> value or empty
  [ -f "$SETTINGS_FILE" ] || return 0
  jq -r "$1 // empty" "$SETTINGS_FILE" 2>/dev/null
}

int_or() { # <value> <fallback> -> the value if it is a whole number, else the fallback
  case "${1:-}" in
    '' | *[!0-9]*) echo "$2" ;;
    *) echo "$1" ;;
  esac
}

LANE_CAP="$(int_or "${FLEET_LANE_CAP:-$(settings_get '.laneCap')}" 3)"
SPAWN_BUDGET="$(int_or "${FLEET_SPAWN_BUDGET:-$(settings_get '.spawnBudget')}" 12)"
STALE_SECONDS=$((30 * 60))
DEPUTY_WAIT_SECONDS="$(int_or "${FLEET_DEPUTY_WAIT_SECONDS:-$(settings_get '.deputyWaitSeconds')}" $((20 * 60)))"
# Every judgment shell-out goes through one command so no provider or model
# name is baked into the fleet. The default runs the local Claude CLI on
# whatever model it is configured to use; override to point at another
# provider. Word-splitting here is deliberate -- the value is a command.
JUDGE_CMD="${FLEET_JUDGE_CMD:-$(settings_get '.judgeCmd')}"
JUDGE_CMD="${JUDGE_CMD:-claude -p}"

tier_model() { # <tier> -> model for this kind of work, or empty for "CLI default"
  if [ -n "${FLEET_BUILD_MODEL:-}" ]; then echo "$FLEET_BUILD_MODEL"; return; fi
  settings_get ".buildModels.\"$1\".model"
}

tier_effort() { # <tier> -> effort level, or empty for "do not pass one"
  if [ -n "${FLEET_BUILD_EFFORT:-}" ]; then echo "$FLEET_BUILD_EFFORT"; return; fi
  # A model pinned by environment does not inherit the settings file's effort:
  # that effort was chosen for whatever model the file names, and pairing it
  # with a hand-pinned model silently misconfigures the spawn. Pin both or
  # neither; pinning only the model falls back to the CLI's own default.
  if [ -n "${FLEET_BUILD_MODEL:-}" ]; then return; fi
  settings_get ".buildModels.\"$1\".effort"
}

NOW_EPOCH="$(date +%s)"

# --- rails -------------------------------------------------------------------

[ -f "$STATE_DIR/STOP" ] && exit 0
[ -d "$TASKS_DIR" ] || exit 0
cd "$REPO_ROOT" || exit 1
mkdir -p "$BRIEFS_DIR"

# fleetctl is the only writer of lane records. Prefer a fleetctl on PATH (tests
# stub one), otherwise run the real CLI from this repo.
if command -v fleetctl >/dev/null 2>&1; then
  FLEETCTL=(fleetctl)
else
  FLEETCTL=(node "$SCRIPT_DIR/fleetctl.mjs")
fi

# Record writes. In dry-run these print instead of executing.
fctl() {
  if [ "$DRY" = "1" ]; then
    echo "DRY: fleetctl $*"
  else
    "${FLEETCTL[@]}" "$@"
  fi
}

# Externally-visible actions (anything that changes the world outside the state
# dir). In dry-run these print instead of executing.
act() {
  if [ "$DRY" = "1" ]; then
    echo "DRY: $*"
  else
    "$@"
  fi
}

iso_to_epoch() {
  date -d "$1" +%s 2>/dev/null || echo 0
}

# Spawn budget window starts at the most recent 18:00 local time.
budget_cutoff_epoch() {
  local day
  if [ "$(date +%H)" -ge 18 ]; then day="$(date +%F)"; else day="$(date -d yesterday +%F)"; fi
  date -d "$day 18:00" +%s
}

count_spawns_tonight() {
  local cutoff count ts
  cutoff="$(budget_cutoff_epoch)"
  count=0
  if [ -f "$LOG_FILE" ]; then
    while IFS= read -r ts; do
      [ -n "$ts" ] || continue
      if [ "$(iso_to_epoch "$ts")" -ge "$cutoff" ]; then count=$((count + 1)); fi
    done < <(jq -r 'select(((.msg // .message // "") | startswith("spawn"))) | (.ts // .timestamp // "")' "$LOG_FILE" 2>/dev/null)
  fi
  echo "$count"
}

SPAWNS_TONIGHT="$(count_spawns_tonight)"

budget_available() {
  [ "$SPAWNS_TONIGHT" -lt "$SPAWN_BUDGET" ]
}

note_spawn() {
  SPAWNS_TONIGHT=$((SPAWNS_TONIGHT + 1))
}

# Deputy switch (Ben's ruling, 2026-08-23): a plain on/off setting with no
# time element, replacing the old expiring DEPUTY marker file. Off unless
# deputyEnabled is true in settings.json or FLEET_DEPUTY_ENABLED=true in the
# environment. The launcher shows this state on screen at all times; the
# hard floor below is unaffected by it.
DEPUTY_ACTIVE=0
deputy_enabled="${FLEET_DEPUTY_ENABLED:-$(settings_get '.deputyEnabled')}"
[ "$deputy_enabled" = "true" ] && DEPUTY_ACTIVE=1

# --- shared helpers ------------------------------------------------------------

# Memory floor (spec: 4 GB). The fleet degrades instead of pushing the box
# into swap at 4am: below the floor no new agent starts, and the tick says
# so and carries on. An unreadable source fails open -- a box where free
# memory cannot be read should not silently stop the fleet.
MEMINFO_SOURCE="${FLEET_MEMINFO:-/proc/meminfo}"
MEMORY_FLOOR_MB="$(int_or "${FLEET_MEMORY_FLOOR_MB:-$(settings_get '.memoryFloorMb')}" 4096)"

memory_ok() {
  local kb
  [ "$MEMORY_FLOOR_MB" -gt 0 ] || return 0
  kb="$(awk '/^MemAvailable:/ {print $2}' "$MEMINFO_SOURCE" 2>/dev/null)"
  case "$kb" in '' | *[!0-9]*) return 0 ;; esac
  [ $((kb / 1024)) -ge "$MEMORY_FLOOR_MB" ]
}

refuse_spawn_low_memory() { # <issue>
  fctl log "$1" "not starting an agent: free memory is below the $MEMORY_FLOOR_MB MB floor; will try again next tick"
}

lane_log_tail() { # <issue> [n]
  local issue="$1" n="${2:-20}"
  [ -f "$LOG_FILE" ] || return 0
  jq -c --argjson n "$issue" 'select((.issue // .task // -1) == $n)' "$LOG_FILE" 2>/dev/null | tail -n "$n"
}

lane_log_msgs() { # <issue> -> just the message text
  local issue="$1"
  [ -f "$LOG_FILE" ] || return 0
  jq -r --argjson n "$issue" 'select((.issue // .task // -1) == $n) | (.msg // .message // "")' "$LOG_FILE" 2>/dev/null
}

herdr_agent_names() {
  herdr agent list 2>/dev/null | jq -r '.result.agents[]?.name // empty' 2>/dev/null
}

# One-shot judgment call. Prompt is plain English: the question, the record, the
# last 20 log lines for this lane, and the exact answer format. First line of
# the reply must be one of the allowed words; anything else is treated as no
# ruling. Dry-run prints the call and returns no ruling.
judgment_call() { # <issue> <record-json> <options e.g. 'RESTART or PARK'> <question>
  local issue="$1" record="$2" options="$3" question="$4"
  local prompt ruling
  prompt="$question

Answer with a SINGLE first line containing exactly one word: $options. You may explain after the first line, but only the first line is read.

Lane record:
$record

Last 20 log lines for this lane:
$(lane_log_tail "$issue")"
  if [ "$DRY" = "1" ]; then
    echo "DRY: $JUDGE_CMD [judgment for lane $issue: $question]"
    echo ""
    return 0
  fi
  # shellcheck disable=SC2086 # JUDGE_CMD is a command, splitting is intended
  ruling="$($JUDGE_CMD "$prompt" 2>/dev/null | head -n1 | tr -d '\r' | awk '{print toupper($1)}')"
  fctl log "$issue" "judgment question: $question"
  fctl log "$issue" "judgment ruling: ${ruling:-<no answer>}"
  echo "$ruling"
}

# Render the build brief from the template by replacing ${NAME} placeholders.
render_brief() { # <template> <out> ISSUE SPEC TIER BRANCH WORKTREE PR AGENT ROUND
  local template="$1" out="$2"
  local ISSUE="$3" SPEC="$4" TIER="$5" BRANCH="$6" WORKTREE="$7" PR="$8" AGENT="$9" ROUND="${10}"
  local text
  text="$(cat "$template")"
  text="${text//\$\{ISSUE\}/$ISSUE}"
  text="${text//\$\{SPEC\}/$SPEC}"
  text="${text//\$\{TIER\}/$TIER}"
  text="${text//\$\{BRANCH\}/$BRANCH}"
  text="${text//\$\{WORKTREE\}/$WORKTREE}"
  text="${text//\$\{PR\}/$PR}"
  text="${text//\$\{AGENT\}/$AGENT}"
  text="${text//\$\{ROUND\}/$ROUND}"
  printf '%s\n' "$text" > "$out"
}

# Spawn a Claude agent in a fresh herdr pane pointed at a brief file.
spawn_agent() { # <name> <cwd> <brief-path> <tier>
  local name="$1" cwd="$2" brief="$3" tier="${4:-routine}"
  local model effort
  local model_args=()
  model="$(tier_model "$tier")"
  effort="$(tier_effort "$tier")"
  [ -n "$model" ] && model_args+=(--model "$model")
  [ -n "$effort" ] && model_args+=(--effort "$effort")
  local boot="You are a fleet lane agent. Read and follow the brief at $brief exactly. Report status in plain English, no jargon, and pass that rule to anything you spawn."
  if [ "$DRY" = "1" ]; then
    echo "DRY: herdr pane split <base-pane> --direction down --cwd $cwd --no-focus"
    echo "DRY: herdr agent start $name --kind claude --pane <new-pane> -- ${model_args[*]} --permission-mode bypassPermissions \"$boot\""
    return 0
  fi
  local base_pane new_pane
  base_pane="$(herdr pane list 2>/dev/null | jq -r '.result.panes[0].pane_id // empty' 2>/dev/null)"
  if [ -z "$base_pane" ]; then
    echo "fleet-tick: no herdr pane available to split for $name" >&2
    return 1
  fi
  new_pane="$(herdr pane split "$base_pane" --direction down --cwd "$cwd" --no-focus 2>/dev/null | jq -r '.result.pane_id // .result.pane.pane_id // empty' 2>/dev/null)"
  if [ -z "$new_pane" ]; then
    echo "fleet-tick: pane split failed for $name" >&2
    return 1
  fi
  if ! herdr agent start "$name" --kind claude --pane "$new_pane" -- "${model_args[@]}" --permission-mode bypassPermissions "$boot" >/dev/null 2>&1; then
    echo "fleet-tick: herdr agent start failed for $name" >&2
    return 1
  fi
  return 0
}

needs_ben_entry_file() { # <issue> -> path of an existing entry, if any
  local issue="$1"
  grep -rls -- "${issue}:" "$NEEDS_BEN_DIR/queue" "$NEEDS_BEN_DIR/sent" 2>/dev/null | head -n1
}

needs_ben_reply_exists() { # <issue>
  local issue="$1"
  grep -rqs -- "$issue" "$NEEDS_BEN_DIR/replies" 2>/dev/null
}

ensure_needs_ben() { # <issue> <reason>
  local issue="$1" reason="$2"
  if [ -z "$(needs_ben_entry_file "$issue")" ]; then
    act needs-ben fleet-daemon "$issue: $reason"
    # Copy the question onto the lane record so the fleet screen can show it
    # without reading the needs-ben folder. Written once, when the question
    # is first filed, so the asked-at clock stays honest.
    fctl set "$issue" "question=$reason" "questionAskedAt=$(date -Iseconds)"
  fi
}

pr_changed_files() { # <pr>
  gh pr view "$1" --json files --jq '.files[].path' 2>/dev/null
}

pr_comment_bodies() { # <pr>
  gh pr view "$1" --json comments --jq '.comments[].body' 2>/dev/null
}

USER_FACING_RE='^(apps/web|packages/ui)/|^modules/[^/]+/(ui|web|frontend)/'

is_user_facing() { # <spec-path> <pr>
  local spec="$1" pr="$2"
  if grep -Eq "$USER_FACING_RE" <<<"$spec"; then return 0; fi
  if [ -n "$pr" ] && [ "$pr" != "null" ]; then
    if pr_changed_files "$pr" | grep -Eq "$USER_FACING_RE"; then return 0; fi
  fi
  return 1
}

# --- intake: the daemon loads its own queue from GitHub -------------------------

FLEET_PROJECT_NUMBER="${FLEET_PROJECT_NUMBER:-2}"
FLEET_PROJECT_OWNER="${FLEET_PROJECT_OWNER:-@me}"

# One-shot tier call: reads the issue title/body, answers a single word.
intake_tier() { # <issue> <title> <body>
  local issue="$1" title="$2" body="$3"
  local prompt tier
  prompt="Assign a risk tier to this Jarv1s task issue. Mechanical triggers: anything touching auth, RLS, secrets, or migrations = SECURITY; shared tables, exports, or job payloads = SENSITIVE; everything else = ROUTINE. When in doubt, pick the higher tier.

Answer with a SINGLE first line containing exactly one word: SECURITY, SENSITIVE, or ROUTINE. Only the first line is read.

Issue #$issue: $title

$(head -c 4000 <<<"$body")"
  # shellcheck disable=SC2086 # JUDGE_CMD is a command, splitting is intended
  tier="$($JUDGE_CMD "$prompt" 2>/dev/null | head -n1 | tr -d '\r' | awk '{print tolower($1)}')"
  case "$tier" in
    security|sensitive|routine) echo "$tier" ;;
    *) echo "security" ;; # unreadable answer = doubt = highest tier
  esac
}

# The GitHub web URL for an issue, derived from the repo's own remote.
issue_url() { # <issue number>
  local remote owner_repo
  remote="$(git -C "$REPO_ROOT" config --get remote.origin.url 2>/dev/null)"
  owner_repo="$(sed -E 's#^(git@github\.com:|https://github\.com/)##; s#\.git$##' <<<"$remote")"
  if [ -n "$owner_repo" ]; then
    echo "https://github.com/$owner_repo/issues/$1"
  else
    echo "issue-#$1"
  fi
}

intake() {
  if [ "$DRY" = "1" ]; then
    echo "DRY: gh project item-list $FLEET_PROJECT_NUMBER --owner $FLEET_PROJECT_OWNER --format json (intake: find Ready/In Progress task issues with no record)"
    echo "DRY: $JUDGE_CMD [intake: assign a risk tier per new issue]"
    return 0
  fi
  local items row n title body tier branch pr
  items="$(gh project item-list "$FLEET_PROJECT_NUMBER" --owner "$FLEET_PROJECT_OWNER" --format json --limit 200 2>/dev/null)"
  [ -n "$items" ] || return 0
  while IFS= read -r row; do
    [ -n "$row" ] || continue
    n="$(jq -r '.content.number // empty' <<<"$row")"
    [ -n "$n" ] || continue
    [ -f "$TASKS_DIR/$n.json" ] && continue # already has a record: idempotent
    title="$(jq -r '.content.title // .title // ""' <<<"$row")"
    body="$(jq -r '.content.body // ""' <<<"$row")"
    # The only hands-off case: an agent for this lane is live right now.
    # Adopting a lane someone is actively working would double-drive it.
    if herdr_agent_names | grep -q -- "$n"; then
      fctl log "$n" "intake skipped: an agent for issue #$n is live right now; re-check next tick"
      continue
    fi
    # Started-but-unfinished work is adopted, not skipped: find its branch and PR.
    branch="$(gh issue develop --list "$n" 2>/dev/null | head -n1 | cut -f1)"
    if [ -z "$branch" ]; then
      branch="$(git ls-remote --heads origin "*${n}*" 2>/dev/null | head -n1 | sed 's|.*refs/heads/||')"
    fi
    pr=""
    if [ -n "$branch" ]; then
      pr="$(gh pr list --head "$branch" --state open --json number --jq '.[0].number // empty' 2>/dev/null)"
    fi
    tier="$(intake_tier "$n" "$title" "$body")"
    # fleetctl add only accepts spec= and tier= (and requires spec); everything
    # else goes through set. Board issues have no spec file, so the issue URL
    # is the spec of record for an adopted lane.
    spec_url="$(issue_url "$n")"
    if [ -n "$pr" ]; then
      fctl add "$n" "spec=$spec_url" "tier=$tier"
      fctl set "$n" status=pr-open "pr=$pr" "branch=$branch"
      fctl log "$n" "intake: adopted issue #$n at pr-open (open PR #$pr on branch $branch), tier $tier"
    elif [ -n "$branch" ]; then
      fctl add "$n" "spec=$spec_url" "tier=$tier"
      fctl set "$n" "branch=$branch"
      fctl log "$n" "intake: adopted issue #$n at queued with existing branch $branch (dispatch will use a resume brief), tier $tier"
    else
      fctl add "$n" "spec=$spec_url" "tier=$tier"
      fctl log "$n" "intake: queued issue #$n fresh, tier $tier"
    fi
  done < <(jq -c '.items[]?
      | select((.content.type // "") == "Issue")
      # Compare case-insensitively: the real board column is "In progress"
      # (lowercase p), and an exact "In Progress" match would skip every
      # started task.
      | select(((.status // "") | ascii_downcase) as $s | $s == "ready" or $s == "in progress")
      | select(((.labels // []) | map(ascii_downcase) | index("task")) != null)' <<<"$items" 2>/dev/null)
}

# --- one function per status ----------------------------------------------------

handle_queued() { # <issue> <record>
  local issue="$1" record="$2"
  if [ "$LIVE_LANES" -ge "$LANE_CAP" ]; then
    return 0
  fi
  if ! budget_available; then
    return 0
  fi
  if ! memory_ok; then
    refuse_spawn_low_memory "$issue"
    return 0
  fi
  if [ ! -f "$BRIEF_TEMPLATE" ]; then
    fctl log "$issue" "dispatch failed: brief template missing at $BRIEF_TEMPLATE; lane stays queued"
    return 0
  fi
  local spec tier branch worktree agent brief resume
  spec="$(jq -r '.spec // ""' <<<"$record")"
  tier="$(jq -r '.tier // "routine"' <<<"$record")"
  branch="$(jq -r '.branch // empty' <<<"$record")"
  [ -n "$branch" ] || branch="fleet/lane-$issue"
  worktree="$REPO_ROOT/.claude/worktrees/fleet-lane-$issue"
  agent="fleet-lane-$issue"
  brief="$BRIEFS_DIR/brief-$issue-build.md"
  # Adopted lane: the branch already exists on origin, so the agent resumes it
  # instead of starting over.
  resume=0
  if [ -n "$(git -C "$REPO_ROOT" ls-remote --heads origin "$branch" 2>/dev/null | head -n1)" ]; then
    resume=1
  fi
  render_brief "$BRIEF_TEMPLATE" "$brief" "$issue" "$spec" "$tier" "$branch" "$worktree" "" "$agent" "1"
  if [ "$resume" = "1" ]; then
    {
      echo ""
      echo "## Resume, do not restart"
      echo ""
      echo "The branch $branch already exists on origin with earlier work on this issue."
      echo "Fetch it, read its commit log, and FINISH it on that same branch: do not"
      echo "start over, do not create a new branch, and keep the work that is already"
      echo "there unless it is wrong. If a pull request does not exist yet, open one"
      echo "from this branch when the work is ready."
    } >> "$brief"
  fi
  if [ "$resume" = "1" ] && [ -d "$worktree" ]; then
    fctl log "$issue" "dispatch reusing existing worktree $worktree for branch $branch"
  elif [ "$resume" = "1" ]; then
    if git -C "$REPO_ROOT" show-ref --quiet --verify "refs/heads/$branch"; then
      if ! act git -C "$REPO_ROOT" worktree add "$worktree" "$branch"; then
        fctl log "$issue" "dispatch failed: could not create worktree $worktree"
        return 0
      fi
    else
      if ! act git -C "$REPO_ROOT" worktree add -b "$branch" "$worktree" "origin/$branch"; then
        fctl log "$issue" "dispatch failed: could not create worktree $worktree"
        return 0
      fi
    fi
  else
    if ! act git -C "$REPO_ROOT" worktree add -b "$branch" "$worktree" origin/main; then
      fctl log "$issue" "dispatch failed: could not create worktree $worktree"
      return 0
    fi
  fi
  if spawn_agent "$agent" "$worktree" "$brief" "$tier"; then
    fctl log "$issue" "spawn: build agent $agent in $worktree"
    note_spawn
    fctl set "$issue" status=building "agent=$agent" "branch=$branch" "worktree=$worktree"
    LIVE_LANES=$((LIVE_LANES + 1))
  else
    fctl log "$issue" "dispatch failed: could not spawn build agent $agent"
  fi
}

handle_building() { # <issue> <record>
  local issue="$1" record="$2"
  local agent tier updated age restart_count ruling
  agent="$(jq -r '.agent // empty' <<<"$record")"
  tier="$(jq -r '.tier // "routine"' <<<"$record")"
  updated="$(jq -r '.updated_at // empty' <<<"$record")"
  [ -n "$agent" ] || return 0
  if herdr_agent_names | grep -qxF "$agent"; then
    return 0
  fi
  [ -n "$updated" ] || return 0
  age=$((NOW_EPOCH - $(iso_to_epoch "$updated")))
  [ "$age" -ge "$STALE_SECONDS" ] || return 0
  restart_count="$(lane_log_msgs "$issue" | grep -c '^restart:')"
  if [ "${restart_count:-0}" -ge 1 ]; then
    fctl set "$issue" status=blocked "blocked_reason=build agent died twice; parked for Ben"
    fctl log "$issue" "build agent died a second time; parked"
    return 0
  fi
  ruling="$(judgment_call "$issue" "$record" 'RESTART or PARK' \
    "The build agent for issue $issue died mid-build (gone from the agent list, no record change for over 30 minutes). Should we restart it fresh with the same brief, or park the lane for Ben?" | tail -n1)"
  case "$ruling" in
    RESTART)
      if ! budget_available; then
        fctl log "$issue" "restart approved but spawn budget exhausted; leaving lane as is"
        return 0
      fi
      if ! memory_ok; then
        refuse_spawn_low_memory "$issue"
        return 0
      fi
      local worktree brief
      worktree="$(jq -r '.worktree // empty' <<<"$record")"
      brief="$BRIEFS_DIR/brief-$issue-build.md"
      if [ -n "$worktree" ] && [ -f "$brief" ] && spawn_agent "$agent" "$worktree" "$brief" "$tier"; then
        fctl log "$issue" "restart: respawned build agent $agent with the same brief"
        fctl log "$issue" "spawn: build agent $agent (restart)"
        note_spawn
        fctl set "$issue" status=building "agent=$agent"
      else
        fctl set "$issue" status=blocked "blocked_reason=restart failed; parked for Ben"
        fctl log "$issue" "restart failed (missing worktree or brief, or spawn error); parked"
      fi
      ;;
    PARK)
      fctl set "$issue" status=blocked "blocked_reason=dead lane parked by judgment call"
      fctl log "$issue" "dead lane parked by judgment call"
      ;;
    *)
      : # no ruling (dry-run or unparseable answer): leave the lane alone this tick
      ;;
  esac
}

handle_pr_open() { # <issue> <record>
  local issue="$1" record="$2"
  local pr checks failing pending tier
  tier="$(jq -r '.tier // "routine"' <<<"$record")"
  pr="$(jq -r '.pr // empty' <<<"$record")"
  if [ -z "$pr" ]; then
    fctl log "$issue" "status is pr-open but the record has no PR number"
    return 0
  fi
  checks="$(gh pr checks "$pr" --json name,bucket 2>/dev/null)"
  if [ -z "$checks" ]; then
    return 0 # checks not reportable yet; try again next tick
  fi
  failing="$(jq -r '[.[] | select(.bucket == "fail" or .bucket == "cancel") | .name] | join(",")' <<<"$checks" 2>/dev/null)"
  pending="$(jq -r '[.[] | select(.bucket == "pending")] | length' <<<"$checks" 2>/dev/null)"
  if [ -n "$failing" ]; then
    act gh pr comment "$pr" --body "CI is red on this PR. Failing checks: $failing. Please fix and push; the fleet daemon will re-check."
    fctl log "$issue" "ci-red: failing checks: $failing"
    fctl set "$issue" status=ci-red
    return 0
  fi
  if [ "${pending:-0}" -gt 0 ]; then
    return 0
  fi
  # Green: spawn an incremental QA round.
  if ! budget_available; then
    fctl log "$issue" "CI green but spawn budget exhausted; QA spawn deferred"
    return 0
  fi
  if ! memory_ok; then
    refuse_spawn_low_memory "$issue"
    return 0
  fi
  local qa_rounds round qa_agent worktree branch brief
  qa_rounds="$(jq -r '.qa_rounds // 0' <<<"$record")"
  round=$((qa_rounds + 1))
  qa_agent="fleet-qa-$issue-r$round"
  worktree="$(jq -r '.worktree // empty' <<<"$record")"
  branch="$(jq -r '.branch // empty' <<<"$record")"
  brief="$BRIEFS_DIR/brief-$issue-qa-r$round.md"
  {
    echo "# QA round $round for issue #$issue (PR #$pr)"
    echo ""
    echo "You are a QA agent under the fleet daemon; there is no coordinator to message."
    echo "This is round $round, so review INCREMENTALLY: focus on what changed since the"
    echo "last round (new commits and replies on PR #$pr), not a from-scratch re-review."
    echo "Branch: $branch. Worktree: $worktree."
    echo ""
    echo "Post your verdict as a PR comment, then record it:"
    echo "- pass: fleetctl set $issue status=qa-green qa_rounds=$round"
    echo "- fail: fleetctl set $issue status=qa-red qa_rounds=$round"
    echo "Then STOP your session. Never idle waiting."
    echo "Write everything a human reads in plain English, no jargon, plain ASCII"
    echo "punctuation, and pass this rule to anything you spawn."
  } > "$brief"
  if spawn_agent "$qa_agent" "${worktree:-$REPO_ROOT}" "$brief" "$tier"; then
    fctl log "$issue" "spawn: QA agent $qa_agent for round $round"
    note_spawn
    fctl set "$issue" status=qa "agent=$qa_agent"
  else
    fctl log "$issue" "QA dispatch failed: could not spawn $qa_agent"
  fi
}

handle_ci_red() { # <issue> <record>
  local issue="$1" record="$2"
  local repeated
  # A check that shows up red in two separate ci-red log lines = stop the line.
  repeated="$(lane_log_msgs "$issue" | grep '^ci-red: failing checks:' | sed 's/^ci-red: failing checks: //' \
    | tr ',' '\n' | sed '/^$/d' | sort | uniq -c | awk '$1 >= 2 {print $2; exit}')"
  if [ -n "$repeated" ]; then
    fctl set "$issue" status=blocked "blocked_reason=same CI check failed twice: $repeated"
    fctl log "$issue" "stop the line: check $repeated failed twice"
  fi
  # Otherwise wait: the lane agent pushes a fix and sets the record back to pr-open.
}

handle_qa() { # <issue> <record>
  : # The QA agent moves the record to qa-green or qa-red itself.
}

handle_qa_red() { # <issue> <record>
  local issue="$1" record="$2"
  local qa_rounds pr ruling
  qa_rounds="$(jq -r '.qa_rounds // 0' <<<"$record")"
  pr="$(jq -r '.pr // empty' <<<"$record")"
  if [ "$qa_rounds" -ge 2 ]; then
    ruling="$(judgment_call "$issue" "$record" 'MERGE or PARK' \
      "Issue $issue failed QA twice. Read the QA verdict and the build agent's cited fixes on PR #$pr and rule: merge anyway, or park for Ben? When it is close, prefer parking." | tail -n1)"
    case "$ruling" in
      MERGE)
        fctl set "$issue" status=qa-green
        fctl log "$issue" "QA arbitration ruled MERGE; moving to qa-green for the merge checks"
        ;;
      PARK)
        fctl set "$issue" status=blocked "blocked_reason=QA failed twice; arbiter parked the lane"
        fctl log "$issue" "QA arbitration ruled PARK"
        ;;
      *)
        : # no ruling this tick
        ;;
    esac
    return 0
  fi
  if [ -n "$pr" ]; then
    act gh pr comment "$pr" --body "QA round $qa_rounds failed. Fix the findings, reply here citing the commit SHA that addresses each one, then set the record back to pr-open with fleetctl."
  fi
  fctl set "$issue" status=building
  fctl log "$issue" "QA red at round $qa_rounds; lane sent back to fix with cited commits"
}

handle_qa_green() { # <issue> <record>
  local issue="$1" record="$2"
  local pr spec tier
  pr="$(jq -r '.pr // empty' <<<"$record")"
  spec="$(jq -r '.spec // ""' <<<"$record")"
  tier="$(jq -r '.tier // "routine"' <<<"$record")"
  if [ -z "$pr" ]; then
    fctl log "$issue" "status is qa-green but the record has no PR number"
    return 0
  fi
  # Live-path gate: a user-facing change needs live proof recorded on the PR
  # before it may merge.
  if is_user_facing "$spec" "$pr"; then
    if ! pr_comment_bodies "$pr" | grep -qi "live-path proof"; then
      fctl set "$issue" status=blocked "blocked_reason=code-complete, unverified"
      fctl log "$issue" "user-facing PR #$pr has no live-path proof comment; parked as code-complete, unverified"
      return 0
    fi
  fi
  if [ "$tier" = "security" ]; then
    fctl set "$issue" status=blocked "blocked_reason=security tier: merge needs Ben's sign-off"
    fctl log "$issue" "security tier parked for merge sign-off"
    ensure_needs_ben "$issue" "security tier PR #$pr is QA-green and needs your merge sign-off"
    return 0
  fi
  # Routine and sensitive tiers merge on auto (never --admin: blocked by a ruleset).
  act gh pr merge "$pr" --squash --auto
  fctl set "$issue" status=merging
  fctl log "$issue" "auto-merge enabled on PR #$pr"
}

handle_merging() { # <issue> <record>
  local issue="$1" record="$2"
  local pr state worktree agent verdict pane
  pr="$(jq -r '.pr // empty' <<<"$record")"
  [ -n "$pr" ] || return 0
  state="$(gh pr view "$pr" --json state --jq '.state' 2>/dev/null)"
  case "$state" in
    MERGED) ;;
    CLOSED)
      fctl set "$issue" status=blocked "blocked_reason=PR #$pr closed without merging"
      fctl log "$issue" "PR #$pr was closed without merging; parked"
      return 0
      ;;
    *) return 0 ;; # still open, wait
  esac
  worktree="$(jq -r '.worktree // empty' <<<"$record")"
  agent="$(jq -r '.agent // empty' <<<"$record")"
  if [ -n "$worktree" ]; then
    if [ -x "$REPO_ROOT/scripts/worktree-reapable.sh" ]; then
      verdict="$("$REPO_ROOT/scripts/worktree-reapable.sh" "$worktree" 2>/dev/null | grep -o 'REAPABLE\|KEEP' | head -n1)"
      if [ "$verdict" = "REAPABLE" ]; then
        act git -C "$REPO_ROOT" worktree remove "$worktree"
        if [ -n "$agent" ]; then
          if [ "$DRY" = "1" ]; then
            echo "DRY: herdr pane close <pane of $agent>"
          else
            pane="$(herdr agent list 2>/dev/null | jq -r --arg n "$agent" '.result.agents[] | select(.name == $n) | .pane_id' 2>/dev/null | head -n1)"
            [ -n "$pane" ] && herdr pane close "$pane" >/dev/null 2>&1
          fi
        fi
        fctl log "$issue" "teardown: PR #$pr merged; removed worktree $worktree and closed the agent pane"
      else
        fctl log "$issue" "teardown skipped: reap check said KEEP for $worktree; leaving it"
      fi
    else
      fctl log "$issue" "reap check unavailable, keeping worktree"
    fi
  fi
  fctl set "$issue" status=done
  fctl log "$issue" "done: PR #$pr merged"
}

deputy_call() { # <issue> <record> <reason>
  local issue="$1" record="$2" reason="$3"
  local pr tier question ruling
  pr="$(jq -r '.pr // empty' <<<"$record")"
  tier="$(jq -r '.tier // "routine"' <<<"$record")"
  question="You are acting as Ben's deputy for the Jarv1s fleet tonight. Lane $issue is parked with reason: $reason. Ben was asked over 20 minutes ago and has not replied. You may decide anything Ben could have been asked, including security-tier merge sign-off, EXCEPT actions on the hard floor: touching prod (:1533); deleting or dropping user data, databases, or vault content; force-pushing or rewriting history; deleting branches or worktrees with unmerged work; disabling CI, guardrails, or required checks; exceeding the spawn budget; bypassing the live-path check; exposing secrets. If the ruling would need any of those, your only allowed answer is PARK. Prefer the reversible option when it is close. This lane's tier is $tier."
  if [ "$DRY" = "1" ]; then
    echo "DRY: $JUDGE_CMD [deputy for lane $issue: $reason]"
    return 0
  fi
  local prompt
  prompt="$question

Answer with a SINGLE first line containing exactly one word: MERGE (enable auto-merge on the PR), RESUME (put the lane back in the queue), or PARK (leave it for Ben). Only the first line is read.

Lane record:
$record

Last 20 log lines for this lane:
$(lane_log_tail "$issue")"
  # shellcheck disable=SC2086 # JUDGE_CMD is a command, splitting is intended
  ruling="$($JUDGE_CMD "$prompt" 2>/dev/null | head -n1 | tr -d '\r' | awk '{print toupper($1)}')"
  fctl log "$issue" "DEPUTY question: $question"
  fctl log "$issue" "DEPUTY ruling: ${ruling:-<no answer>}"
  case "$ruling" in
    MERGE)
      # Hard floor stays enforced in code: a lane parked by the live-path gate
      # cannot be merged past it, deputy or not.
      if grep -qi "code-complete, unverified" <<<"$reason"; then
        fctl log "$issue" "DEPUTY MERGE refused: merging would bypass the live-path check (hard floor); lane stays parked"
        return 0
      fi
      if [ -n "$pr" ]; then
        act gh pr merge "$pr" --squash --auto
        fctl set "$issue" status=merging blocked_reason=
        fctl log "$issue" "DEPUTY applied: auto-merge enabled on PR #$pr"
        if [ "$tier" = "security" ]; then
          fctl log "$issue" "DEPUTY security merge sign-off: PR #$pr approved by the deputy; flag at the top of the morning board"
        fi
      fi
      ;;
    RESUME)
      fctl set "$issue" status=queued blocked_reason=
      fctl log "$issue" "DEPUTY applied: lane returned to the queue"
      ;;
    *)
      fctl log "$issue" "DEPUTY applied: lane stays parked"
      ;;
  esac
}

handle_blocked() { # <issue> <record>
  local issue="$1" record="$2"
  local reason entry entry_age
  reason="$(jq -r '.blocked_reason // "no reason recorded"' <<<"$record")"
  ensure_needs_ben "$issue" "$reason"
  [ "$DEPUTY_ACTIVE" = "1" ] || return 0
  entry="$(needs_ben_entry_file "$issue")"
  [ -n "$entry" ] || return 0
  if needs_ben_reply_exists "$issue"; then
    return 0
  fi
  entry_age=$((NOW_EPOCH - $(stat -c %Y "$entry" 2>/dev/null || echo "$NOW_EPOCH")))
  [ "$entry_age" -ge "$DEPUTY_WAIT_SECONDS" ] || return 0
  deputy_call "$issue" "$record" "$reason"
}

handle_done() {
  :
}

# --- main loop -------------------------------------------------------------------

# Intake first: pick up new Ready / In Progress task issues from the board.
intake

# Live lanes for the dispatch cap: anything between queued and done/blocked.
LIVE_LANES=0
for f in "$TASKS_DIR"/*.json; do
  [ -f "$f" ] || continue
  case "$(jq -r '.status // ""' "$f" 2>/dev/null)" in
    building|pr-open|ci-red|qa|qa-red|qa-green|merging) LIVE_LANES=$((LIVE_LANES + 1)) ;;
  esac
done

for f in "$TASKS_DIR"/*.json; do
  [ -f "$f" ] || continue
  record="$(cat "$f")"
  issue="$(jq -r '.issue // empty' <<<"$record")"
  status="$(jq -r '.status // empty' <<<"$record")"
  [ -n "$issue" ] || continue
  [ -n "$status" ] || continue

  # A paused lane is skipped entirely: no dispatch, no dead-lane check, no
  # relay park. A paused agent's record goes quiet on purpose, which is
  # exactly the signature the dead-lane check hunts for -- so the skip must
  # come before every other rule. Unpausing (paused=false) puts the lane
  # straight back into the normal flow; if its agent died while paused, the
  # dead-lane path picks it up on the next tick.
  paused="$(jq -r '.paused // false' <<<"$record")"
  if [ "$paused" = "true" ]; then
    continue
  fi

  # Relay rule: two relays means the task was sliced too big. Park it.
  relays="$(jq -r '.relays // 0' <<<"$record")"
  if [ "$relays" -ge 2 ] && [ "$status" != "blocked" ] && [ "$status" != "done" ]; then
    fctl set "$issue" status=blocked "blocked_reason=needs re-slice"
    fctl log "$issue" "relayed $relays times; parked with reason: needs re-slice"
    continue
  fi

  case "$status" in
    queued)   handle_queued "$issue" "$record" ;;
    building) handle_building "$issue" "$record" ;;
    pr-open)  handle_pr_open "$issue" "$record" ;;
    ci-red)   handle_ci_red "$issue" "$record" ;;
    qa)       handle_qa "$issue" "$record" ;;
    qa-red)   handle_qa_red "$issue" "$record" ;;
    qa-green) handle_qa_green "$issue" "$record" ;;
    merging)  handle_merging "$issue" "$record" ;;
    blocked)  handle_blocked "$issue" "$record" ;;
    done)     handle_done ;;
    *)        fctl log "$issue" "unknown status '$status'; skipped" ;;
  esac
done

# Refresh Ben's morning view.
fctl board

exit 0
