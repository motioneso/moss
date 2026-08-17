# Relay — #1514 commitment upsert atomic

Spec: `docs/superpowers/specs/2026-08-10-1137-robustness-followups.md` §C1 (lines 143-157).
Issue: #1514 (`Part of #1137`). Branch/worktree: `1514-commitment-upsert-atomic` (this worktree).
Plan (coordinator-approved): `docs/superpowers/plans/2026-08-17-1514-commitment-upsert-atomic.md`.
Coordinator: named agent `coord-post1632-take27`, label `Coordinator` (re-resolve fresh via
`herdr pane list` — label + `agent_session.value` are authority, never a `w1:pXX` number from this
doc; as of this write it is pane `w1:pDW`, session `8a84e4de-2910-406c-a793-7cff1705e606`, but
**re-resolve, don't trust that**).

## Done — Task 1 + Task 2 complete, both files, committed

Commit `1477bf2df` on this branch: `fix(#1514): atomic ON CONFLICT upsert for commitment
candidates`. Contains exactly `packages/commitments/src/repository.ts` and
`tests/integration/commitments.test.ts` (confirmed via `git show --name-only`).

- **Task 1**: `upsertCandidate` rewritten to a single
  `insertInto(...).onConflict((oc) => oc.columns(["owner_user_id","candidate_signature"]).doUpdateSet({...}))`
  exactly per the plan's Behavior contract. SELECT-then-branch code deleted entirely.
- **Task 2**: concurrency test hardened with a JS-level readiness barrier (both
  `withDataContext` transactions signal ready — fully BEGUN + actor context set — before either
  calls `upsertCandidate`; released together) instead of naive `Promise.all`. This was the
  coordinator's ruling (force determinism, not best-effort timing) — already resolved, do not
  re-litigate.
- **RED verified** 3/3 runs against the pre-fix code: reliable `23505 duplicate key value violates
  unique constraint "uq_candidate_owner_sig"` thrown from the old `repository.ts:44` insert branch
  (logs: `/tmp/1514-red.log`, `/tmp/1514-red-1.log`, `/tmp/1514-red-2.log` in this worktree's
  session — may be reaped, not durable, don't rely on re-reading them).
- **GREEN verified** 3/3 runs against the fix: all 7 tests in `commitments.test.ts` pass
  (`/tmp/1514-green.log`, `-1.log`, `-2.log`).
- `pnpm --filter @moss/commitments typecheck` → `EXIT=0`.
- `pnpm check:file-size` → `EXIT=0`.
- Gate DB used: `jarvis_gate_1514` (isolated, DROP+CREATE each run per `verify-gate` skill). It
  currently still exists post-last-run — **DROP it before your own gate run** (fresh DB, don't
  reuse):
  ```bash
  docker exec jarv1s-postgres psql -U postgres -c "DROP DATABASE IF EXISTS jarvis_gate_1514;"
  ```

## Next steps (in order)

1. **Pre-push trio + rebase** (not yet run):
   ```bash
   pnpm format:check && pnpm lint && pnpm typecheck
   git fetch origin main && git rebase origin/main
   ```
   Fix anything red before pushing. If rebase conflicts, they should only touch these two files if
   at all — this branch's scope is narrow.
2. **`coordinated-wrap-up`**: full local gate on a **fresh** isolated gate DB (DROP+CREATE
   `jarvis_gate_1514` again, `export JARVIS_PGDATABASE=jarvis_gate_1514`, unpiped with a sentinel,
   per `verify-gate` skill — do not improvise), then push, open PR.
3. **PR body**: state explicitly that live-path proof is **not required** for this lane — internal
   worker/repository fix, no UI surface, no model/chat turn involved (per the plan's Determinism
   boundary section and this handoff). Say "code-complete" plainly, not "live-verified."
4. **Report to coordinator**: PR link + verified evidence (RED/GREEN determinism, typecheck,
   file-size, full gate result). Then **stop** — coordinator owns QA, merge, board, issue close.

## Constraints carried over (unchanged)

- File scope: `packages/commitments/src/repository.ts` and `tests/integration/commitments.test.ts`
  only. Do not touch C2/C3/C4 surface (explicitly out of scope per issue #1514) — build is
  otherwise **complete**, no further production changes needed.
- `git add`/`git commit` by explicit path only, never `-A`/`.`/bare commit — see `shared-checkout`
  skill.
- Never touch `docs/coordination/`, board, milestones, or merge — coordinator's job.
- No migration needed — `uq_candidate_owner_sig` constraint already existed
  (`packages/commitments/sql/0125_commitment_candidates.sql:45`).
- Relay again on the meter's 70% warning or a compaction summary — don't invent a higher personal
  threshold.
