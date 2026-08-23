# Fleet Daemon Unit One Implementation Plan (#1907)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teach the fleet daemon everything the launcher and viewer (#1904) will assume exists: a settings file, per-lane pause, a memory floor, a model and effort per kind of work, and the outstanding question copied into the lane record.

**Architecture:** All changes land in the two merged daemon files — `scripts/fleet/tick.sh` (the once-a-minute state machine) and `scripts/fleet/fleetctl.mjs` (the only writer of lane records) — plus one paragraph in the agent brief template and comments in the systemd service file. No launcher, no viewer, no new programs. Every value keeps the precedence: environment variable wins, then `settings.json` in the state folder, then a built-in fallback identical to today's behaviour.

**Tech Stack:** Bash (tick.sh), Node without dependencies (fleetctl.mjs), jq, vitest for the CLI tests, the sandboxed bash suite `tests/scripts/test-fleet-tick.sh` for the daemon.

**Spec:** `docs/superpowers/specs/2026-08-23-fleet-launcher-design.md` (sections "Unit one in detail" and "The seam between the units"), building on `docs/superpowers/specs/2026-08-23-fleet-daemon.md`.

## Global Constraints

- **No model name may appear in the daemon's code.** `sonnet` is currently hardcoded in tick.sh and must be removed; Task 6 adds a test that greps for model names and fails on any hit in `scripts/fleet/tick.sh` or `scripts/fleet/fleetctl.mjs`. Model names in test fixtures and settings files are data and are fine.
- **Precedence for every configurable value:** environment variable > `settings.json` > built-in fallback. Built-in fallbacks stay at today's numbers (cap 3, budget 12, wait 1200 s, judge command `claude -p`) so a daemon with no settings file behaves exactly as before. The launcher (unit two, #1904) seeds 5/30 via settings.json — those numbers do NOT go into the daemon.
- **The seam table in the spec is the contract.** Field names are exactly: `paused`, `pausedAt`, `pausedBy`, `question`, `questionAskedAt` on the lane record; settings keys are `judgeCmd`, `buildModels`, `laneCap`, `spawnBudget`, `deputyEnabled`, `deputyWaitSeconds`. Do not rename anything.
- **Memory floor is 4 GB (4096 MB)** of MemAvailable, from the spec. Overridable via `FLEET_MEMORY_FLOOR_MB` for tests only.
- **Work in `/tmp/fleet-launcher-wt` on branch `docs/fleet-launcher-spec`** (or a branch cut from it, if the executor prefers a clean `feat/1907-...` branch off origin/main — the spec commits are already on main-bound PR flow; ask the coordinator which). Never touch the main checkout at `~/Jarv1s`.
- **`git add` by explicit path only.** Never `git add -A`.
- **The tick test suite runs with `set -euo pipefail`**, so a failing assertion exits with no message at the point of failure. The last line printed is the last PASSING test; the failure is the test after it. Do not mistake the silent exit for a hang, and never retry it in a loop.
- **Run the suites like this, nothing broader:**
  - Daemon: `bash tests/scripts/test-fleet-tick.sh` (fully sandboxed, no network)
  - CLI: `pnpm vitest run tests/unit/fleetctl.test.ts` (scoped — a full `test:unit` run hits a known unrelated local failure in module-sdk-worker)
- **Plain English in all log messages and comments a human reads.** Release note for the eventual PR: `Category: N/A` (internal ops tooling, not user-visible).

## File Structure

- `scripts/fleet/fleetctl.mjs` — modify: new record fields, boolean field handling.
- `scripts/fleet/tick.sh` — modify: settings loading, deputy switch, pause skip, memory floor, per-tier model/effort, question copy.
- `scripts/fleet/brief-template.md` — modify: pause paragraph; fix the placeholder-style bug.
- `scripts/ops/systemd/jarv1s-fleet-tick.service` — modify: comments only (settings shadowing warning).
- `tests/unit/fleetctl.test.ts` — extend.
- `tests/scripts/test-fleet-tick.sh` — extend, and update the two DEPUTY-file tests plus the run helpers.

---

### Task 1: New lane-record fields in fleetctl

**Files:**

- Modify: `scripts/fleet/fleetctl.mjs`
- Test: `tests/unit/fleetctl.test.ts`

**Interfaces:**

