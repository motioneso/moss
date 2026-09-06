# Relay 7: #1311 Task 3 — fix committed, 4 test failures still open, NOT green

**Worktree/branch:** `/home/ben/Jarv1s/.claude/worktrees/1311-install-grant`, branch
`1311-install-grant`. `node_modules` present — do not `pnpm install`. Tree at `b121d2e3`
(only `.claude/context-meter.log` dirty, ignore it).

**Coordinator label:** `Coordinator` — resolve fresh via `herdr pane list` each time.

**Plan doc:** `docs/superpowers/plans/2026-07-27-1311-install-grant-default-enabled.md` — read by
section only. Task 3 lines 136-154, Task 4 lines 156-163, Task 5 lines 165-177, Verification lines
188-210.

**Prior handoff:** `docs/superpowers/handoffs/2026-07-27-1311-install-grant-relay-6.md`

## State: Task 3 code written, committed, but full suite is RED (4 failures)

Core fix landed in `packages/tasks/src/action-policy.ts`: `getResolvedTaskChangesPolicy`'s
neither-row branch now calls new method `healInstallGrantAndReread` (grant, then re-read storage,
never assert `trusted_auto`) — same discipline as `selfHealGrantedAtInstallTier`. New test file
`tests/integration/tasks-action-policy-self-heal.test.ts` (4 tests per plan lines 136-154).

Ran full `pnpm test:integration` (background, ~805s, confirmed real completion via `ps` on the
vitest pid, not the shell fork). Result: **4 failed, 1721 passed, 7 skipped**. Log:
`/tmp/1311-t3.log`.

### Failure 1+2: pre-existing #1263 tests now stale (expected, need updating — not yet done)

`tests/integration/module-enablement.test.ts`, describe block `"tasks legacy agency_auto_execute
opt-out survives install grant (#1263)"`:
- `"grants trusted_auto when neither the canonical nor legacy key exists"` (line ~758) — first
  assertion expects `"ask_each_time"` from a bare read before any explicit grant call. That premise
  is now false: `getResolvedTaskChangesPolicy` itself heals on first read (that's the whole point of
  Task 3 — `tasks` is a `required` module that never traverses an explicit enable PATCH, so the read
  path is the only place self-heal can happen). Fix: change the first assertion to expect
  `"trusted_auto"` directly; the following explicit `grantInstallTimeTrustIfUnset` call becomes a
  no-op idempotency check, not the thing that flips the value.
- `"resolveGrantSelfOperationForModule routes a non-tasks manifest to the generic grant, not the
  compat helper"` (line ~831) — same root cause, but here it's worse: the test's FIRST assertion
  calls `getResolvedTaskChangesPolicy` to check the "neither key" precondition, and that call now
  *mutates* the very state the test is trying to observe (heals to `trusted_auto` before the routing
  logic under test even runs). **Must rewrite this precondition check to read storage directly**
  (`prefs.getWithMetadata(scopedDb, TASK_CHANGES_POLICY_KEY)` / `LEGACY_AGENCY_AUTO_EXECUTE_KEY`,
  both `toBeNull()`) instead of calling `getResolvedTaskChangesPolicy`, or the test can never
  observe the "still absent after non-tasks routing" outcome it's designed to prove. Same file
  imports `TASK_CHANGES_POLICY_KEY`/`LEGACY_AGENCY_AUTO_EXECUTE_KEY` already (line 8-9) — `prefs` is
  already in scope in this describe block, confirm before use.

### Failure 3: pre-existing web-contract test now stale (expected, need updating — not yet done)

`tests/integration/tasks-web-contract.test.ts`, test `"GET/PATCH /api/tasks/agency-auto-execute
stores the task trust toggle per user"` (line 82) — expects `{enabled: false}` from a fresh GET,
now correctly gets `{enabled: true}` because the real route hits the exact neither-key path Task 3
fixes. Update expected value to `{enabled: true}`. Have NOT yet opened this file to check whether
downstream assertions in the same test (the PATCH half) also need adjustment — check before editing.

