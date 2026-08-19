# Plan — TasksRepository.create idempotency probe owner scoping (#1055)

**Spec:** `docs/superpowers/specs/2026-08-09-wave-3-action-audit-truth.md` (Lane B)
**Issue:** Part of #1055 (`task` label, OPEN)
**Tier:** security
**Branch:** `w3b-audit-truth`

## Seams check (file:line citations, verified on this branch)

- Bug site: `packages/tasks/src/repository.ts:205-211` — the `create()` idempotency SELECT filters
  on `source` and `external_key` only. Comment at `:204` claims "RLS scopes the query to the
  current actor" — false today.
- RLS reality: `packages/tasks/sql/0019_tasks_owner_or_share.sql:12-22` — `tasks_select` is
  owner-**OR-share** (`owner_user_id = current_actor OR app.has_share('task', id, 'view')`), not
  owner-only. So the probe's `executeTakeFirst()` can return a row owned by someone else who has
  shared it with the caller.
- Existing idiom for the fix already used twice in the same file — `packages/tasks/src/repository.ts:191`
  (`hasRecurringSeries`) and `:265` (`create`'s own `parentTaskId` ownership check), both:
  `.where(sql<boolean>\`owner_user_id = app.current_actor_user_id()\`)`. The fix reuses this exact
pattern — no new helper, no new import (`sql`already imported at`:3`).
- `CreateTaskInput`/return type: `packages/tasks/src/repository.ts:27-42` (`create` returns
  `Promise<Task>`); `Task`/`TasksTable.owner_user_id` exists at `packages/db/src/types.ts:240` —
  available on every row `create()` returns or reads, no type change needed.
- Test fixtures already present and sufficient — no new fixture code needed:
  `tests/integration/tasks-helpers.ts:153` (`userAContext`), `:160` (`userBContext`);
  `tests/integration/test-database.ts:31-32` (`ids.userA`, `ids.userB`); `SharesRepository.grant`
  used identically at `tests/integration/tasks.test.ts:263-271` (view-share grant pattern).
- Existing same-owner idempotency test to preserve green: `tests/integration/tasks.test.ts:781-813`
  (`"create defaults to Personal list, accepts new fields, and is idempotent on (source,
external_key)"`). The fix only narrows the query's row set — this test's own-user
  create→create-again path is unaffected.
- Confirmed non-goal from the issue body (`gh issue view 1055`): "Not exploitable for data
  leakage (it's a skip-create, not a cross-write)" — the archived→suggested resurface branch
  (`:213-235`) only reaches an `UPDATE`, which RLS's `tasks_update` policy (same SQL file, `:33-50`)
  already restricts to owner-or-manage-share. This plan does not touch that branch; scoping the
  SELECT alone closes the misclassification.

No open questions — every assumption above is cited against the current tree.

## Determinism boundary

N/A — no model output, no user-facing UI surface. Pure backend RLS-adjacent data-access fix
returning a typed `Task` row; no chat/model turn involved.

## Phase 1 (only phase — single file, single query change)

**Task 1 — red: cross-owner regression test.**
Add to `tests/integration/tasks.test.ts`, in the same `describe` block, directly after the existing
idempotency test (after line 813):

```ts
it("does not treat a cross-owner shared task as a duplicate on (source, external_key) collision", async () => {
  const ownedByA = await dataContext.withDataContext(userAContext(), (db) =>
    repository.create(db, {
      title: "A's synced item",
      source: "sync",
      externalKey: "sync:collide-1"
    })
  );
  await dataContext.withDataContext(userAContext(), (db) =>
    sharesRepository.grant(db, {
      resourceType: "task",
      resourceId: ownedByA.id,
      ownerUserId: ids.userA,
      granteeUserId: ids.userB,
      level: "view"
    })
  );

  const createdByB = await dataContext.withDataContext(userBContext(), (db) =>
    repository.create(db, { title: "B's own item", source: "sync", externalKey: "sync:collide-1" })
  );

  expect(createdByB.id).not.toBe(ownedByA.id);
  expect(createdByB.owner_user_id).toBe(ids.userB);
  expect(createdByB.title).toBe("B's own item");
});
```

Run: `pnpm --filter @moss/tasks... exec vitest run ../../tests/integration/tasks.test.ts -t "cross-owner shared task" > /tmp/w3b-red.log 2>&1; echo "EXIT=$?"` from repo root — expect **non-zero exit**, failure on `expect(createdByB.id).not.toBe(ownedByA.id)` (today's code returns A's shared row to B). If the grep-scoped test command doesn't resolve the workspace filter, fall back to running the full `tests/integration/tasks.test.ts` file with the same `-t` filter from repo root using the project's existing vitest config — do not invent a new one.

**Task 2 — green: owner-scope the probe.**
`packages/tasks/src/repository.ts:198-211` — add one `.where(...)` clause and correct the comment:

```ts
    // Idempotency: when externalKey is provided, check if a matching task already exists
    // for this (source, external_key) pair, scoped to the current actor's own rows.
    // tasks_select RLS is owner-OR-share, so an explicit owner filter is required here —
    // relying on RLS alone would let a shared task from another owner read as "this actor's
    // existing row" and skip creating the actor's own copy (#1055).
    if (input.externalKey != null) {
      const existing = await scopedDb.db
        .selectFrom("app.tasks")
        .selectAll()
        .where("source", "=", source)
        .where("external_key", "=", input.externalKey)
        .where(sql<boolean>`owner_user_id = app.current_actor_user_id()`)
        .executeTakeFirst();
```

No other lines in `create()` change. Re-run the same targeted command — expect **exit 0**.

**Task 3 — confirm no regression on the pre-existing same-owner test.**
`pnpm --filter @moss/tasks... exec vitest run ../../tests/integration/tasks.test.ts > /tmp/w3b-full.log 2>&1; echo "EXIT=$?"` — expect **exit 0**, full file green (existing idempotency test at
`:781` plus the new test at Task 1).

Each task commits separately (`git add packages/tasks/src/repository.ts` / `git add
tests/integration/tasks.test.ts`), green before commit, `Co-Authored-By: Claude` trailer.

## Kill gate

None needed — this is the only phase; a single query-scope change with a proving test. If Task 1's
red test does not actually fail against current code (i.e., the premise is already wrong), stop and
re-escalate to the coordinator rather than committing a no-op fix. Call made by the builder
(inspecting the red-run log before proceeding to Task 2).

## Verification (unpiped, exit code stated)

1. `pnpm --filter @moss/tasks... exec vitest run ../../tests/integration/tasks.test.ts > /tmp/w3b-full.log 2>&1; echo "EXIT=$?"` — expect `EXIT=0`. (Uses the isolated gate DB per `coordinated-wrap-up`'s recipe — not the dev DB.)
2. `pnpm format:check && pnpm lint && pnpm typecheck` (pre-push trio) — expect all exit 0.
3. Full gate at wrap-up per `coordinated-wrap-up` (isolated DB) — expect exit 0.

## Exit criteria mapping (spec)

- "A cross-owner fixture proves `create()` no longer treats another owner's shared row as a
  duplicate, and that same-owner dedupe still works" → Task 1's new test + the pre-existing test at
  `tasks.test.ts:781`, both green after Task 2.
- Opus adversarial QA verdict as `gh pr comment` → coordinator's QA step after wrap-up, not this
  plan's job.
- No live-path proof required — spec's Process Gates section: "Lanes B and C are internal and take
  focused automated evidence plus adversarial QA."
