# Plan: #1311 — install-time grant not applied to default-enabled modules

**Branch:** `1311-install-grant`. **Risk tier:** `security` (Ben sign-off required before merge).

## Gate 0

- **Spec:** no dedicated file under `docs/superpowers/specs/`. Spec-equivalent for this task is
  `docs/coordination/handoff-1311-install-grant-default-enabled.md` (coord-1262 worktree) +
  the coordinator's 2026-07-27 approval message (6 conditions, quoted in full under "Rulings
  ledger" below). This is a bug fix restoring already-approved #1263 behavior, not a new
  feature/module — CLAUDE.md's "spec before build" invariant targets those. **Flagging this
  reasoning to the coordinator explicitly; proceed unless they object.**
- **Task issue:** #1311 (bug report, root cause in body, no `task` label but is the tracked
  unit of work for this lane per the relay doc).
- The two `docs/superpowers/specs/2026-07-26-module-self-operation-*` files are **not
  applicable** — they spec new tools, not this fix (confirmed by section read, prior session).

## Seams check (file:line citations, verified against branch)

- Only two production writers of the install-time trust row, both enable-PATCH handlers that
  never fire for `defaultEnabled`/`required` modules: `packages/settings/src/routes-modules.ts:128`,
  `:308`. Neither is touched by this plan.
- Runtime choke point every tool dispatch passes through: `getFamilyTier` inside
  `buildActionPolicy` (private), `packages/chat/src/routes.ts:846-861`. `buildActionPolicy` is
  wrapped by `buildChatGatewayDependencies` (exported, `packages/chat/src/routes.ts:736`,
  documented as the test entry point for the real construction path).
- Tasks has its own bug in the same shape: `TasksCompatibilityHelper.getResolvedTaskChangesPolicy`,
  `packages/tasks/src/action-policy.ts:11-27`, returns `"ask_each_time"` when both preference
  keys are absent — no self-heal. `grantInstallTimeTrustIfUnset` (same file, `:43-56`) already
  exists and is safe to reuse (atomic, checks both canonical + legacy keys) — it is currently
  unreferenced from the unset-both branch.
- Grant primitive, already exported, already absence-safe:
  `grantSelfOperationForModule`, `packages/ai/src/gateway/self-operation.ts:444-459`, calls
  `repository.insertActionPolicyIfAbsent` only (never `setActionPolicy`).
- `insertActionPolicyIfAbsent` = `INSERT ... ON CONFLICT DO NOTHING`; `setActionPolicy` = UPSERT.
  Both in `packages/ai/src/repository.ts` (~1870-1970). This is the entire safety property per
  the coordinator's own verification.