- Produces: lane records carry `paused` (JSON boolean, default `false`), `pausedAt`, `pausedBy`, `question`, `questionAskedAt` (strings or null, default null). All five settable via `fleetctl set`. `paused` accepts only `true` or `false`; anything else is a validation error (exit 1). Setting any of the four string fields to `null` or empty clears it, same as existing fields.

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe("fleetctl", ...)` block in `tests/unit/fleetctl.test.ts`:

```typescript
it("new records carry pause and question fields with safe defaults", () => {
  run(["add", "42", "spec=docs/specs/x.md", "tier=routine"]);
  const record = JSON.parse(run(["get", "42"]).stdout);
  expect(record).toMatchObject({
    paused: false,
    pausedAt: null,
    pausedBy: null,
    question: null,
    questionAskedAt: null
  });
});

it("paused is a real boolean and rejects anything else", () => {
  run(["add", "43", "spec=docs/specs/x.md", "tier=routine"]);
  expect(run(["set", "43", "paused=true"]).code).toBe(0);
  let record = JSON.parse(run(["get", "43"]).stdout);
  expect(record.paused).toBe(true);

  expect(run(["set", "43", "paused=false"]).code).toBe(0);
  record = JSON.parse(run(["get", "43"]).stdout);
  expect(record.paused).toBe(false);

  expect(run(["set", "43", "paused=banana"]).code).toBe(1);
});

