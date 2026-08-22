# Plan: 1339-C — degrade a failed tasks heal closed

**Issue:** #1530 ([1339-C] Degrade a failed tasks heal closed), part of #1339.
**Spec:** docs/superpowers/specs/2026-08-10-1339-security-review-followups.md, section "1339-C:
degrade a failed tasks heal closed" (lines 164-203).
**Tier:** security.

## Seams check (file:line citations)

- Current buggy behavior: `packages/tasks/src/action-policy.ts:41-48`
  (`healInstallGrantAndReread` awaits `grantInstallTimeTrustIfUnset(db)` unguarded — a rejection
  propagates as an uncaught promise rejection instead of resolving to `ask_each_time`).
- Call site that must keep working: `packages/tasks/src/action-policy.ts:18`
  (`getResolvedTaskChangesPolicy`'s neither-row branch calls `healInstallGrantAndReread`).
- `grantInstallTimeTrustIfUnset` signature to spy on: `packages/tasks/src/action-policy.ts:64-77`
  (public async method, single atomic insert, no return value used by caller).
- `MossActionPermissionTier` type (return type, includes `"ask_each_time"`):
  `packages/module-sdk` — imported at `packages/tasks/src/action-policy.ts:3`.
- Existing DB-backed suite this change must not break:
  `tests/integration/tasks-action-policy-self-heal.test.ts:51-64` (neither-set case still expects
  `trusted_auto` on the **successful** insert path — untouched by this change since the guard only
  changes behavior on rejection).
- Composed dispatch suite (1339-A, already merged) that must keep passing unmodified:
  `tests/integration/chat-action-policy-self-heal.test.ts:236-258`.
- Unit-test convention for spying on a class method without a real DB:
  `tests/unit/action-policy-routes.test.ts:1-45` (vitest `vi.spyOn`/`vi.fn`, no live DB).
- `DataContextDb` is a branded type used only as an opaque token here — the unit test does not need
  a real one; `{} as DataContextDb` is enough since the spy replaces the DB round-trip entirely.

## Task 1 — fail closed in `healInstallGrantAndReread`

**File:** `packages/tasks/src/action-policy.ts`

Change only this method (signature unchanged):

```ts
async healInstallGrantAndReread(db: DataContextDb): Promise<MossActionPermissionTier> {
  try {
    await this.grantInstallTimeTrustIfUnset(db);
  } catch {
    return "ask_each_time";
  }
  const reread = await this.prefs.getWithMetadata<MossActionPermissionTier>(
    db,
    TASK_CHANGES_POLICY_KEY
  );
  return reread?.value ?? "ask_each_time";
}
```

Decisions locked by the spec (do not deviate):

- Attempt the insert exactly once — no retry.
- On rejection: return `"ask_each_time"` immediately. Do not reread canonical storage, do not
  write the legacy key, do not rethrow.
- On success (no throw): behavior is byte-identical to today — reread canonical, fall back to
  `"ask_each_time"` if the reread somehow finds nothing.
- No new abstraction, no shared helper, no logger, no retry loop (per spec's shared scope rules,
  spec lines 107-108).

## Task 2 — unit test proving the fallback

**File (new):** `tests/unit/tasks-action-policy-fallback.test.ts`

Test cases (behavior + why they'd fail against the current/broken implementation):

1. **"a rejected install-grant attempt resolves to ask_each_time, not a rejected promise"**
   — `vi.spyOn(helper, "grantInstallTimeTrustIfUnset").mockRejectedValue(new Error("insert failed"))`.
   Call `getResolvedTaskChangesPolicy` from a both-absent state (mock `prefs.getWithMetadata` to
   return `undefined` for both keys). Assert the call resolves (not rejects) to `"ask_each_time"`.
   Fails today because the unguarded `await` propagates the rejection out of
   `getResolvedTaskChangesPolicy` instead of resolving.
2. **"the insertion is attempted exactly once; no retry"** — same setup as (1); assert
   `grantInstallTimeTrustIfUnset` spy was called exactly 1 time after the resolved call.
   (Guards against a future retry-loop regression; passes today too, but pins the "exactly once"
   contract from the spec.)
3. **"a rejected attempt never reaches the canonical reread"** — same setup as (1); assert
   `prefs.getWithMetadata` was never called after the rejection (only the initial both-absent
   probe reads, not a third read from inside `healInstallGrantAndReread`). Distinguishes "return
   ask_each_time immediately" from "reread anyway and coincidentally get ask_each_time".
4. **"the existing success path is unchanged: reread still runs and returns the stored tier"**
   — `grantInstallTimeTrustIfUnset` spy resolves normally (no throw); `prefs.getWithMetadata`
   mocked to return `{ value: "trusted_auto" }` on the post-insert reread. Assert result is
   `"trusted_auto"` and the reread mock was called. Regression guard for the untouched branch.

Mock shape: construct `new TasksCompatibilityHelper(prefsMock)` where `prefsMock` is a
hand-rolled object satisfying the subset of `PreferencesPort` actually called
(`getWithMetadata`), via `vi.fn()`. Pass `{} as DataContextDb` as the `db` argument — the spy on
`grantInstallTimeTrustIfUnset` intercepts before the real DB code runs, and the `getWithMetadata`
mock does the same for the reread, so no real database is touched and `verify-gate` is not needed
for this file.

## Verification

```bash
pnpm vitest run tests/unit/tasks-action-policy-fallback.test.ts > /tmp/1530-unit.log 2>&1; echo "EXIT=$?"
```

Expected: `EXIT=0`, 4 passing tests.

Through verify-gate (DB-backed, per CLAUDE.md — use the `verify-gate` skill, do not run raw):

```bash
pnpm vitest run tests/integration/tasks-action-policy-self-heal.test.ts tests/integration/chat-action-policy-self-heal.test.ts
```

Expected: all existing tests still pass, unchanged (this task does not touch DB-backed test files).

Pre-push trio (per coordinated-build step 3b):

```bash
pnpm format:check && pnpm lint && pnpm typecheck
```

## Kill gate

Single phase — this is a ~10 line change plus one new unit test file, scoped to one method. If
task 1's `try/catch` cannot be made to satisfy both the rejection case and the untouched success
case without touching `getResolvedTaskChangesPolicy`'s precedence logic (spec line 188 forbids
that), stop and escalate to the coordinator rather than widening scope. Owner: build agent
(this session); escalation target: coordinator.

## Non-goals (spec lines 232-235, reaffirmed)

- No retry loop, no shared self-heal abstraction, no logger, no new policy tier, no migration.
- Do not touch `getResolvedTaskChangesPolicy`'s canonical/legacy precedence.
- Do not touch task-sharing permission logic (PR #1654 / #1511 territory) — out of scope, collision
  risk per handoff doc.
