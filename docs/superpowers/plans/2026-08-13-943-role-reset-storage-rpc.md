# Plan — #943 module-storage-rpc role-scope hazard

**Spec:** issue #943 body is the spec (no separate spec doc on disk — per handoff). **Risk tier:**
security. **Branch:** `943-role-reset-storage-rpc` off `origin/main` @ `fa929d489` (one commit
behind current `origin/main` @ `513672aa5`; unrelated docs commit, rebase before push).

## Seams check (file:line, verified on this branch)

- Bug site: `packages/db/src/module-storage-rpc.ts:89` — `await sql.raw(\`SET LOCAL ROLE
${role}\`).execute(scopedDb.db)` runs unconditionally at the top of every `query()` call, inside
  the caller's `withDataContext` transaction (`packages/db/src/data-context.ts:63-71`,
  `rootDb.transaction().execute(...)`). Nothing in the function ever runs `RESET ROLE`. The
  existing `finally` block (`:99-108`) resets `statement_timeout` but not the role — confirmed by
  reading the full 124-line file; no other reset path exists.
- Why it's a hazard, not (yet) an exploit: `SET LOCAL ROLE` persists for the remainder of the
  **transaction**, not just the statement. Nothing in this codebase currently calls
  `createModuleStorageRpc(...).query()` and then continues doing other work in the same
  `withDataContext` transaction afterward (confirmed: only caller pattern in
  `tests/integration/module-storage-rpc.test.ts` is one `rpc.query()` call per
  `withDataContext` block) — hence "unwired, no runtime blast radius today" per the handoff. The
  footgun: the first caller who chains a second repository call after a module RPC call in the same
  transaction inherits the module's restricted role instead of the caller's real one, silently.
- Role identity: `moduleRuntimeRoleName` (`packages/db/src/module-role-broker.ts:31-33`) returns
  `jarvis_mod_<slug>_runtime`, a `NOLOGIN ... NOINHERIT` role granted `WITH INHERIT FALSE` to
  `jarvis_app_runtime`/`jarvis_worker_runtime` (`:74-77`) — i.e. a caller must explicitly `SET
  [LOCAL] ROLE` to assume it; it is a privilege *restriction* relative to the parent runtime roles,
  not an escalation. `RESET ROLE` (no target role) is the standard Postgres idiom to drop back to
  the session/transaction's prior role and is what the fix uses.
- Failure-path precedent already in the file: the existing `statement_timeout` reset
  (`:100-107`) wraps its `RESET`-equivalent (`SET LOCAL statement_timeout TO DEFAULT`) in a
  `try {} catch {}` with the comment "A timed-out statement aborts the transaction; the SET LOCAL
  dies with the rollback anyway." The same reasoning applies to `RESET ROLE`: if the query error
  already aborted the transaction (Postgres `25P02`), any further command including `RESET ROLE`
  fails and is safe to swallow, since the whole transaction — role included — dies with the
  rollback. Fix reuses this exact pattern, not a new one.
- Test harness precedent: `tests/integration/module-storage-rpc.test.ts` already exists (moduleId
  `storage-rpc-fixture`, role `jarvis_mod_storage_rpc_fixture_runtime`) with full
  `ensureModuleRoles` + RLS fixture setup/teardown in `beforeAll`/`afterAll`
  (`:28-88`), connecting as `jarvis_app_runtime` via `connectionStrings.app`
  (`createDatabase({ connectionString: connectionStrings.app, ... })`, `:51`) — the exact role the
  runtime role is granted to, so `SET LOCAL ROLE` inside a test transaction will succeed without
  new fixture work. `DataContextRunner.withDataContext` (`packages/db/src/data-context.ts:54-72`)
  wraps `scopedDb.db` as a `Transaction<MossDatabase>`, so a raw `sql\`select current_user\`.execute(scopedDb.db)`
  call is a valid Kysely `Transaction` receiver — same pattern the file's other tests use through
  `rpc.query(...)`.