it("question fields set and clear like other string fields", () => {
  run(["add", "44", "spec=docs/specs/x.md", "tier=routine"]);
  run([
    "set",
    "44",
    "question=Should we merge PR 90 without live proof?",
    "questionAskedAt=2026-08-23T01:00:00Z"
  ]);
  let record = JSON.parse(run(["get", "44"]).stdout);
  expect(record.question).toBe("Should we merge PR 90 without live proof?");
  expect(record.questionAskedAt).toBe("2026-08-23T01:00:00Z");

  run(["set", "44", "question=null"]);
  record = JSON.parse(run(["get", "44"]).stdout);
  expect(record.question).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /tmp/fleet-launcher-wt && pnpm vitest run tests/unit/fleetctl.test.ts`
Expected: the three new tests FAIL (`unknown field "paused"` in stdout / mismatched objects); existing tests still pass.

- [ ] **Step 3: Implement in fleetctl.mjs**

Three edits.

Next to the existing field-set constants (`INT_FIELDS`, `INCREMENT_FIELDS`, `SETTABLE_FIELDS`):

```javascript
const BOOL_FIELDS = new Set(["paused"]);
const SETTABLE_FIELDS = new Set([
  "spec",
  "tier",
  "status",
  "branch",
  "worktree",
  "pr",
  "agent",
  "relays",
  "qa_rounds",
  "blocked_reason",
  "paused",
  "pausedAt",
  "pausedBy",
  "question",
  "questionAskedAt"
]);
```

In `cmdAdd`, add the new defaults to the record literal, after `blocked_reason: null`:

```javascript
    paused: false,
    pausedAt: null,
    pausedBy: null,
    question: null,
    questionAskedAt: null,
```

In `cmdSet`, inside the value-parsing chain, add a boolean branch BEFORE the null/empty branch (so `paused=` cannot silently become null — a lane must be explicitly paused or unpaused):

```javascript
    if (rawValue === "+1") {
      // ... existing branch unchanged
    } else if (BOOL_FIELDS.has(field)) {
      if (rawValue !== "true" && rawValue !== "false") {
        throw validationError(`${field} must be true or false; got "${rawValue}"`);
      }
      value = rawValue === "true";
    } else if (rawValue === "null" || rawValue === "") {
      // ... existing branch unchanged
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/unit/fleetctl.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
cd /tmp/fleet-launcher-wt
git add scripts/fleet/fleetctl.mjs tests/unit/fleetctl.test.ts
git commit -m "feat(fleet): lane records carry pause and question fields (#1907)"
```

---

### Task 2: tick.sh reads settings.json, environment still wins

**Files:**

- Modify: `scripts/fleet/tick.sh` (the constants block, roughly lines 22-40)
- Modify: `scripts/ops/systemd/jarv1s-fleet-tick.service` (comments only)
- Test: `tests/scripts/test-fleet-tick.sh`

**Interfaces:**

- Consumes: nothing from other tasks.
- Produces: shell functions `settings_get <jq-path>` (echoes the settings value or empty) and `int_or <value> <fallback>` (echoes the value if it is a whole number, else the fallback). Variables `LANE_CAP`, `SPAWN_BUDGET`, `DEPUTY_WAIT_SECONDS`, `JUDGE_CMD` now resolve env > settings > fallback. Tasks 3 and 6 build on `settings_get`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/scripts/test-fleet-tick.sh`, before the final `echo "fleet tick tests passed"`:

```bash
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
out="$(run_tick "$state")"
grep -q "DRY: other-judge run \[judgment for lane 402" <<<"$out"
pass "judgeCmd from settings.json drives the dead-lane judgment call"

# --- 14c. a malformed settings file falls back to the built-in numbers --------------

state="$(new_state)"
write_record "$state" 403 '{"issue":403,"status":"queued","tier":"routine","relays":0,"spec":"docs/x.md"}'
printf '{"laneCap": "lots"}\n' > "$state/settings.json"
out="$(run_tick "$state")"
grep -q "DRY: herdr agent start fleet-lane-403" <<<"$out"
pass "a non-numeric laneCap falls back to the built-in cap instead of breaking the tick"
```

- [ ] **Step 2: Run to verify they fail**

Run: `bash tests/scripts/test-fleet-tick.sh`
Expected: exits silently right after `PASS: deputy cannot merge past the live-path check...` — that silence is test 14 failing (settings ignored, so the lane dispatches). Remember: this suite never prints FAIL.

- [ ] **Step 3: Implement in tick.sh**

Replace the current constants block:

```bash
LANE_CAP=3
SPAWN_BUDGET=12
STALE_SECONDS=$((30 * 60))
DEPUTY_WAIT_SECONDS=$((20 * 60))
# ...comment...
JUDGE_CMD="${FLEET_JUDGE_CMD:-claude -p}"
# Model the spawned build agents run on. A cost policy, not a provider choice.
BUILD_MODEL="${FLEET_BUILD_MODEL:-sonnet}"
```

with:

```bash
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
# name is baked into the fleet. Word-splitting is deliberate; it is a command.
JUDGE_CMD="${FLEET_JUDGE_CMD:-$(settings_get '.judgeCmd')}"
JUDGE_CMD="${JUDGE_CMD:-claude -p}"
```

Delete the `BUILD_MODEL=` line entirely — Task 6 replaces it with per-tier resolution; until Task 6 lands, make `spawn_agent` tolerate it by changing its `--model "$BUILD_MODEL"` usages to a temporary `--model "${FLEET_BUILD_MODEL:-sonnet}"`? **No.** Do not leave the hardcoded name half-alive. Instead, in this task change both places `spawn_agent` uses `$BUILD_MODEL` (the DRY echo and the real `herdr agent start`) to use a new variable resolved the same way as the others, keeping today's behaviour without the literal in the spawn path yet:

```bash
BUILD_MODEL="${FLEET_BUILD_MODEL:-$(settings_get '.buildModels.routine.model')}"
BUILD_MODEL="${BUILD_MODEL:-sonnet}"
```

(The literal `sonnet` fallback survives Task 2 and is removed in Task 6 — the grep test that forbids it is added there, not here. This keeps each task independently green.)

Two ordering notes for the implementer:

- `SETTINGS_FILE` uses `$STATE_DIR`, so this block must stay BELOW the `STATE_DIR=` line (it already is — you are editing in place).
- `settings_get` is called before the `[ -d "$TASKS_DIR" ] || exit 0` rail runs; that is fine, it only reads a file that may not exist.

Then in `scripts/ops/systemd/jarv1s-fleet-tick.service`, extend the environment comment block:

```ini
# Judgment calls and build-agent spawns are provider-agnostic. Configuration
# normally comes from settings.json in the state folder (written by the fleet
# launcher's setup questions). Environment variables set HERE override that
# file — an uncommented line below silently shadows every answer given at
# setup, so keep these commented unless you mean to pin a value.
#Environment=FLEET_JUDGE_CMD=claude -p
#Environment=FLEET_BUILD_MODEL=sonnet
#Environment=FLEET_LANE_CAP=3
#Environment=FLEET_SPAWN_BUDGET=12
```

- [ ] **Step 4: Run to verify everything passes**

Run: `bash tests/scripts/test-fleet-tick.sh`
Expected: all PASS lines through test 14c, ending `fleet tick tests passed`.

- [ ] **Step 5: Commit**

```bash
git add scripts/fleet/tick.sh scripts/ops/systemd/jarv1s-fleet-tick.service tests/scripts/test-fleet-tick.sh
git commit -m "feat(fleet): daemon reads settings.json, environment still wins (#1907)"
```

---

### Task 3: Deputy becomes a settings switch; the expiry file goes away

**Files:**

- Modify: `scripts/fleet/tick.sh` (the DEPUTY block, roughly lines 108-120, plus the header comment near the top)
- Test: `tests/scripts/test-fleet-tick.sh` (rewrite tests 8 and 8b; 8c gets a settings file)

**Interfaces:**

- Consumes: `settings_get` from Task 2.
- Produces: `DEPUTY_ACTIVE` is 1 only when `FLEET_DEPUTY_ENABLED=true` in the environment or `deputyEnabled` is `true` in settings.json. The `DEPUTY` marker file is dead: present or absent, it changes nothing.

This implements the spec's "Deputy gating" row and Ben's 2026-08-23 ruling (plain on/off switch, no expiry — recorded in the spec's decisions table; do not soften or re-add expiry logic).

- [ ] **Step 1: Rewrite the deputy tests**

Replace tests 8 and 8b in `tests/scripts/test-fleet-tick.sh` (keep their position and the lane-108 setup lines) with:

```bash
# --- 8. deputy off by default; the old DEPUTY marker file is dead -------------------

state="$(new_state)"
write_record "$state" 108 '{"issue":108,"status":"blocked","tier":"routine","blocked_reason":"stuck on a decision","relays":0}'
printf 'until=%s\n' "$(date -d '1 hour' +%Y-%m-%dT%H:%M)" > "$state/DEPUTY"
echo "108: stuck on a decision" > "$tmp/needs-ben/sent/entry-108.msg"
touch -d '30 minutes ago' "$tmp/needs-ben/sent/entry-108.msg"
out="$(run_tick "$state")"
if grep -qi "deputy" <<<"$out"; then false; fi
pass "deputy stays off by default even when the old DEPUTY file is present"

# --- 8b. deputyEnabled in settings turns the deputy on ------------------------------

printf '{"deputyEnabled": true}\n' > "$state/settings.json"
out="$(run_tick "$state")"
grep -q "DRY: claude -p \[deputy for lane 108" <<<"$out"
pass "deputyEnabled true in settings triggers the deputy call after the wait"

# --- 8d. deputyWaitSeconds from settings is honoured --------------------------------

printf '{"deputyEnabled": true, "deputyWaitSeconds": 7200}\n' > "$state/settings.json"
out="$(run_tick "$state")"
if grep -qi "deputy for lane" <<<"$out"; then false; fi
pass "a 2-hour deputyWaitSeconds means a 30-minute-old question gets no deputy call yet"
```

And in test 8c, keep the `FLEET_JUDGE_CMD` override but make sure the state still has `{"deputyEnabled": true}` in settings when it runs (it reuses `$state` from 8b — reset the settings file back to `{"deputyEnabled": true}` on the line before, since 8d changed it):

```bash
printf '{"deputyEnabled": true}\n' > "$state/settings.json"
out="$(run_tick "$state" FLEET_JUDGE_CMD='some-other-provider run')"
```

(Order in the file: 8, 8b, 8d, then 8c with its settings reset. Keep 8c's assertions unchanged.)

- [ ] **Step 2: Run to verify failure**

Run: `bash tests/scripts/test-fleet-tick.sh`
Expected: silent exit right after `PASS: a lane relayed twice parks...` — that is test 8 failing, because the active DEPUTY file still turns the deputy on.

- [ ] **Step 3: Implement in tick.sh**

Replace the whole DEPUTY block:

```bash
# DEPUTY file: "until=..." ... (comment)
DEPUTY_ACTIVE=0
if [ -f "$STATE_DIR/DEPUTY" ]; then
  ...
fi
```

with:

```bash
# Deputy switch (Ben's ruling, 2026-08-23): a plain on/off setting with no
# time element, replacing the old expiring DEPUTY marker file. Off unless
# deputyEnabled is true in settings.json or FLEET_DEPUTY_ENABLED=true in the
# environment. The launcher shows this state on screen at all times; the
# hard floor below is unaffected by it.
DEPUTY_ACTIVE=0
deputy_enabled="${FLEET_DEPUTY_ENABLED:-$(settings_get '.deputyEnabled')}"
[ "$deputy_enabled" = "true" ] && DEPUTY_ACTIVE=1
```

Also update the header comment at the top of tick.sh: the line `- DEPUTY file: lets a one-shot model call stand in for Ben...` becomes `- Deputy switch (deputyEnabled in settings.json): lets a one-shot model call stand in for Ben on parked lanes, within a hard floor it may never cross.`

- [ ] **Step 4: Run to verify all pass**

Run: `bash tests/scripts/test-fleet-tick.sh`
Expected: all PASS, including 8, 8b, 8d, 8c and everything from Task 2.

- [ ] **Step 5: Commit**

```bash
git add scripts/fleet/tick.sh tests/scripts/test-fleet-tick.sh
git commit -m "feat(fleet): deputy is a settings switch, expiring DEPUTY file removed (#1907)"
```

---

### Task 4: Per-lane pause, and the brief learns what a pause is

**Files:**

- Modify: `scripts/fleet/tick.sh` (main loop, roughly lines 715-745)
- Modify: `scripts/fleet/brief-template.md`
- Test: `tests/scripts/test-fleet-tick.sh`

**Interfaces:**

- Consumes: the `paused` record field from Task 1.
- Produces: any record with `paused` true is skipped by the whole tick — no dispatch, no dead-lane check, no relay park, no status handler. It still counts toward the live-lane cap when its status is a live one (deliberate: its agent may resume any second, so its slot stays reserved).

- [ ] **Step 1: Write the failing tests**

Append to the suite:

```bash
# --- 15. a paused lane is skipped entirely, including the dead-lane check ----------

state="$(new_state)"
stale_iso="$(date -Iseconds -d '40 minutes ago')"
write_record "$state" 501 "{\"issue\":501,\"status\":\"building\",\"agent\":\"gone-agent\",\"paused\":true,\"relays\":0,\"updated_at\":\"$stale_iso\"}"
out="$(run_tick "$state")"
if grep -qE "judgment for lane 501|set 501 status=blocked" <<<"$out"; then false; fi
pass "a paused lane survives past the dead-lane threshold untouched"

# --- 15b. a paused queued lane is not dispatched ------------------------------------

state="$(new_state)"
write_record "$state" 502 '{"issue":502,"status":"queued","tier":"routine","paused":true,"relays":0,"spec":"docs/x.md"}'
out="$(run_tick "$state")"
if grep -q "worktree add" <<<"$out"; then false; fi
pass "a paused queued lane spawns nothing"

# --- 15c. the brief template teaches agents what a pause is, and renders ------------

grep -q "pause" "$repo_root/scripts/fleet/brief-template.md"
if grep -q '{{' "$repo_root/scripts/fleet/brief-template.md"; then false; fi
pass "brief template carries the pause rule and only placeholders the renderer replaces"
```

- [ ] **Step 2: Run to verify failure**

Run: `bash tests/scripts/test-fleet-tick.sh`
Expected: silent exit after the last Task 3 PASS line — test 15 failing (the paused stale lane gets the judgment call today).

- [ ] **Step 3: Implement**

In tick.sh's main per-record loop, immediately AFTER `[ -n "$status" ] || continue` and BEFORE the relay-rule check, insert:

```bash
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
```

The live-lane counting loop above it needs NO change: a paused building lane still counts toward the cap, which is the reserved-slot behaviour stated in Interfaces.

In `scripts/fleet/brief-template.md`, two changes:

First, fix the placeholder-style bug: the template writes `{{ISSUE}}`, `{{SPEC_PATH}}`, `{{TIER}}`, `{{WORKTREE}}`, `{{BRANCH}}`, but the daemon's renderer substitutes `${ISSUE}`, `${SPEC}`, `${TIER}`, `${WORKTREE}`, `${BRANCH}` (see `render_brief` in tick.sh). Today every spawned brief goes out with raw double-brace placeholders in it. Convert every `{{NAME}}` to the `${NAME}` form the renderer actually replaces, and note that `{{SPEC_PATH}}` becomes `${SPEC}`. Do not change `render_brief` — the tests' fixture templates already use the `${NAME}` form, so the template is the wrong side.

Second, add this paragraph at the end of the "You are running under the fleet daemon" section:

```markdown
- **If a pause message arrives** (a human paused this lane from the fleet screen), stop at your
  next safe point: finish the edit or commit you are in the middle of, start nothing new, and
  wait to be told to continue or to stop for good. This is the one exception to "never idle
  waiting" — a pause is a human holding the lane, not a lane waiting on a human.
```

- [ ] **Step 4: Run to verify all pass**

Run: `bash tests/scripts/test-fleet-tick.sh`
Expected: all PASS through 15c.

- [ ] **Step 5: Commit**

```bash
git add scripts/fleet/tick.sh scripts/fleet/brief-template.md tests/scripts/test-fleet-tick.sh
git commit -m "feat(fleet): per-lane pause skips the whole tick; brief teaches the pause rule (#1907)"
```

---

### Task 5: Memory floor

**Files:**

- Modify: `scripts/fleet/tick.sh` (helpers block, plus the three spawn sites)
- Test: `tests/scripts/test-fleet-tick.sh` (including the two run helpers)

**Interfaces:**

- Consumes: `int_or` from Task 2.
- Produces: `memory_ok` — returns success when MemAvailable is at or above the floor, when the meminfo source is unreadable (fail open: a box where free memory cannot be read should not silently stop the fleet), or when the floor is 0. Reads from `$FLEET_MEMINFO` (default `/proc/meminfo`); floor is `$FLEET_MEMORY_FLOOR_MB` (default 4096).

- [ ] **Step 1: Make the existing suite hermetic first**

The floor would make every dispatch test depend on the test machine's real free memory. Before writing the new tests, add a healthy fixture and pin it in BOTH run helpers.

Near the `template=` line in the suite's helpers section:

```bash
meminfo_ok="$tmp/meminfo-ok"
printf 'MemTotal:       65536000 kB\nMemAvailable:   32768000 kB\n' > "$meminfo_ok"
```

Then add `FLEET_MEMINFO="$meminfo_ok" \` to the env lists of both `run_tick` and `run_tick_live`, next to the other pinned variables.

- [ ] **Step 2: Write the failing tests**

```bash
# --- 16. below the memory floor, no agent starts and the refusal is logged ---------

state="$(new_state)"
write_record "$state" 601 '{"issue":601,"status":"queued","tier":"routine","relays":0,"spec":"docs/x.md"}'
meminfo_low="$tmp/meminfo-low"
printf 'MemTotal:       65536000 kB\nMemAvailable:    1048576 kB\n' > "$meminfo_low"
out="$(run_tick "$state" FLEET_MEMINFO="$meminfo_low")"
if grep -q "worktree add" <<<"$out"; then false; fi
grep -q "free memory" <<<"$out"
pass "below the 4 GB floor nothing spawns and the refusal is logged in plain English"

# --- 16b. an unreadable memory source fails open ------------------------------------

out="$(run_tick "$state" FLEET_MEMINFO="$tmp/does-not-exist")"
grep -q "DRY: herdr agent start fleet-lane-601" <<<"$out"
pass "an unreadable memory source does not stop the fleet"
```

- [ ] **Step 3: Run to verify failure**

Run: `bash tests/scripts/test-fleet-tick.sh`
Expected: silent exit at test 16 (the low-memory lane still dispatches today).

- [ ] **Step 4: Implement in tick.sh**

In the shared-helpers section (near `lane_log_tail`):

```bash
# Memory floor (spec: 4 GB). The fleet degrades instead of pushing the box
# into swap at 4am: below the floor no new agent starts, and the tick says
# so and carries on. An unreadable source fails open -- a box where free
# memory cannot be read should not silently stop the fleet.
MEMINFO_SOURCE="${FLEET_MEMINFO:-/proc/meminfo}"
MEMORY_FLOOR_MB="$(int_or "${FLEET_MEMORY_FLOOR_MB:-}" 4096)"

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
```

Gate all three spawn sites, right next to their existing `budget_available` checks:

In `handle_queued`, after the budget check:

```bash
  if ! memory_ok; then
    refuse_spawn_low_memory "$issue"
    return 0
  fi
```

In `handle_pr_open`, in the green branch after its budget check: same four lines.

In `handle_building`, in the `RESTART)` case after its budget check: same four lines (log message reads the same; the lane stays as it is and is retried next tick).

- [ ] **Step 5: Run to verify all pass**

Run: `bash tests/scripts/test-fleet-tick.sh`
Expected: all PASS through 16b — including every OLD dispatch test, which now runs against the healthy fixture.

- [ ] **Step 6: Commit**

```bash
git add scripts/fleet/tick.sh tests/scripts/test-fleet-tick.sh
git commit -m "feat(fleet): refuse agent starts below a 4 GB memory floor (#1907)"
```

---

### Task 6: A model and effort per kind of work; no model name left in the daemon

**Files:**

- Modify: `scripts/fleet/tick.sh` (`spawn_agent` and its three callers, plus the `BUILD_MODEL` lines from Task 2)
- Test: `tests/scripts/test-fleet-tick.sh`

**Interfaces:**

- Consumes: `settings_get` (Task 2); the settings shape from the spec's seam table: `buildModels.<tier>.model` and `buildModels.<tier>.effort` for tiers `routine`, `sensitive`, `security`.
- Produces: `spawn_agent <name> <cwd> <brief> <tier>` — note the NEW fourth argument. Resolution per lane: model is `FLEET_BUILD_MODEL` env if set, else the tier's settings entry, else absent (the spawn omits the model flag and the agent runs on whatever the local CLI is configured to use — that is the fallback, not a hardcoded name). Effort likewise via `FLEET_BUILD_EFFORT` / settings / absent, passed as `--effort <value>`.

One honest caveat for the executor to carry into the PR description: whether the local agent CLI accepts `--effort` is proven at the live-proof stage (#1895 territory), not by this suite, which stubs the workspace manager. If the flag turns out wrong there, the fix is one line in `spawn_agent`.

- [ ] **Step 1: Write the failing tests**

```bash
# --- 17. each kind of work spawns on its configured model and effort ----------------

state="$(new_state)"
write_record "$state" 701 '{"issue":701,"status":"queued","tier":"security","relays":0,"spec":"docs/x.md"}'
printf '{"buildModels":{"security":{"model":"model-x","effort":"high"}}}\n' > "$state/settings.json"
out="$(run_tick "$state")"
grep -q -- "--model model-x --effort high" <<<"$out"
pass "a security-tier lane spawns on the model and effort configured for security work"

# --- 17b. no configuration at all means no model flag, not a baked-in name ----------

state="$(new_state)"
write_record "$state" 702 '{"issue":702,"status":"queued","tier":"routine","relays":0,"spec":"docs/x.md"}'
out="$(run_tick "$state")"
grep -q "DRY: herdr agent start fleet-lane-702" <<<"$out"
if grep -q -- "--model" <<<"$out"; then false; fi
pass "with no settings and no env, the spawn omits the model flag entirely"

# --- 17c. no model name appears in the daemon's own code ----------------------------

if grep -riE 'sonnet|opus|haiku|fable|gpt-[0-9]' "$repo_root/scripts/fleet/tick.sh" "$repo_root/scripts/fleet/fleetctl.mjs"; then false; fi
pass "the daemon and the state CLI contain no model names; names are data in settings"
```

- [ ] **Step 2: Run to verify failure**

Run: `bash tests/scripts/test-fleet-tick.sh`
Expected: silent exit at test 17 (today every spawn says `--model sonnet`).

- [ ] **Step 3: Implement in tick.sh**

Delete the two `BUILD_MODEL=` lines Task 2 left in the constants block, and the `#Environment=FLEET_BUILD_MODEL=sonnet` example in the service file stays (it is a comment naming an override variable, not daemon code — but change its example value to avoid the literal: `#Environment=FLEET_BUILD_MODEL=<model>`).

Add next to `settings_get`:

```bash
tier_model() { # <tier> -> model for this kind of work, or empty for "CLI default"
  if [ -n "${FLEET_BUILD_MODEL:-}" ]; then echo "$FLEET_BUILD_MODEL"; return; fi
  settings_get ".buildModels.\"$1\".model"
}

tier_effort() { # <tier> -> effort level, or empty for "do not pass one"
  if [ -n "${FLEET_BUILD_EFFORT:-}" ]; then echo "$FLEET_BUILD_EFFORT"; return; fi
  settings_get ".buildModels.\"$1\".effort"
}
```

Change `spawn_agent` to take the tier and build its argument list:

```bash
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
  ...
  if ! herdr agent start "$name" --kind claude --pane "$new_pane" -- "${model_args[@]}" --permission-mode bypassPermissions "$boot" >/dev/null 2>&1; then
  ...
```

(Everything marked `...` is unchanged from today. Watch one bash trap: with `set -u`, expanding an empty array as `"${model_args[@]}"` is safe on bash 4.4+, which this box has — do not add workarounds.)

Update the three callers to pass the tier, which each already has or can read from its record:

- `handle_queued`: `spawn_agent "$agent" "$worktree" "$brief" "$tier"` (tier is already a local there).
- `handle_pr_open` QA spawn: add `local tier`; `tier="$(jq -r '.tier // "routine"' <<<"$record")"`; pass it.
- `handle_building` restart: same one-line tier read from the record; pass it.

- [ ] **Step 4: Run everything**

Run: `bash tests/scripts/test-fleet-tick.sh && pnpm vitest run tests/unit/fleetctl.test.ts`
Expected: all PASS. Test 2 (the oldest dispatch test) keeps passing because it asserts on the `herdr agent start fleet-lane-101` prefix, not on model flags.

- [ ] **Step 5: Commit**

```bash
git add scripts/fleet/tick.sh scripts/ops/systemd/jarv1s-fleet-tick.service tests/scripts/test-fleet-tick.sh
git commit -m "feat(fleet): model and effort per kind of work; no model name in the daemon (#1907)"
```

---

### Task 7: The outstanding question reaches the lane record

**Files:**

- Modify: `scripts/fleet/tick.sh` (`ensure_needs_ben`, roughly line 213)
- Test: `tests/scripts/test-fleet-tick.sh`

**Interfaces:**

- Consumes: the `question` / `questionAskedAt` record fields from Task 1.
- Produces: whenever the daemon files a new question for Ben about a lane, the same text and an ISO timestamp land on the lane record. The viewer (unit two) reads only these; it never opens the needs-ben folder. Existing questions are not re-stamped (the fields are written only when the entry is first created, so the "clock still running" time stays honest).

- [ ] **Step 1: Write the failing test**

```bash
# --- 18. a lane's outstanding question reaches the lane record ----------------------

state="$(new_state)"
write_record "$state" 801 '{"issue":801,"status":"blocked","tier":"routine","blocked_reason":"needs a schema decision","relays":0}'
out="$(run_tick "$state")"
grep -q "DRY: needs-ben fleet-daemon 801: needs a schema decision" <<<"$out"
grep -q "DRY: fleetctl set 801 question=needs a schema decision questionAskedAt=" <<<"$out"
pass "filing a question for Ben also copies it onto the lane record"

# --- 18b. an existing question is not re-stamped every tick -------------------------

echo "801: needs a schema decision" > "$tmp/needs-ben/sent/entry-801.msg"
out="$(run_tick "$state")"
if grep -q "set 801 question=" <<<"$out"; then false; fi
pass "a question already on file is not re-stamped, so its clock stays honest"
```

- [ ] **Step 2: Run to verify failure**

Run: `bash tests/scripts/test-fleet-tick.sh`
Expected: silent exit at test 18 (today only the needs-ben line appears).

- [ ] **Step 3: Implement in tick.sh**

Replace `ensure_needs_ben`:

```bash
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
```

- [ ] **Step 4: Run the full gate**

Run: `bash tests/scripts/test-fleet-tick.sh && pnpm vitest run tests/unit/fleetctl.test.ts`
Expected: every test in both suites passes.

- [ ] **Step 5: Commit**

```bash
git add scripts/fleet/tick.sh tests/scripts/test-fleet-tick.sh
git commit -m "feat(fleet): copy a lane's outstanding question into its record (#1907)"
```

---

## Spec coverage check (for the executor's final pass)

| Spec requirement (unit one)                           | Task |
| ----------------------------------------------------- | ---- |
| Reads settings.json; environment still wins           | 2    |
| Model and effort per kind of work                     | 6    |
| Per-lane pause, skipped entirely incl. dead-lane      | 4    |
| Deputy gating becomes a setting, expiry logic removed | 3    |
| Memory floor at 4 GB, logged refusal                  | 5    |
| Outstanding question copied into the lane record      | 7    |
| Brief gains the pause line                            | 4    |
| Service definition must not shadow settings           | 2, 6 |
| Seam field names exactly as the spec table            | 1, 7 |
| No model name in daemon code, enforced by a test      | 6    |

Not in any task, on purpose: `run-started` (the launcher writes it — unit two), the settings seed defaults (launcher), anything on screen (viewer). The placeholder-style fix in Task 4 is a discovered bug repair in a file this plan already touches, called out to the coordinator rather than smuggled.
