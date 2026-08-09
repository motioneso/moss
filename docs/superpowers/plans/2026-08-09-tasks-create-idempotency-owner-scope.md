# Plan — TasksRepository.create idempotency probe owner scoping (#1055)

**Spec:** `docs/superpowers/specs/2026-08-09-wave-3-action-audit-truth.md` (Lane B)
**Issue:** Part of #1055 (`task` label, OPEN)
**Tier:** security
**Branch:** `w3b-audit-truth`
**Fable plan-review:** APPROVED (relayed via Coordinator) — required addition: cite
`tasks_source_external_key_idx` (owner_user_id, source, external_key) at
`packages/tasks/sql/0039_tasks_foundation.sql:80-81` in the fix's code comment as proof per-owner
idempotency was always the schema's intent. Folded into Task 2 below.

## STATE AS OF THIS CHECKPOINT (read this first — successor start here)

- **Ground truth verified by `git status`/`grep` at checkpoint time: Task 1's RED test does NOT
  exist on disk.** An earlier (pre-compaction) session's summary claimed it had written the test
  into `tests/integration/tasks.test.ts` via the Edit tool, but that edit never actually landed —
  `git status --short` shows zero modifications to that file, and
  `grep -n "cross-owner shared task" tests/integration/tasks.test.ts` returns nothing. **Do not
  trust that prior claim. Start Task 1 fresh** using the exact test code in "Task 1" below (it has
  never been written). This also fully explains an earlier false alarm: a test run that reported
  "31 passed (31)" against unmodified `repository.ts` was just the 31 pre-existing tests — there
  was no new test in the file to fail. That anomaly is resolved, not a real bug — ignore it.
- Task 2 (GREEN fix) is **NOT YET APPLIED** to `packages/tasks/src/repository.ts` (confirmed via
  `git status` — file untouched).
- **Environment gotcha found + fixed this session, durable for any future fresh worktree:**
  Integration tests boot `createApiServer(...)` which calls `registerBuiltInApiRoutes`, which
  reads `dist/app-map.json` (`packages/module-registry/src/index.ts:2220` via
  `packages/settings/src/app-map.ts:28`). A fresh worktree has no `dist/`, so the whole test file
  reported as **skipped** (`Test Files 1 skipped`) rather than erroring — misleading. Fix:
  `pnpm build:app-map` (script: `tsx scripts/build-app-map.ts`) before any integration test run in
  a fresh worktree. Ran once this session — artifact now exists on disk in this worktree, should
  not need re-running unless the worktree is recreated.
- Gate DB in use this session: `jarvis_gate_w3b_1055` (created via `docker exec jarv1s-postgres
  psql`). Still exists — **DROP it when the lane finishes** per `verify-gate` skill.
- Recommended test invocation for the successor (avoid the `pnpm test:tasks -- -t '...'` form —
  it echoes a literal `--` before `-t` into the forwarded args, which may cause the filter to be
  ignored; use `pnpm test:tasks -t "cross-owner shared task"`, no extra `--`, and confirm from the
  log which individual test(s) ran/failed, not just the aggregate pass count).

## Seams check (file:line citations, verified on this branch)

- Bug site: `packages/tasks/src/repository.ts:205-211` — the `create()` idempotency SELECT filters
  on `source` and `external_key` only. Comment at `:204` claims "RLS scopes the query to the
  current actor" — false today.
- RLS reality: `packages/tasks/sql/0019_tasks_owner_or_share.sql:12-22` — `tasks_select` is
  owner-**OR-share**, not owner-only.