### Failure 4: genuine PRE-EXISTING bug exposed by the plan's required test, NOT YET FIXED

My new test `"revocation survives: explicit always_confirm is never overwritten by the install
heal"` calls `setTaskChangesPolicy(db, "always_confirm")` then reads back — expected
`"always_confirm"`, got `"ask_each_time"`.

Root cause, in the SAME file (`packages/tasks/src/action-policy.ts`), the untouched "both exist"
branch:
```ts
// Both exist, use the most recently updated
if (canonical!.updatedAt >= legacy!.updatedAt) {
  return canonical!.value;
}
return legacy!.value ? "trusted_auto" : "ask_each_time";
```
`setTaskChangesPolicy` writes canonical then legacy sequentially (two separate `prefs.upsert`
calls, each stamping `now()` internally) — legacy's timestamp is essentially always >= canonical's,
so this branch picks legacy's boolean (which can only encode `trusted_auto`/`ask_each_time`) and
silently drops `always_confirm` every single time `setTaskChangesPolicy` is called with that tier.

Confirmed via grep: `LEGACY_AGENCY_AUTO_EXECUTE_KEY` is written ONLY inside
`setTaskChangesPolicy`, never independently — so "prefer whichever key was updated more recently"
serves no real purpose today; legacy is never independently authoritative. `JASSON` — sorry,
`JarvisActionPermissionTier` (`packages/module-sdk/src/index.ts:20`) has 3 real values
(`ask_each_time`/`trusted_auto`/`always_confirm`); legacy boolean structurally cannot represent the
third. **Recommended fix** (not yet applied): when both keys exist, unconditionally prefer
canonical — drop the timestamp comparison entirely. Rationale already confirmed safe: no test in
the suite exercises "legacy newer than canonical should win" as an intentional scenario (grepped
all `TASK_CHANGES_POLICY_KEY`/`LEGACY_AGENCY_AUTO_EXECUTE_KEY` usages across
`tests/integration/*.test.ts` — only `chat-action-policy-self-heal.test.ts` and
`module-enablement.test.ts` touch these keys directly, neither depends on legacy-wins timing).
This is a data-fidelity bug, not a security downgrade (neither `ask_each_time` nor `always_confirm`
is a trust escalation) — did not / do not believe this needs a `[SECURITY]` escalation, but flag to
coordinator anyway since it's outside Task 3's originally-scoped diff lines. **Per hard constraint:
this is a bug-fix to `action-policy.ts`'s own comparison logic, NOT a change to any family's
`defaultTier`/`allowedTiers`/grant/`policy.ts` — permitted under "fix the test, never the policy"
only insofar as it's fixing an actual code bug the plan's own required test exposed, not loosening
a policy value. If in doubt, escalate before changing.**

### Also found, not yet fixed: ID collision in the new test file

`tests/integration/tasks-action-policy-self-heal.test.ts:16` hardcodes
`legacyOnlyUserId = "00000000-0000-4000-8000-000000000004"` — **identical** to `userNeitherKey` in
`tests/integration/module-enablement.test.ts:697` (also inserted via raw `pg.Client` in that file's
own `beforeAll`). Both files insert a user row with this exact id into the same shared physical test
DB. Pick a different, non-colliding UUID for `legacyOnlyUserId` (e.g. end in `...005` or any id not
grepped elsewhere — `grep -rn "00000000-0000-4000-8000-000000000004" tests/integration/*.test.ts`
to confirm clear before running).

### Unrelated, pre-existing flake (leave alone)

`tests/integration/people/db-types.test.ts` failed with Postgres `"tuple concurrently updated"`
during `resetEmptyFoundationDatabase` — consistent with known multi-worker shared-DB reset
contention (agentmemory: "Multi-agent PG contention"). Not caused by this change. Did not
re-verify in isolation; low risk, standard flake pattern.

## Order for the successor

