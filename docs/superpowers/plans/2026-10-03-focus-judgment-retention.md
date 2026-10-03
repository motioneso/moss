# Focus judgment 30-day retention (#2637)

Spec: `docs/superpowers/specs/2026-09-20-trail-marker-focus-judgment.md` section 8 (30-day retention).

## Seams (verified on branch, origin/main 05769bf43)

- `infra/postgres/migrations/0240_focus_judgments.sql:30-34` - one owner-only policy for
  `jarvis_app_runtime`; grants SELECT/INSERT/UPDATE only; no worker grant; no purge.
- `packages/ai/sql/0127_jarvis_action_audit_log.sql` + `packages/ai/sql/0245_...purge_worker_grant.sql`
  - precedent: SECURITY DEFINER no-argument purge function, owned by `jarvis_migration_owner`,
    reached through `FOR SELECT/DELETE TO jarvis_migration_owner` policies; EXECUTE granted to
    the worker only. No BYPASSRLS anywhere.
- `packages/ai/src/jobs.ts:19-35` - nightly pg-boss schedule pattern.
- `packages/jobs/src/pg-boss.ts:40` `FOUNDATION_QUEUES` + `apps/worker/src/worker.ts:347` - where
  platform (non-module) jobs are declared and worked. Focus is a platform table, not a module.
- `scripts/delete-user-data.ts:58` counted-table list (deletion is FK cascade + count report).
- `packages/settings/src/data-export-queries.ts`, `packages/settings/src/data-export.ts:138,293`.

## Decisions

1. **Migration** `infra/postgres/migrations/02NN_focus_judgments_retention.sql` (number taken
   at PR time; 0256/0257 are claimed by #2956):
   - `CREATE POLICY focus_judgments_retention_select` and `..._retention_delete` on
     `app.focus_judgments` `TO jarvis_migration_owner` with
     `USING (created_at < now() - interval '30 days')`. The policy itself carries the age rule,
     so even the definer can never see or delete a recent row (tighter than the audit log's
     `USING (true)`).
   - `app.purge_expired_focus_judgments() RETURNS integer`, SECURITY DEFINER, pinned
     `search_path`, no argument, same 30-day cutoff in its WHERE.
   - `REVOKE ALL ... FROM PUBLIC; GRANT EXECUTE ... TO jarvis_worker_runtime`.
   - Worker keeps zero table privileges (existing "worker has no access" test stays as-is).
   - No owner DELETE grant: no feature deletes single judgments; user deletion is FK cascade.
2. **Job**: queue `system.focus-judgment-purge` in `FOUNDATION_QUEUES` (retryLimit 3);
   `packages/focus-judgment/src/jobs.ts` exports `registerFocusJudgmentPurgeWorker(boss, workerDb)`
   scheduling `"15 3 * * *"` UTC with payload `{}` and working it via
   `FocusJudgmentRepository.purgeExpired(workerDb)`; wired in `apps/worker/src/worker.ts`.
   Payload is empty - no ids, no content.
3. **Deletion**: add `["app.focus_judgments", "owner_user_id = $1::uuid"]` to the counted list.
4. **Export**: `focusJudgmentsQuery(userId)` (all columns, camelCase, ordered by created_at,id)
   - `focusJudgments` key in `UserDataExport`.

## Tests (tests/integration/focus-judgments.test.ts, through verify-gate, scoped)

- Purge as the worker role deletes a 31-day-old row for user A and user B, keeps a 1-day-old row
  for both; returns the count. Observed red with the function body's DELETE removed, then green.
- Worker still cannot SELECT/DELETE the table directly; worker cannot call any other purge with
  a cutoff (none exists).
- `exportUserData` for user A includes A's judgment, not B's.
- `deleteUserData(A)` reports a focus_judgments count and leaves zero A rows, B's intact.
- Unit: `registerFocusJudgmentPurgeWorker` schedules with an empty payload.

## Live proof

Not user-facing. Run the purge against the isolated gate database (verify-gate), recording
old-row deleted / recent-row kept counts in the PR. Release note: Category N/A.