- Existing idiom for the fix, used twice already in the same file — `:191` (`hasRecurringSeries`)
  and `:265` (`create`'s own `parentTaskId` check): `.where(sql<boolean>\`owner_user_id =
  app.current_actor_user_id()\`)`. `sql` already imported at `:3`.
- Unique index proving per-owner idempotency was always intended:
  `packages/tasks/sql/0039_tasks_foundation.sql:80-81` —
  `CREATE UNIQUE INDEX ... tasks_source_external_key_idx ON app.tasks (owner_user_id, source,
  external_key) WHERE external_key IS NOT NULL;`
- Test fixtures already present, no new fixture code needed: `tests/integration/tasks-helpers.ts:153`
  (`userAContext`), `:160` (`userBContext`); `tests/integration/test-database.ts:31-32`
  (`ids.userA`, `ids.userB`); `SharesRepository.grant` pattern at `tests/integration/tasks.test.ts:263-271`.
- Existing same-owner idempotency test to preserve green:
  `tests/integration/tasks.test.ts:781-813`.
- Non-goal (confirmed via `gh issue view 1055`): not exploitable for data leakage — skip-create,
  not cross-write. The archived→suggested resurface branch (`:213-235`) only reaches an UPDATE,
  already owner-or-manage-share restricted. Out of scope for this fix.

## Determinism boundary

N/A — pure backend RLS-adjacent data-access fix, no model/UI involvement.

## Phase 1 (only phase)

**Task 1 — red: cross-owner regression test.** WRITTEN (see tasks.test.ts, ~line 815), not yet
confirmed correctly red (see Open Question above), not yet committed.

```ts
it("does not treat a cross-owner shared task as a duplicate on (source, external_key) collision", async () => {
  const ownedByA = await dataContext.withDataContext(userAContext(), (db) =>
    repository.create(db, { title: "A's synced item", source: "sync", externalKey: "sync:collide-1" })
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

Run (from repo root, gate DB exported): `export JARVIS_PGDATABASE=jarvis_gate_w3b_1055 && pnpm
build:app-map && pnpm test:tasks -t "cross-owner shared task" > /tmp/w3b-red.log 2>&1; echo
"EXIT=$?"` — **use this exact form, no extra `--`**. Expect **non-zero exit**, failure on
`expect(createdByB.id).not.toBe(ownedByA.id)`.

**Task 2 — green: owner-scope the probe.**
`packages/tasks/src/repository.ts:198-211` — add one `.where(...)` clause and correct the comment
(includes Fable's required index citation):

```ts
    // Idempotency: when externalKey is provided, check if a matching task already exists
    // for this (source, external_key) pair, scoped to the current actor's own rows.
    // tasks_select RLS is owner-OR-share, so an explicit owner filter is required here — relying
    // on RLS alone would let a shared task from another owner read as "this actor's existing row"
    // and skip creating the actor's own copy (#1055). The unique index
    // tasks_source_external_key_idx (owner_user_id, source, external_key) already scopes
    // uniqueness per-owner, confirming per-owner idempotency was always the schema's intent.
    if (input.externalKey != null) {
      const existing = await scopedDb.db
        .selectFrom("app.tasks")
        .selectAll()
        .where("source", "=", source)
        .where("external_key", "=", input.externalKey)
        .where(sql<boolean>`owner_user_id = app.current_actor_user_id()`)
        .executeTakeFirst();
```

Re-run same command — expect **exit 0**.

**Task 3 — confirm no regression.** `export JARVIS_PGDATABASE=jarvis_gate_w3b_1055 && pnpm
build:app-map && pnpm test:tasks > /tmp/w3b-full.log 2>&1; echo "EXIT=$?"` — expect **exit 0**,
full file green (pre-existing idempotency test at `:781` plus new test).

Each task commits separately (`git add packages/tasks/src/repository.ts` /
`git add tests/integration/tasks.test.ts`), green before commit, `Co-Authored-By: Claude` trailer.

## Kill gate

If Task 1's red test does not actually fail against current code once correctly filtered/run
(see Open Question), stop and re-escalate to the coordinator rather than committing a no-op fix.

## Verification (unpiped, exit code stated)

1. `pnpm --filter @moss/tasks... exec vitest run ../../tests/integration/tasks.test.ts > /tmp/w3b-full.log 2>&1; echo "EXIT=$?"` — expect `EXIT=0`.
2. `pnpm format:check && pnpm lint && pnpm typecheck` — expect all exit 0.
3. Full gate at wrap-up per `coordinated-wrap-up` (isolated DB) — expect exit 0.

## Exit criteria mapping (spec)

- Cross-owner fixture proves `create()` no longer treats another owner's shared row as a
  duplicate, same-owner dedupe still works → Task 1's new test + `tasks.test.ts:781`, both green
  after Task 2.
- Opus adversarial QA verdict as `gh pr comment` → coordinator's QA step, not this plan's job.
- No live-path proof required (backend-only, spec's Process Gates: lanes B/C are internal).
