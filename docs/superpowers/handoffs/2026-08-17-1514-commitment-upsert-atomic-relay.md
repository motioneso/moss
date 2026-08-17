# Relay — #1514 commitment upsert atomic

Spec: `docs/superpowers/specs/2026-08-10-1137-robustness-followups.md` §C1 (lines 143-157).
Issue: #1514 (`Part of #1137`). Branch/worktree: `1514-commitment-upsert-atomic` (this worktree).
Plan (coordinator-approved, proceed to build): `docs/superpowers/plans/2026-08-17-1514-commitment-upsert-atomic.md`.
Coordinator: named agent `coord-post1632-take27`, label `Coordinator` (re-resolve fresh via
`herdr pane list` — label + `agent_session.value` are authority, never a `w1:pXX` number from this doc).

## Done

- Plan written and approved by coordinator ("Proceed to build" — logged in transcript).
- Task 2 test drafted in `tests/integration/commitments.test.ts` (committed, commit `2d5fd75c4`):
  `"resolves two concurrent upserts of the same signature to one row with no 23505"` inside
  `describe("upsertCandidate", ...)`.
- Task 1 (`packages/commitments/src/repository.ts` rewrite) **NOT started** — no production code
  yet, per TDD Iron Law, because RED is not verified (see blocker below).

## Blocker — RESOLVED, coordinator ruling below (proceed, do not re-ask)

Ran the new concurrency test against the **unmodified** (buggy) `upsertCandidate` on a fresh
isolated gate DB (`jarvis_gate_1514`, already dropped — recreate per `verify-gate` skill before
your own run). Expected a `23505` unique-violation (old code doesn't catch conflicts) or
`sourceCount !== 2`. Actual: all 7 tests in the file passed cleanly (`rc=0`). The two
`Promise.all`-dispatched `dataContext.withDataContext(...)` calls did not achieve genuine
Postgres transaction-level overlap — `maxConnections: 2` rules out pool starvation as the cause;
root cause not fully isolated (see memory below).

Escalated to coordinator with two options (force-determinism raw-SQL orchestration vs. best-effort
`Promise.all` with a documented flakiness caveat). **Coordinator ruled: option 1 — force
determinism.** Rationale (coordinator's words): a naturally-flaky test that sometimes false-passes
on the OLD code would be flaky on CI too, and this project's testing discipline treats that as a
real defect, not acceptable noise — GREEN being 100% reliable doesn't offset a RED phase that can
silently false-pass. **Do not re-ask this — implement option 1 directly.**

Durable memory saved on this finding: `mem_msxjowwt_a55597fb5cc8` (search "Promise.all
withDataContext" via `memory_recall`/`memory_smart_search` if useful).

## Next steps (in order)

1. Rewrite the concurrency test in `tests/integration/commitments.test.ts` to force real
   interleaving via manually-sequenced raw transactions instead of `Promise.all` timing:
   `BEGIN A → SELECT A (sees nothing) → BEGIN B → SELECT B (sees nothing) → INSERT+COMMIT A →
   INSERT+COMMIT B (blocks on A's uncommitted row, then throws 23505 once A commits, against OLD
   code)`. Practical approach: acquire two raw connections/transactions directly from `appDb`
   (e.g. two `appDb.connection()` or `appDb.transaction().execute()` calls driven by hand with
   explicit `await` ordering — NOT `Promise.all` — so JS-level sequencing IS the synchronization
   mechanism: start txn A, run its SELECT, start txn B, run its SELECT, only then let A proceed to
   INSERT+COMMIT, then let B proceed to INSERT+COMMIT/ON CONFLICT). The two transactions must stay
   open across `await` boundaries (don't use `withDataContext`/`repo.upsertCandidate` directly for
   this — construct the raw SQL each phase needs, mirroring exactly what the repository does
   before/after the fix, using the same `app.commitment_candidates` table and
   `app.current_actor_user_id()` / RLS context via `SET LOCAL app.actor_user_id`). Assert: for
   OLD code this must reliably throw `23505` on B's insert (verify RED for the right reason); for
   NEW code (Task 1's `ON CONFLICT DO UPDATE`), B's statement must never throw and must instead
   atomically increment `source_count`, final state: one row, `source_count === 2`, same `id` for
   both.
   Keep this exact test in the final suite as a deterministic regression test (coordinator's
   instruction — not a throwaway RED-only harness).
2. Verify RED against current (unmodified) `repository.ts` — confirm the test now fails reliably
   (re-run 2-3x on a fresh gate DB to confirm no flakiness) and fails for the right reason (23505
   from B, not a typo/setup error).
3. Once RED is confirmed deterministic, implement Task 1 exactly
   per the plan's Behavior contract section: replace `upsertCandidate` in
   `packages/commitments/src/repository.ts:16-63` with a single `insertInto(...).onConflict((oc) =>
   oc.columns(["owner_user_id","candidate_signature"]).doUpdateSet({ source_count: sql<number>`app.commitment_candidates.source_count + 1`,
   last_seen_at: now, updated_at: now })).returningAll().executeTakeFirstOrThrow()`. Add
   `import { sql } from "kysely";`. No other columns in `doUpdateSet`.
3. Verify GREEN on a fresh isolated gate DB (`verify-gate` skill — DROP+CREATE, `export
   JARVIS_PGDATABASE=...`, never inline/piped).
4. Run plan's verification commands: `pnpm --filter @moss/commitments typecheck` (expect `EXIT=0`),
   `pnpm check:file-size` (expect `EXIT=0`).
5. Commit Task 1 by explicit path (`packages/commitments/src/repository.ts`,
   `tests/integration/commitments.test.ts` if further edited).
6. Pre-push trio + rebase, then `coordinated-wrap-up`: full gate on isolated gate DB, push, open PR.
   State explicitly in the PR/wrap-up that live-path proof is NOT required for this lane (internal
   repository fix, no UI surface — per the handoff doc). Report PR + evidence to coordinator, then
   stop — coordinator owns merge/board/close.

## Constraints carried over (unchanged)

- File scope: `packages/commitments/src/repository.ts` and `tests/integration/commitments.test.ts`
  only. Do not touch C2/C3/C4 surface (explicitly out of scope per issue #1514).
- `git add` by explicit path only, never `-A`/`.`.
- Never touch `docs/coordination/`, board, milestones, or merge — coordinator's job.
- No migration needed — `uq_candidate_owner_sig` constraint already exists
  (`packages/commitments/sql/0125_commitment_candidates.sql:45`).
- Relay again on the meter's 70% warning or a compaction summary — don't invent a higher personal
  threshold.
