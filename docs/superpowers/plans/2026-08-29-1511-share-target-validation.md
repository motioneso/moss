# Plan — #1511 Share-target validation

Spec: `docs/superpowers/specs/2026-08-10-1137-robustness-followups.md`, section "### A — Share-target
validation", locked decisions. Task issue: #1511 ("Part of #1137").

## Seams check (file:line citations)

- `assertUuid(value, label)` exists at `packages/db/src/data-context.ts:23`, throws
  `` `${label} must be a UUID` `` on a non-UUID string.
- `app.get_user_by_id(uuid)` SECURITY DEFINER helper: originally added at
  `infra/postgres/migrations/0047_users_rls_tighten.sql:34`, but redefined (replaces the function)
  at `infra/postgres/migrations/0050_multi_user_accounts.sql:59` to also return `status`. The live
  definition is 0050's — it filters on `id` only, no `status` predicate (confirmed by reading the
  function body), so a pending or deactivated user is still returned. Granted to
  `jarvis_app_runtime`, callable inside a scoped transaction.
- Existing call pattern for this helper, to follow exactly:
  `packages/connectors/src/repository.ts:92-103` (`getUserById` — `sql` tagged template,
  `SELECT ... FROM app.get_user_by_id(${userId}::uuid)`, returns `result.rows[0]`).
- Target method: `SharesRepository.grant` at
  `packages/db/src/sharing/shares-repository.ts:25-50` — currently inserts with no validation of
  `input.granteeUserId` beyond what the DB constraint/FK catches.
- No-self-share constraint already exists as a DB CHECK:
  `infra/postgres/migrations/0017_shares.sql:10` (`shares_no_self_grant`). Not touched by this
  change.
- Confirmed absent: no existing grantee-existence check in `grant` (verified by reading the method
  body above) — spec's premise still holds on this branch.

## Task 1 — validate grantee in `SharesRepository.grant`

File: `packages/db/src/sharing/shares-repository.ts`

- At the top of `grant`, after `assertDataContextDb(scopedDb)`, add:
  `assertUuid(input.granteeUserId, "share grantee user id")`.
- Then query `app.get_user_by_id` for `input.granteeUserId`, selecting only `id`, using the same
  `sql` tagged-template pattern as `ConnectorsRepository.getUserById`.
- If the query returns no row, `throw new Error("Share target user not found")` before the
  `insertInto` call.
- No migration, no new helper function, no catching Postgres `23503`, no widening of any RLS
  policy on `app.users`.
- No changes to `listForResource`, `revoke`, or `hasShare`.

## Task 2 — tests in `tests/integration/shares.test.ts`

Add to the existing `describe("SharesRepository", ...)` block (new resource ids, following the
existing `resourceX` naming convention to avoid the `UNIQUE(resource_type, resource_id,
grantee_user_id)` collision):

1. **Missing grantee fails with the fixed error, before any insert.** Call `repository.grant`
   with a syntactically valid UUID that was never seeded as a user (e.g.
   `"00000000-0000-4000-8000-0000000000ff"`). Assert it rejects with
   `"Share target user not found"`. Then assert `listForResource` for that resource is empty (proves
   no row was written).
2. **Malformed grantee id fails the UUID guard, before any insert.** Call `grant` with
   `granteeUserId: "not-a-uuid"`. Assert it rejects with a message containing
   `"must be a UUID"` (matches `assertUuid`'s existing wording — do not invent new UUID-guard text).
3. **A valid cross-user grant still passes.** Re-run (or reuse) the existing "grants a share the
   grantee can then access" case to confirm the new check doesn't reject a real target — this is
   already covered by the existing test at line ~185; no new test needed, just confirm it still
   passes.
4. **Re-grant (upsert) of an existing valid target still passes.** Already covered by "upgrades an
   existing share on re-grant" (existing test, ~line 208) — confirm it still passes, no new test
   needed.
5. **Owner RLS and no-self-share remain green.** Already covered by existing tests in the
   `describe("shares has_share + RLS (raw SQL)", ...)` block — confirm still green, no new test
   needed.

6. **A pending or deactivated grantee is still a valid share target.** Spec locks this: "an
   existing pending or deactivated user is still an existing target." Seed one extra user via the
   existing `seedUsers` helper's plain `INSERT INTO app.users` with an explicit
   `status = 'deactivated'` (or `'pending'`) value, then `grant` a share to that user and assert it
   succeeds (row returned, `listForResource` shows it). This locks the current no-status-filter
   behaviour of `app.get_user_by_id` (confirmed at
   `infra/postgres/migrations/0050_multi_user_accounts.sql:59-82`) so this change cannot silently
   narrow it later.

Tests 1, 2, and 6 are new; 3-5 are regression confirmation of tests that already exist.

## Determinism / live-path

No UI surface, no model involvement — determinism boundary section of `plan-build` doesn't apply.
Live-path gate: per brief and spec acceptance table row A, not applicable — no production caller of
`SharesRepository` outside this repo file and its tests (coordinator re-ran the caller inventory
2026-08-29). State this explicitly on the PR.

## Kill gate

None needed — single-file, single-method change with a locked spec decision; no fork to evaluate.
If the focused test file does not go green in two attempts, escalate to the coordinator rather than
improvising a different validation shape.

## Verification commands (run via `verify-gate` skill for anything DB-touching; never piped)

```bash
pnpm --filter @moss/db typecheck > /tmp/1511-typecheck.log 2>&1; echo "EXIT=$?"   # expect 0
pnpm check:file-size > /tmp/1511-filesize.log 2>&1; echo "EXIT=$?"                 # expect 0
```

Focused test file `tests/integration/shares.test.ts` — DB-touching, run only through the
`verify-gate` skill's guarded procedure. Expect exit 0, all cases in `describe("SharesRepository"` green
including the two new ones.
