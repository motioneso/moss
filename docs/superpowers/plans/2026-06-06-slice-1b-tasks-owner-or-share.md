# Slice 1b — Tasks & RLS Probe → Owner-or-Share Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the core RLS probe (`app.rls_probe_items`) and the Tasks module (`app.tasks`) from the legacy workspace-visibility + `resource_grants` access model to the new **owner-or-share** model built in Slice 1a (`app.has_share`), with the full `pnpm verify:foundation` gate staying green.

**Architecture:** Each conversion is a single new versioned SQL migration that `DROP`s and re-`CREATE`s the table's RLS policies so they read `owner_user_id = app.current_actor_user_id() OR app.has_share(<resource_type>, id, <level>)` instead of consulting `visibility`/`workspace_id`/`resource_grants`. No schema columns are dropped and `AccessContext.workspaceId` is **untouched** — those leftovers stay inert until Slice 1f, so this slice converts independently and the suite stays green throughout. Integration tests that previously asserted workspace-visibility / `resource_grants` access are rewritten to use `app.shares` (via `SharesRepository`).

**Tech Stack:** Postgres RLS (raw versioned SQL), Kysely, Vitest integration tests against the Docker Postgres from `pnpm db:up`, pg-boss worker.

---

## Decisions Locked (from brainstorming, do not re-litigate)

- **Scope = RLS substrate only.** Swap the access model in new migrations + rewrite the affected
  integration tests. **Leave** `tasks.visibility`, `tasks.workspace_id`, `rls_probe_items.visibility`,
  `rls_probe_items.workspace_id`, the `TaskDto`/`packages/shared/src/tasks-api.ts` contract, the
  Tasks routes (`ensureWorkspaceVisibilityContext`, workspace parsing), `AccessContext.workspaceId`,
  the `app.has_resource_grant*` helpers, and `app.resource_grants` **in place but inert** — they are
  removed in Slice 1f. Do **not** prune the Tasks API or `AccessContext` in this slice.
- **No new share endpoints.** 1b does not expose grant/revoke HTTP routes. Shares are created
  directly via `SharesRepository`/SQL inside tests to exercise the RLS conversion. User-facing
  granting UX is a later, separate concern.
- **`task_activity` policies are unchanged.** They gate on parent-task visibility via an
  RLS-filtered `EXISTS (SELECT 1 FROM app.tasks parent_task WHERE parent_task.id = task_id)`; since
  the subquery runs under the new `tasks_select` policy, activity visibility inherits the owner-or-share
  model automatically. Verify with a test; do not write a new activity policy.

## Read First (the executor has zero context)

Before touching anything, read these to ground the edits:

- `docs/superpowers/specs/2026-06-06-memory-data-model-design.md` — §"Sharing — `shares`",
  §"Changes to the Existing Scaffold", §"Testing Strategy". The owner-OR contract of `app.has_share`
  is documented there.
- `infra/postgres/migrations/0017_shares.sql` — the `app.has_share(text, uuid, text)` function
  (share half only; STABLE SECURITY DEFINER; granted to `jarvis_app_runtime` **and**
  `jarvis_worker_runtime`) and `app.share_level_rank`.
- `infra/postgres/migrations/0002_app_rls.sql` (lines 95–117) — the **current** `rls_probe_items_select`
  policy you are replacing.
- `packages/tasks/sql/0003_tasks_module.sql` (lines 117–215) — the **current** `tasks_select` /
  `tasks_insert` / `tasks_update` / `task_activity_*` policies you are replacing.
- `tests/integration/shares.test.ts` — the canonical pattern for `withDataContext(ctx(userId), …)`,
  `SharesRepository`, and `ids.userA/userB/adminUser`.
- `tests/integration/tasks.test.ts` and `tests/integration/foundation.test.ts` — the tests you will
  edit. Note the exact `it(...)` titles called out below before deleting/replacing.

## Environment