1. Fix the "both exist" tie-break bug in `packages/tasks/src/action-policy.ts` (prefer canonical
   unconditionally — see reasoning above). If uneasy calling this in-scope for Task 3, escalate to
   coordinator first rather than guessing.
2. Fix the ID collision in `tests/integration/tasks-action-policy-self-heal.test.ts`
   (`legacyOnlyUserId`).
3. Update the 2 pre-existing tests in `module-enablement.test.ts` + 1 in `tasks-web-contract.test.ts`
   per the failure notes above.
4. Re-run full `pnpm test:integration` in background — properly: DO NOT put `&` inside a
   `run_in_background: true` Bash call (the wrapper exits the instant it forks, giving a false
   "completed"). Either background the whole `pnpm test:integration ...` command directly with
   `run_in_background: true` and no trailing `&`, or use `ps -p <pid>` to confirm the real vitest
   process, then `Monitor` with an `until ! ps -p <pid> ...` loop. Expect ~805s. Confirm exit 0 and
   `people/db-types.test.ts` is the only remaining non-green item (and re-verify it's unrelated).
5. **Task 4**: live-path UAT proof. Reuse/invert `tests/e2e/live-uat-1310.spec.ts` on branch
   `1264-settings-self-operation` (worktree `/home/ben/Jarv1s/.claude/worktrees/1264-settings-self-operation`,
   re-resolve pane via `herdr pane list`, was `w1:p14D` last relay — drifts). Same tool
   (`settings.themeMode.set`, `granted_at_install`), same real dev instance, assert NO card appears
   and the tool auto-executes. Re-check dev instance PIDs first (API :3099, web :5175 —
   `ss -ltnp | grep -E '3099|5175'`, drift every relay). Login using the development sign-in details (kept outside the repository).
   Trap: `/api/chat/turn` blocks synchronously on confirm/timeout; unblock via POST
   `/api/chat/action-requests/<id>/resolve` `{"status":"confirmed"|"rejected"|"cancelled"}`.
   Do NOT write a new harness.
6. **Task 5**: PR description per plan lines 165-177 — see relay-6 for the full enumerated list of
   required elements (tasks-was-broken correction, `grantInstallTimeTrustIfUnset` justification,
   6-conditions-to-tests mapping, over-grant-by-design note, live-path link, UAT trigger-map rows,
   tasks compat helper stays load-bearing note, "two paths decide the same policy, document don't
   collapse" note, confirm_always negative control, both security findings, residual security fix,
   #1310 live-evidence corroboration). ALSO add: the tie-break bug fix (what/why), and note the
   pre-existing test updates as expected consequences of the fix, not scope creep.
7. Pre-push trio (`pnpm format:check && pnpm lint && pnpm typecheck`) + `git fetch origin main &&
   git rebase origin/main`.
8. Isolated gate DB: export a **fresh** `GATEDB=jarvis_gate_1311installgrant`, DROP/CREATE it,
   `JARVIS_PGDATABASE=$GATEDB pnpm verify:foundation` (expect rc=0, check the real exit code, never
   pipe through `tail`/`head` — that masks red). Drop after.
9. `coordinated-wrap-up`: clean tree, push, open PR, report to coordinator. **DO NOT MERGE.** Never
   touch board/milestones/merge.

## Hard constraints (verbatim, unchanged, still binding)

Never widen a `defaultTier`, change a grant, edit `allowedTiers`, or loosen `policy.ts` to make a
test pass — fix the test, never the policy; escalate `[SECURITY]` if a policy change looks
genuinely necessary. Path B self-heal (and any Task 3 code) must always RE-READ storage and return
the stored value, never assert `trusted_auto`.

## Trap discovered prior relay (also in agentmemory)

`/api/chat/turn` blocks synchronously until the triggered tool's confirm/timeout resolves — a
second POST while one is pending returns 409. Pending confirmations live in
`app.ai_assistant_action_requests` (NOT `app.action_requests`), audit trail in
`app.jarvis_action_audit_log`.