## Task 1 — fix: reset the role in `finally`

`packages/db/src/module-storage-rpc.ts`, inside `query()`'s existing `finally` block (`:99-108`).
Add an unconditional `RESET ROLE`, guarded the same way as the existing timeout reset, run before
or after the timeout reset (order doesn't matter — independent GUCs) but keep it as its own
try/catch so a role-reset failure can't suppress the timeout reset or vice versa:

```ts
finally {
  try {
    await sql.raw("RESET ROLE").execute(scopedDb.db);
  } catch {
    // Same reasoning as the statement_timeout reset below: an aborted transaction
    // takes the role with it on rollback.
  }
  if (timeoutMs !== null) {
    try {
      await sql.raw("SET LOCAL statement_timeout TO DEFAULT").execute(scopedDb.db);
    } catch {
      // ...
    }
  }
}
```

No signature change, no new exports, no caller-visible change other than the role no longer
leaking past `query()`'s return.

## Task 2 — regression test: role binds in-txn and resets after

`tests/integration/module-storage-rpc.test.ts`, new `it()` in the existing `describe("createModuleStorageRpc")`
block (reuses the file's existing `beforeAll` fixture — no new setup/teardown needed). Add
`import { sql } from "kysely"` and `import { moduleRuntimeRoleName } from "@moss/db"` (both already
resolvable: `kysely` is a root dependency per `package.json:90`; `moduleRuntimeRoleName` is
re-exported from `@moss/db`'s `index.ts:8`).

```ts
it("binds the runtime role during the call and resets it after", async () => {
  const owner = randomUUID();
  await dataContext.withDataContext({ actorUserId: owner }, async (scopedDb) => {
    const rpc = createModuleStorageRpc(scopedDb, moduleId);
    const bound = await rpc.query<{ current_user: string }>("SELECT current_user");
    expect(bound.rows[0]?.current_user).toBe(moduleRuntimeRoleName(moduleId));

    const after = await sql<{ current_user: string }>`select current_user`.execute(scopedDb.db);
    expect(after.rows[0]?.current_user).toBe("jarvis_app_runtime");
  });
});
```

This proves both exit-criteria halves in one test: `bound` proves the role actually binds inside
the transaction (fails today only if binding were broken — it isn't); `after`, run against the raw
transaction handle bypassing the RPC wrapper, proves the reset — **this assertion fails on current
`main`** (role stays `jarvis_mod_storage_rpc_fixture_runtime`) and passes once Task 1 lands. Write
Task 2 first, watch it fail against the unfixed file, then land Task 1 and watch it pass (TDD per
`coordinated-build`).

Verification (confirmed command — root `package.json:56`, `"test:integration": "tsx
scripts/test-integration.ts"`, which provisions the isolated DB `test-database.ts`'s
`assertIsolatedTestDatabase` guard requires; run under `verify-gate` for DB isolation per
CLAUDE.md):
```bash
pnpm test:integration tests/integration/module-storage-rpc.test.ts > /tmp/943-test.log 2>&1; echo "EXIT=$?"
```
Expect `EXIT=0`.

## Kill gate

This is a two-task, single-file-plus-one-test fix with no design fork. If Task 2's `after` assertion
still fails once Task 1 is applied exactly as written above, stop and escalate to the coordinator
before touching anything beyond `module-storage-rpc.ts` — that would mean the role is leaking via a
path this plan didn't account for (e.g. `SET LOCAL ROLE` running more than once per transaction in
some caller shape), which is a bigger question than this issue's scope. Owner of that call:
coordinator.

## Exit criteria (from handoff, unchanged)

- Test proving role binds in-txn and resets after — Task 2.
- Full gate green on an isolated gate DB (`verify-gate` skill).
- PR open, rebased on `origin/main`, tagged `[SECURITY]`.
- Backend-only, no UI surface — PR notes live-path proof doesn't apply.