- `export PATH="$HOME/.local/bin:$PATH"` (corepack pnpm shim) — or use `corepack pnpm <script>`.
- `pnpm db:up` before any integration test.
- **Editing an unreleased migration?** You are _adding_ new migrations here, not editing applied
  ones, so the checksum guard won't fire. But if you must reset, `pnpm db:reset`
  recreates the volume fresh.
- Gate: `pnpm verify:foundation` (lint, format:check, check:file-size, typecheck, db:migrate,
  test:integration). Must end green.

## File Structure

- **Create** `infra/postgres/migrations/0018_probe_owner_or_share.sql` — replaces the probe SELECT
  policy. Infra layer (core probe lives in `infra/`), runs in version order before module migrations.
- **Create** `packages/tasks/sql/0019_tasks_owner_or_share.sql` — replaces the three `app.tasks`
  policies. Module-owned migration; auto-discovered via `tasksModuleSqlMigrationDirectory` in
  `packages/module-registry/src/index.ts` (no registry edit needed — the directory is already wired).
- **Modify** `tests/integration/foundation.test.ts` — migration-list assertion (+0018, +0019) and
  rewrite the probe grant/workspace access + pg-boss workspace cases to shares.
- **Modify** `tests/integration/tasks.test.ts` — add a `SharesRepository` + a user-B context helper;
  rewrite the resource-grant and workspace-visibility access cases to shares; convert any seed rows
  that insert into `app.resource_grants` or rely on `'workspace'` visibility for cross-user access.

Migration numbering: `0001`–`0017` are taken (split across `infra/` and module `sql/` dirs; global
sequence is contiguous through 0017). Use `0018` (infra, probe) and `0019` (tasks module). Both are
recorded in the single `app.schema_migrations` table, so both must be appended to the
`foundation.test.ts` migration-list assertion.

---

### Task 1: Convert the core RLS probe to owner-or-share

**Files:**

- Create: `infra/postgres/migrations/0018_probe_owner_or_share.sql`
- Test: `tests/integration/foundation.test.ts` (modify)

- [ ] **Step 1: Write the failing test (shares-based probe access)**

