# Classifier shadow records: keep forever, delete on request (lane plan)

Issue: [#2908](https://github.com/ben/jarv1s/issues/2908) (epic #2864). Tier: **security**.
Branch `cg-shadow-retention`, worktree `~/Jarv1s/.claude/worktrees/cg-shadow-retention`.
Governing plan section: `docs/superpowers/plans/2026-10-01-classifier-gate-for-chat.md` → 3.4,
"Contracts and invariants to build", and "Rulings". Spec:
`docs/superpowers/specs/2026-10-01-classifier-gate-for-chat.md`.

Builds on PR 2871 (`packages/chat/sql/0251_chat_classifier_shadow_records.sql`,
`packages/chat/src/classifier-shadow-repository.ts`, `packages/chat/src/jobs.ts`). Does not touch
live chat wiring (#2907) or the release-eligibility table.

## Ben's ruling, 2026-10-02

1. Shadow records are kept forever. Stop the fixed 7-day purge (job and function).
2. Moss deletes them on request: the owner deletes their own, owner-only, no admin bypass. They
   also go with account deletion (already covered by `ON DELETE CASCADE`).
3. Private (incognito) chats never take part; no classifier call and no record.

This is recorded as ruling **16** in the classifier plan; ruling 10 (7-day purge) is marked
superseded and the "Shadow retention/private chat" open item is closed. The spec's 7-day wording
(lines 6, 141) is reconciled to "kept until the owner deletes them".

## Migration number (reported to the coordinator before building)

Next free number on `origin/main` is **0255** (main ends at
`0254_moss_model_activity_log.sql`, `packages/ai/sql/`). Checked before building:

- open PRs 2904, 2903, 2860, 2879: no new `sql/NNNN_*.sql` files;
- every live worktree's tracked SQL: no 0255;
- migration lives in the owning module folder: `packages/chat/sql/0255_*.sql`.

## Seams check (current tree, file:line)

| Capability the plan assumes                                                            | Evidence                                                                                                                                                               |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner-only FORCE-RLS shadow table, app role has SELECT/INSERT/UPDATE but **no** DELETE | `packages/chat/sql/0251_chat_classifier_shadow_records.sql:56-105`                                                                                                     |
| Fixed 7-day purge function granted to the worker                                       | `packages/chat/sql/0251_chat_classifier_shadow_records.sql:107-127`                                                                                                    |
| Daily purge job + queue definition                                                     | `packages/chat/src/jobs.ts:68-78`, `:526-549`                                                                                                                          |
| Repository owner reads; purge entrypoint                                               | `packages/chat/src/classifier-shadow-repository.ts:239-268` (exported at `packages/chat/src/index.ts:12`)                                                              |
| Account deletion already removes the rows                                              | `packages/chat/sql/0251_chat_classifier_shadow_records.sql:11` (`REFERENCES app.users(id) ON DELETE CASCADE`)                                                          |
| Data-context scoped route pattern                                                      | `packages/chat/src/routes.ts:526-628`; route must be claimed in the manifest (`tests/unit/chat-route-coverage.test.ts`, `packages/module-registry/src/route-guard.ts`) |
| Manifest migration list + owned tables + feature declarations                          | `packages/chat/src/manifest.ts:38-64`, `:182-196`                                                                                                                      |
| Global migration ledger pinned by test                                                 | `tests/integration/foundation-schema-catalog.test.ts:513-532`                                                                                                          |
| Queue list pinned by test                                                              | `tests/integration/ai-tools.test.ts:476-479`                                                                                                                           |
| Integration-test DB isolation                                                          | `scripts/test-integration.ts` + `scripts/run-gate.sh` (verify-gate skill)                                                                                              |

## Decision: how deletion is exposed

There is **no existing selective "delete my data" path**. The only user data deletion path is full
account deletion (`scripts/delete-user-data.ts`, `packages/settings/src/me-account-routes.ts`), and
the shadow table already cascades from `app.users`. A module `dataLifecycle` declaration
(`packages/module-sdk/src/index.ts:800-805`) is cascade-only, so it cannot express "delete just my
shadow records".

Decision: add a **small chat route**, `DELETE /api/chat/classifier/shadow-records`, plus a chat
manifest route entry and an app-map feature-description update. No UI control is built in this
lane (a screen for private shadow text needs its own mockup and spec); the route is the capability,
exercised by the database tests below. Because no user-facing control is added, there is no live-UI
claim: the PR reports that honestly.

## Tasks

### T1 — Migration `packages/chat/sql/0255_chat_classifier_shadow_retention.sql`

DDL (never edit 0251):

```sql
-- keep shadow records forever; owner-only delete on request. Supersedes 0251's 7-day purge.
DROP POLICY IF EXISTS chat_classifier_shadow_records_maintenance_select
  ON app.chat_classifier_shadow_records;
DROP POLICY IF EXISTS chat_classifier_shadow_records_maintenance_delete
  ON app.chat_classifier_shadow_records;
DROP FUNCTION IF EXISTS app.purge_expired_chat_classifier_shadow_records();

GRANT DELETE ON app.chat_classifier_shadow_records TO jarvis_app_runtime;

DROP POLICY IF EXISTS chat_classifier_shadow_records_delete
  ON app.chat_classifier_shadow_records;
CREATE POLICY chat_classifier_shadow_records_delete
ON app.chat_classifier_shadow_records
FOR DELETE TO jarvis_app_runtime
USING (
  app.current_actor_user_id() IS NOT NULL
  AND owner_user_id = app.current_actor_user_id()
);
```

No admin, thread-sharing or recipient branch. Register `sql/0255_...sql` in
`packages/chat/src/manifest.ts:38-55`.

### T2 — Repository: delete, stop purge

`packages/chat/src/classifier-shadow-repository.ts`:

- add `async deleteForOwner(scopedDb: DataContextDb): Promise<number>` — `assertDataContextDb`,
  then `scopedDb.db.deleteFrom("app.chat_classifier_shadow_records").executeTakeFirst()`, return
  `Number(result.numDeletedRows ?? 0)`. RLS supplies the owner filter; no owner id is passed, so a
  caller cannot widen it.
- remove `purgeExpired` (`:259-268`).

### T3 — Stop the job

`packages/chat/src/jobs.ts`:

- remove `CHAT_PURGE_SHADOW_RECORDS_QUEUE` (`:68`) and its `CHAT_QUEUE_DEFINITIONS` entry (`:74-77`);
- remove `registerShadowRecordPurge` (`:533-549`) and the `rootDb` branch (`:526-530`);
- remove the now-unused `rootDb` option from `RegisterChatJobWorkersOptions` (`:442-446`) and the
  `rootDb: deps.rootDb,` line at `packages/module-registry/src/index.ts:2212`.
- Update pinned queue list in `tests/integration/ai-tools.test.ts:479` (drop
  `chat.purge-classifier-shadow-records`).

### T4 — Owner delete route + app map

`packages/chat/src/routes.ts`:

- optional dependency `readonly classifierShadowRepository?: ClassifierShadowRepository`; default
  `new ClassifierShadowRepository()`;
- `server.delete("/api/chat/classifier/shadow-records", …)` → resolve access context, run
  `deleteForOwner(scopedDb)` inside `dataContext.withDataContext`, reply `200 { deleted }`,
  errors via `handleRouteError`.

`packages/chat/src/manifest.ts`:

- routes: `{ method: "DELETE", path: "/api/chat/classifier/shadow-records", permissionId: "chat.message" }`;
- feature `chat.classifier_shadow_records` description: private records kept until the owner
  deletes them (drop "7-day"); nothing saves there yet, no screen, a failed save leaves the reply
  unchanged. ≤240 chars.

### T5 — Tests

`tests/integration/chat-classifier-shadow.test.ts`:

- update the header comment; change the first test to assert FORCE RLS still on, app role **can**
  now DELETE, and `app.purge_expired_chat_classifier_shadow_records` no longer exists;
- delete the 7-day purge test (`:255-308`);
- new: "the owner can delete their own records" — user A opens two records, `deleteForOwner`
  returns 2, A lists none, user B's record is untouched;
- new: "another user cannot delete an owner's records" — A has a record, B's `deleteForOwner`
  returns 0, A's row survives; a raw `DELETE FROM app.chat_classifier_shadow_records` as B removes
  0;
- new: "an admin cannot delete another owner's records" — same shape with `ids.adminUser`.

These fail against a broken policy: with the DELETE `USING` clause weakened to `true`, B/admin
delete A's rows and the counts assertions fail. Observation procedure in the next section.

`tests/unit/chat-classifier-shadow-delete-route.test.ts` (new): register the real chat routes on a
bare Fastify with a fake `dataContext`, spy `ClassifierShadowRepository.prototype.deleteForOwner`,
`server.inject({ method: "DELETE", url: "/api/chat/classifier/shadow-records" })`, assert the
handler ran under an actor and returns the count. Proves the route wires to the repository.

`tests/integration/foundation-schema-catalog.test.ts:533` — append the 0255 ledger row.

## Observed-failure evidence (required)

In the isolated gate database, not the live one:

1. Weaken only the DELETE policy in 0255 to `USING (true)` (scratch edit) and run
   `scripts/run-gate.sh start --gate test:chat-classifier-shadow` → `wait --follow`; expect the
   owner-isolation tests to **fail** (exit 1). Record the failing assertion.
2. Restore the policy and re-run → green. Record both results on the PR.

## Verification commands (never piped)

```
scripts/run-gate.sh start --gate test:chat-classifier-shadow   # expect start exit 0, prints log
scripts/run-gate.sh wait --follow                              # exit 0 green, 1 red, 2 dead
pnpm format:check && pnpm lint && pnpm typecheck               # each exit 0
git fetch origin main && git rebase origin/main                # exit 0
scripts/run-gate.sh start                                      # full verify:foundation at wrap-up
```

## Determinism boundary

No model output is involved. Records, counts and route replies derive only from the database and
validated inputs; the delete is a row operation scoped by RLS.

## Kill gate

If the full gate cannot be made green because the shared Postgres is contended
(`tuple concurrently updated`) across sibling lanes, stop and hand CI the gate; report it to the
coordinator rather than retrying in-window. Owner: build agent.

## Out of scope

Live chat wiring (#2907); a user-facing screen for shadow records; the admin model activity log
(3.6); any change to `0251`.