- Build-time guarantees that make fail-closed (`null` → `resolvePolicy`'s `?? manifest.defaultTier`)
  safe: a family can never be both `granted_at_install` and `user_promotable`; a `confirm_always`
  tool can never declare `executionPolicy: "auto"` — `packages/ai/src/gateway/self-operation.ts`
  `assertBuiltInSelfOperationManifests`, ~280-433.
- `resolvePolicy`: `packages/ai/src/gateway/policy.ts` (read in full, 90 lines) — `tier =
getFamilyTier() ?? manifest.defaultTier`; `run` only if `tier === "trusted_auto" &&
executionPolicy === "auto" && allowedTiers.includes("trusted_auto")`.
- `packages/chat/package.json` already depends on `@jarv1s/ai` (workspace) — no new package
  dependency needed.
- No existing tests reference any of the above self-heal targets (confirmed by grep, prior
  session) — every test below is net-new.
- **Open/unverified, flagged not blocking:** whether the manifest type returned by
  `args.resolveActiveModules(actorUserId)` structurally satisfies `SelfOperationManifestInput`
  (`{ id, assistantTools }`). `getFamilyManifest` already indexes the same array by `.id` and
  `.assistantActionFamilies`, so the shape is very likely a superset — first build step (Task 2)
  confirms via `tsc`; if it doesn't satisfy the type, narrow with a local adapter, not a widened
  interface.

## Determinism boundary

N/A — no chat-visible model output changes. This only changes which of two deterministic paths
(`"run"` vs `"confirm"`) a tool dispatch takes, based on a DB-stored tier. No prompt changes.

## Design decisions

### Path A — generic self-heal (new, exported primitive)

New function in `packages/ai/src/gateway/self-operation.ts`, next to `grantSelfOperationForModule`:

```ts
export async function selfHealGrantedAtInstallTier(
  scopedDb: DataContextDb,
  repository: Pick<AiRepository, "listActionPolicies" | "insertActionPolicyIfAbsent">,
  manifest: SelfOperationManifestInput,
  familyId: string
): Promise<JarvisActionPermissionTier | null>;
```

Decision (behavior, not code): returns `null` immediately if no tool in
`manifest.assistantTools` has `actionFamilyId === familyId && selfOperationGrant ===
"granted_at_install"` (condition 4 — never heals `user_promotable`/`confirm_always` families).
Otherwise calls `grantSelfOperationForModule(scopedDb, repository, manifest)` inside try/catch;
on throw, returns `null` (condition 2, fail closed). On success, re-reads
`repository.listActionPolicies(scopedDb)` and returns the stored tier for
`(manifest.id, familyId)`, or `null` if still absent. The tier value itself is never passed in —
`grantSelfOperationForModule` hardcodes `"trusted_auto"` internally (condition 3).

Wiring: `packages/chat/src/routes.ts:846-861`, non-tasks branch of `getFamilyTier`. When
`listActionPolicies` finds no row, resolve the module manifest via
`args.resolveActiveModules(ctx.actorUserId)` (same call `getFamilyManifest` already makes), and
if found, delegate to `selfHealGrantedAtInstallTier`. If no manifest is found, return `null`
(unchanged fallback).

### Path B — tasks self-heal (reuse existing primitive)

`packages/tasks/src/action-policy.ts:18`. Change the `!canonical && !legacy` branch from
`return "ask_each_time"` to: call `this.grantInstallTimeTrustIfUnset(db)` inside try/catch; on
throw, return `"ask_each_time"` (fail closed). On success (or on any outcome, since the insert is
insert-if-absent and can succeed silently against a row that already exists), **re-read** —
`this.prefs.getWithMetadata<JarvisActionPermissionTier>(db, TASK_CHANGES_POLICY_KEY)` — and return
the stored value if it is `"trusted_auto"`, else `"ask_each_time"`. Never return `"trusted_auto"`
by assertion. (Coordinator-required change, 2026-07-27: Path A derives its answer from storage
after granting; Path B must match — asserting the outcome is a fail-open, since
`grantInstallTimeTrustIfUnset`'s insert-if-absent succeeds silently even when a row already exists,
including one the user set to `always_confirm` via the legacy key path.) `grantInstallTimeTrustIfUnset`
is kept unchanged — it uniquely guards the legacy `tasks.agency_auto_execute` key that the generic
primitive doesn't know about (exit criterion #2 justification, goes in the PR description).

## Tasks (TDD, each commits green)

**Task 1 — `selfHealGrantedAtInstallTier` primitive.**
Files: `packages/ai/src/gateway/self-operation.ts` (add + export), new
`tests/unit/self-heal-granted-at-install.test.ts` (mock repository, no DB).
Tests (behavior + why a broken impl fails them):

1. Family declared `granted_at_install` in the manifest, no stored policy → returns
   `"trusted_auto"` and `insertActionPolicyIfAbsent` was called once. Fails against a no-op stub.
2. Family declared `confirm_always` or `user_promotable` → returns `null`,
   `insertActionPolicyIfAbsent` NOT called. Fails against an impl that heals any unset family
   (condition 4 regression guard).
3. `insertActionPolicyIfAbsent` throws → returns `null`, not `"trusted_auto"`. Fails against an
   impl that assumes the insert succeeded (condition 2 regression guard).

**Task 2 — wire into chat's `getFamilyTier`.**
Files: `packages/chat/src/routes.ts`, extend `tests/integration/action-policy-install-grants.test.ts`
or new `tests/integration/chat-action-policy-self-heal.test.ts` (real DB, via
`buildChatGatewayDependencies` — the exported real-construction entry point).
Tests:

1. `granted_at_install` family, no prior row, real DB → `getFamilyTier` returns `"trusted_auto"`
   without any explicit enable action having run. Fails on current code (returns `null` today —
   this is the #1311 symptom itself).
2. **Revocation-survival (condition 5):** pre-set `always_confirm` via
   `repo.setActionPolicy` for a `granted_at_install` family, then dispatch → `getFamilyTier`
   still returns `"always_confirm"`. Fails against any self-heal that checks presence after
   already having decided to heal, or that uses upsert semantics anywhere in the path.
3. **Confirm-always regression (condition 6, real test not just structural reasoning):** a
   `confirm_always` family, no prior row → `getFamilyTier` returns `null` (never healed). Fails
   if a future change widens which families qualify for self-heal.

**Task 3 — tasks path fix.**
Files: `packages/tasks/src/action-policy.ts`, new
`tests/integration/tasks-action-policy-self-heal.test.ts` (real DB, DataContextRunner).
Tests:

1. Neither canonical nor legacy key set → `getResolvedTaskChangesPolicy` returns
   `"trusted_auto"`, and the canonical key is now present in `app.preferences`. Fails on current
   code (returns `"ask_each_time"` — the tasks-side #1311 symptom the coordinator's handoff
   missed).
2. **Revocation-survival, tasks side:** `setTaskChangesPolicy(db, "always_confirm")` first, then
   `getResolvedTaskChangesPolicy` still returns `"always_confirm"`. Fails against any change that
   calls `grantInstallTimeTrustIfUnset` unconditionally instead of only in the both-absent branch.
3. **Re-read, not assert (coordinator-required):** a test that races a concurrent
   `setTaskChangesPolicy(db, "always_confirm")` in between two calls into the both-absent branch —
   simulate by pre-inserting an `always_confirm` row directly, then invoking the both-absent code
   path — asserts the return is `"always_confirm"`, not `"trusted_auto"`. Fails against an
   implementation that returns `"trusted_auto"` by assertion after calling
   `grantInstallTimeTrustIfUnset` instead of re-reading storage.
4. Legacy-only branch (`legacy` set, `canonical` unset) unchanged — existing behavior regression
   check, cheap to add alongside.

**Task 4 — live-path UAT (exit criterion #3).**
Trigger-map lookup returned empty for the three touched files — using judgement per the relay
doc: this changes chat confirm-card behavior, a live UI surface, so proof is required regardless.
Plan: on a live dev instance, dispatch a `granted_at_install` tool on a `defaultEnabled` module
(e.g. a sports or news content command) with **no prior explicit enable action**, and confirm zero
confirm card appears; record the dispatch plus the resulting `app.preferences` row and bounded
request/log evidence. Post as a `gh pr comment` at wrap-up. If no existing Playwright spec covers this
flow, a manual UAT walkthrough with recorded assertions and bounded logs is the fallback — record which.

**Task 5 — PR description + trigger-map row.**
PR description must state: (a) correction — tasks was also broken, not just settings/news/sports,
superseding the coordinator's original handoff claim; (b) why `grantInstallTimeTrustIfUnset`
stays (legacy-key guard, exit criterion #2); (c) mapping from each of the coordinator's 6
conditions to the test that enforces it; (d) live-path proof link; (e) explicit note that Path A's
`grantSelfOperationForModule` call grants **every** `granted_at_install` family declared in the
module's manifest, not just the one requested — correct by design (install-time grant means all
of them; insert-if-absent means it cannot clobber), called out so a reviewer doesn't read it as an
over-grant bug.
Also: add a row (or rows) to the UAT trigger map for `packages/chat/src/routes.ts`,
`packages/ai/src/gateway/self-operation.ts`, `packages/tasks/src/action-policy.ts` pointing at
the live-path spec/flow used in Task 4, so the next lane touching this surface gets the trigger
automatically instead of relying on judgement again.

## Kill gate

**After Task 2's tests pass and Task 4's UAT check is spot-verified for the generic path** (before
starting Task 3): if the generic self-heal does not eliminate the confirm card for a
`defaultEnabled` module's `granted_at_install` tool on a live dev instance, STOP — do not proceed
to the tasks-specific fix. Escalate to the coordinator with what was observed; the design may be
wrong at a level Task 3 would just repeat. Owner: build agent; coordinator confirms whether to
proceed or redesign.

## Verification (unpiped, expected exit codes)

```bash
pnpm format:check && pnpm lint && pnpm typecheck > /tmp/1311-pretrio.log 2>&1; echo "EXIT=$?"
# expected EXIT=0
```

```bash
git fetch origin main && git rebase origin/main > /tmp/1311-rebase.log 2>&1; echo "EXIT=$?"
# expected EXIT=0
```

```bash
GATEDB=jarvis_gate_1311installgrant
docker exec jarv1s-postgres psql -U postgres -c "DROP DATABASE IF EXISTS $GATEDB;"
docker exec jarv1s-postgres psql -U postgres -c "CREATE DATABASE $GATEDB;"
export JARVIS_PGDATABASE=$GATEDB
( pnpm verify:foundation > /tmp/1311-vf.log 2>&1; echo "### FINAL verify:foundation rc=$?" >> /tmp/1311-vf.log ) &
wait
grep '### FINAL' /tmp/1311-vf.log
# expected rc=0
docker exec jarv1s-postgres psql -U postgres -c "DROP DATABASE IF EXISTS $GATEDB;"
```

## Rulings ledger (coordinator, 2026-07-27, verbatim)

Approved the choke-point design "to plan against, with conditions" after independently verifying
`insertActionPolicyIfAbsent` (INSERT ON CONFLICT DO NOTHING) vs `setActionPolicy` (explicit UPSERT)
is the entire safety property. Six binding conditions, mapped to enforcement above:

1. Self-heal MUST call `insertActionPolicyIfAbsent`, never `setActionPolicy` → structural (Path A
   reuses `grantSelfOperationForModule`, which only calls the absent-safe primitive; Path B reuses
   `grantInstallTimeTrustIfUnset`, same primitive).
2. Fail closed on insert throw → Task 1 test 3, Path B try/catch.
3. Tier comes from manifest declaration only, never tool input/caller → structural
   (`grantSelfOperationForModule` hardcodes `"trusted_auto"`; Path B hardcodes it directly).
4. Heal ONLY `granted_at_install` families, never `user_promotable`/`confirm_always` → Task 1
   test 2.
5. Revocation-survival test required → Task 2 test 2, Task 3 test 2.
6. Keep exit criterion 4 as a real test, not just structural reasoning → Task 2 test 3.

Also corrected their own handoff: tasks was NOT unaffected ("tasks appears to work" was wrong) —
my earlier finding supersedes it, stated in the PR description (Task 5).

New gate from the same message: live-path gate now overrides auto-merge at every risk tier — PR
does not merge without a live e2e proof comment (Task 4).