In `tests/integration/foundation.test.ts`, add this test inside the `describe("MVP foundation scaffold", …)`
block, near the existing access cases (after the "prevents a user from reading another user's
unshared private row" case). It models `shares.test.ts`. Use the existing context/seed helpers in
the file (read them first — there is a session→context helper and an `ids` import with
`userA`/`userB`/`adminUser`; reuse them rather than inventing new ones):

```ts
it("allows probe access through a view share", async () => {
  // Seed: userB owns nothing here; userA owns a probe row and shares 'view' to userB.
  // (Use the file's existing probe-seed helper to insert a row owned by ids.userA, then:)
  await runner.withDataContext(contextFor(ids.userA), async (scopedDb) => {
    await sql`
      insert into app.shares (resource_type, resource_id, owner_user_id, grantee_user_id, level)
      values ('rls_probe_item', ${seededProbeItemId}::uuid, ${ids.userA}::uuid, ${ids.userB}::uuid, 'view')
    `.execute(scopedDb.db);
  });

  const visibleToB = await runner.withDataContext(contextFor(ids.userB), (scopedDb) =>
    scopedDb.db
      .selectFrom("app.rls_probe_items")
      .selectAll()
      .where("id", "=", seededProbeItemId)
      .executeTakeFirst()
  );

  expect(visibleToB?.id).toBe(seededProbeItemId);
});
```

> Adapt `runner`/`contextFor`/`seededProbeItemId` to the file's actual helper + variable names
> (the file already constructs a `DataContextRunner` and seeds probe rows owned by `ids.userA` —
> reuse those). The point: a probe row visible to its owner is shared `'view'` to userB, and userB
> must be able to `SELECT` it.

- [ ] **Step 2: Run it to verify it fails**

Run: `export PATH="$HOME/.local/bin:$PATH" && pnpm db:up && pnpm test:integration -- tests/integration/foundation.test.ts -t "view share"`
Expected: FAIL — userB cannot see the row, because the current `rls_probe_items_select` policy only
honors owner / `has_resource_grant` / workspace membership, **not** `app.shares`.

- [ ] **Step 3: Write the migration that converts the probe policy**

Create `infra/postgres/migrations/0018_probe_owner_or_share.sql`:

```sql
-- Slice 1b: convert the core RLS probe from workspace-visibility + resource_grants
-- to the owner-or-share model (app.has_share). The visibility and workspace_id
-- columns remain on app.rls_probe_items but are no longer consulted for access;
-- they are dropped in Slice 1f.

DROP POLICY IF EXISTS rls_probe_items_select ON app.rls_probe_items;

CREATE POLICY rls_probe_items_select
ON app.rls_probe_items
FOR SELECT
TO jarvis_app_runtime, jarvis_worker_runtime
USING (
  app.current_actor_user_id() IS NOT NULL
  AND (
    owner_user_id = app.current_actor_user_id()
    OR app.has_share('rls_probe_item', id, 'view')
  )
);
```

> The probe defines only a SELECT policy (see `0002_app_rls.sql`), so only the SELECT policy is
> converted. `app.has_share` is already granted to both runtime roles in `0017_shares.sql`, so the
> worker path works too.

- [ ] **Step 4: Update the migration-list assertion**

In `tests/integration/foundation.test.ts`, find the `it("applies versioned SQL migrations from an
empty database", …)` assertion (the array of `{ version, name }` ending at `0017`). Append:

```ts
{ version: "0018", name: "0018_probe_owner_or_share.sql" },
```

- [ ] **Step 5: Rewrite the obsolete probe access tests to shares**

Replace these now-obsolete cases (delete the workspace/grant bodies, replace with shares-based
equivalents, keep coverage of the same invariants):

- `it("allows access through an explicit resource grant", …)` → rewrite to grant `'view'` via
  `app.shares` and assert visibility (covered by Step 1's new test; either fold into it or convert
  this one to the shares form and delete the duplicate).
- `it("allows workspace membership only for workspace-shared rows in the active workspace context", …)`
  → **delete**. Workspace-visibility access no longer exists; the shares `'view'` test replaces it.
- `it("allows workspace-scoped pg-boss jobs only for workspace-shared rows", …)` → **delete** (the
  worker no longer gains access via workspace membership).
- `it("processes a metadata-only job through stored actor context without bypassing RLS", …)` (and
  its `grantedItemVisible` assertion) → convert the seeded `resource_grants` row to an `app.shares`
  row at `'view'` so `grantedItemVisible` still holds via the new model. Leave the
  `workspacePrivateItemVisible` expectation only if you keep a private (unshared) row that must stay
  invisible — drop the workspace framing.

> Keep the no-bypass invariants intact: the "does not let an instance admin read another user's
> private row by role alone" case must still pass unchanged (admins get no data access).

- [ ] **Step 6: Run the probe tests to verify they pass**

Run: `export PATH="$HOME/.local/bin:$PATH" && pnpm test:integration -- tests/integration/foundation.test.ts`
Expected: PASS (all foundation cases, including the migration-list assertion with `0018`).

- [ ] **Step 7: Commit**

```bash
git add infra/postgres/migrations/0018_probe_owner_or_share.sql tests/integration/foundation.test.ts
git commit -m "feat(db): convert RLS probe to owner-or-share via app.has_share

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Convert the Tasks module to owner-or-share

**Files:**

- Create: `packages/tasks/sql/0019_tasks_owner_or_share.sql`
- Test: `tests/integration/tasks.test.ts` (modify)
- Test: `tests/integration/foundation.test.ts` (migration-list assertion, +0019)

- [ ] **Step 1: Add a SharesRepository + user-B context helper to the tasks test**

In `tests/integration/tasks.test.ts`:

- Add `SharesRepository` to the existing `@jarv1s/db` import.
- Construct it once near the other repos: `const sharesRepository = new SharesRepository();`
- The file already has `userAContext(workspaceId?)` (returns `{ actorUserId: ids.userA, workspaceId, requestId }`).
  Add the user-B twin (workspace arg no longer needed for access, but keep the shape consistent):

```ts
function userBContext(): AccessContext {
  return { actorUserId: ids.userB, requestId: "request:tasks-test" };
}
```

- [ ] **Step 2: Write the failing shares-based tasks tests**

Add these three cases inside `describe("Tasks module M1", …)`:

```ts
it("allows task read through a view share", async () => {
  const task = await runner.withDataContext(userAContext(), (scopedDb) =>
    repository.create(scopedDb, { title: "Shared with B" })
  );
  await runner.withDataContext(userAContext(), (scopedDb) =>
    sharesRepository.grant(scopedDb, {
      resourceType: "task",
      resourceId: task.id,
      ownerUserId: ids.userA,
      granteeUserId: ids.userB,
      level: "view"
    })
  );

  const visibleToB = await runner.withDataContext(userBContext(), (scopedDb) =>
    repository.getById(scopedDb, task.id)
  );

  expect(visibleToB?.id).toBe(task.id);
});

it("does not let a view-share grantee update the task", async () => {
  const task = await runner.withDataContext(userAContext(), (scopedDb) =>
    repository.create(scopedDb, { title: "View-only for B" })
  );
  await runner.withDataContext(userAContext(), (scopedDb) =>
    sharesRepository.grant(scopedDb, {
      resourceType: "task",
      resourceId: task.id,
      ownerUserId: ids.userA,
      granteeUserId: ids.userB,
      level: "view"
    })
  );

  const updated = await runner.withDataContext(userBContext(), (scopedDb) =>
    repository.update(scopedDb, task.id, { title: "hijacked" })
  );

  // RLS hides the row from the UPDATE for a view-only grantee.
  expect(updated).toBeUndefined();
});

it("lets a manage-share grantee update the task", async () => {
  const task = await runner.withDataContext(userAContext(), (scopedDb) =>
    repository.create(scopedDb, { title: "Managed by B" })
  );
  await runner.withDataContext(userAContext(), (scopedDb) =>
    sharesRepository.grant(scopedDb, {
      resourceType: "task",
      resourceId: task.id,
      ownerUserId: ids.userA,
      granteeUserId: ids.userB,
      level: "manage"
    })
  );

  const updated = await runner.withDataContext(userBContext(), (scopedDb) =>
    repository.update(scopedDb, task.id, { title: "Managed title" })
  );

  expect(updated?.title).toBe("Managed title");
});
```

> Adapt `runner` to the file's `DataContextRunner` variable name and `repository` to its
> `TasksRepository` instance. `repository.create` already sets `owner_user_id` via
> `app.current_actor_user_id()`, so no owner field is passed.

- [ ] **Step 3: Run to verify they fail**

Run: `export PATH="$HOME/.local/bin:$PATH" && pnpm db:up && pnpm test:integration -- tests/integration/tasks.test.ts -t "share"`
Expected: FAIL — the current `tasks_select`/`tasks_update` policies don't consult `app.shares`
(view grantee can't read; manage grantee can't update).

- [ ] **Step 4: Write the tasks conversion migration**

Create `packages/tasks/sql/0019_tasks_owner_or_share.sql`:

```sql
-- Slice 1b: convert Tasks access from workspace-visibility + resource_grants to
-- the owner-or-share model (app.has_share). The visibility/workspace_id columns
-- and the app.has_resource_grant_level helper remain but are no longer consulted
-- for task access; they are removed in Slice 1f. task_activity policies are left
-- unchanged: they gate on parent-task visibility via an RLS-filtered EXISTS, so
-- they inherit the new model automatically.

DROP POLICY IF EXISTS tasks_select ON app.tasks;
DROP POLICY IF EXISTS tasks_insert ON app.tasks;
DROP POLICY IF EXISTS tasks_update ON app.tasks;

CREATE POLICY tasks_select
ON app.tasks
FOR SELECT
TO jarvis_app_runtime, jarvis_worker_runtime
USING (
  app.current_actor_user_id() IS NOT NULL
  AND (
    owner_user_id = app.current_actor_user_id()
    OR app.has_share('task', id, 'view')
  )
);

CREATE POLICY tasks_insert
ON app.tasks
FOR INSERT
TO jarvis_app_runtime, jarvis_worker_runtime
WITH CHECK (
  app.current_actor_user_id() IS NOT NULL
  AND owner_user_id = app.current_actor_user_id()
);

CREATE POLICY tasks_update
ON app.tasks
FOR UPDATE
TO jarvis_app_runtime, jarvis_worker_runtime
USING (
  app.current_actor_user_id() IS NOT NULL
  AND (
    owner_user_id = app.current_actor_user_id()
    OR app.has_share('task', id, 'manage')
  )
)
WITH CHECK (
  app.current_actor_user_id() IS NOT NULL
  AND (
    owner_user_id = app.current_actor_user_id()
    OR app.has_share('task', id, 'manage')
  )
);
```

> Insert is now owner-only (you cannot create a task owned by someone else). A `'manage'` grantee can
> update content but cannot change the owner — the existing `tasks_prevent_owner_change` trigger from
> `0003_tasks_module.sql` still enforces owner immutability and is unaffected.

- [ ] **Step 5: Update the migration-list assertion (+0019)**

In `tests/integration/foundation.test.ts`, append to the same migration-list array from Task 1 Step 4:

```ts
{ version: "0019", name: "0019_tasks_owner_or_share.sql" },
```

- [ ] **Step 6: Rewrite the obsolete tasks tests + seeds**

In `tests/integration/tasks.test.ts`:

- `it("allows task access through an explicit resource grant", …)` → **delete** (replaced by Task 2
  Step 2's view-share test).
- `it("allows workspace-visible task access only in active member workspace context", …)` →
  **delete** (workspace-visibility access no longer grants cross-user reads).
- `it("keeps task activity governed by parent task visibility and active actor context", …)` →
  **rewrite** to: userA creates a task + an activity row, shares the task `'view'` to userB, and
  assert userB can read the activity (proves `task_activity_select` inherits the new model); then a
  third user with no share cannot. Do **not** add a new activity policy.
- Any seed block inserting into `app.resource_grants` (e.g. the raw
  `INSERT INTO app.resource_grants (...)` around the worker/no-bypass cases) → convert the granted
  row to `INSERT INTO app.shares (resource_type, resource_id, owner_user_id, grantee_user_id, level)
VALUES ('task', <id>, <owner>, <grantee>, 'view')`. Drop `'workspace'`-visibility seed rows that
  existed only to test cross-user workspace access.
- **Keep unchanged** (scope = RLS only): the route tests that exercise `visibility: "workspace"` on
  create/update (e.g. `it("requires active workspace context when updating a task to workspace
visibility", …)`). The routes still accept/echo `visibility`/`workspaceId` (inert until 1f), so
  these pass as-is. The "does not let an instance admin read another user's private task by role
  alone" and "does not let a User A worker job update User B's private task" no-bypass cases must
  still pass unchanged.

- [ ] **Step 7: Run the tasks + foundation suites to verify they pass**

Run: `export PATH="$HOME/.local/bin:$PATH" && pnpm test:integration -- tests/integration/tasks.test.ts tests/integration/foundation.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/tasks/sql/0019_tasks_owner_or_share.sql tests/integration/tasks.test.ts tests/integration/foundation.test.ts
git commit -m "feat(tasks): convert Tasks RLS to owner-or-share via app.has_share

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Full-gate verification on a fresh database

**Files:** none (verification only).

- [ ] **Step 1: Reset the database so all migrations apply from scratch**

Run: `export PATH="$HOME/.local/bin:$PATH" && pnpm db:reset`
Expected: `Container jarv1s-postgres  Healthy`.

- [ ] **Step 2: Run the full foundation gate**

Run: `export PATH="$HOME/.local/bin:$PATH" && pnpm verify:foundation`
Expected: lint ✓, format:check ✓, check:file-size ✓, typecheck ✓, db:migrate applies `0018` and
`0019` in order ✓, **all integration tests pass** (13 files; count rises with the new cases). If
format fails on touched files, run `pnpm format` and re-run.

- [ ] **Step 3: Confirm no stale references remain**

Run: `grep -rn "has_resource_grant\b" packages/tasks infra/postgres/migrations | grep -i "policy\|tasks_\|rls_probe"`
Expected: the only remaining hits are the **definitions** of `has_resource_grant*` (kept for 1f) —
**no** `tasks_*` or `rls_probe_items_*` policy should still call them. (The function bodies and
`app.resource_grants` table intentionally remain until Slice 1f.)

---

## What This Slice Deliberately Leaves For Later

- `app.resource_grants`, `app.has_resource_grant`, `app.has_resource_grant_level`,
  `app.is_workspace_member`, `app.current_workspace_id`, the `workspaces`/`workspace_memberships`
  tables — **dropped in Slice 1f.**
- `tasks.visibility` / `tasks.workspace_id` / `rls_probe_items.visibility` /
  `rls_probe_items.workspace_id` columns, the `app.task_visibility` enum, and the Tasks route/DTO/
  shared-API workspace fields — **removed in Slice 1f**, when `AccessContext` becomes
  `{ actorUserId, requestId }`.
- Notifications, Connectors, Calendar, Email — **Slice 1c.** AI / Chat / Briefings — **Slice 1d.**
  Notes module removal — **Slice 1e.**

---

## Self-Review

**1. Spec coverage.** Spec §"Changes to the Existing Scaffold" → "Migrate Tasks' `workspace`
visibility to the shares model": Tasks policies now read owner-or-`has_share` (Task 2). Spec
§"Testing Strategy" → "Structured-state RLS: private by default; share grants make a resource
visible at the granted level; revocation removes access" and "`has_share` behaves uniformly for
tasks/…": covered by the view/manage share tests (Task 2) and the probe share test (Task 1); the
revoke path is already proven generically in `shares.test.ts`. "No admin bypass": the admin-by-role
denial cases are explicitly retained unchanged (Tasks 1 & 2 Step 6/5). Handoff invariant
"`workspace_id` stays in the context until 1f": honored — `AccessContext` untouched.

**2. Placeholder scan.** SQL is complete and literal. Test snippets are concrete but reference the
existing test files' helpers (`runner`/`DataContextRunner`, `repository`/`TasksRepository`, `ids`,
the probe seed) by their real names — the executor adapts variable names after reading the files
(the "Read First" section makes this explicit). No "TODO"/"handle edge cases" placeholders.

**3. Type/identifier consistency.** Resource-type strings match existing usage: `'rls_probe_item'`
(per `0002_app_rls.sql`) and `'task'` (per `0003_tasks_module.sql`). Share levels `'view'`/`'manage'`
match the `app.shares` CHECK and `ShareLevel`. `SharesRepository.grant({ resourceType, resourceId,
ownerUserId, granteeUserId, level })` matches `packages/db/src/sharing/shares-repository.ts`.
`app.has_share(text, uuid, text)` signature matches `0017_shares.sql`. Migration filenames `0018`/
`0019` match the assertion-array entries.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-06-slice-1b-tasks-owner-or-share.md`.
Per the project workflow, execute with **superpowers:subagent-driven-development** — fresh Sonnet
implementer per task, controller reviews (spec compliance + code quality) between tasks, commit per
task — and run a thermo-nuclear pass on the diff before merging the slice.
