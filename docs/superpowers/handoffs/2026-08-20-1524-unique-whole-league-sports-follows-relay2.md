# Relay continuation 2 — #1524 make whole-league sports follows unique

Checkpointing at context limit, mid-build (not stuck, not blocked). **Plan is approved by the
coordinator** — no need to re-ask. Tasks 1-2 done and committed. Pick up at task 3.

**Plan:** `docs/superpowers/plans/2026-08-20-1524-unique-whole-league-sports-follows.md` — read
this in full before doing anything, it has the exact DDL, signatures, and test list already
decided. This doc only tells you what's done and what's left.

**Coordinator label:** `Coordinator` — re-resolve fresh with `herdr pane list`. It already knows
the plan and does not need to re-approve; message it only at final wrap-up, and repeat explicitly
that issue #1524 must stay open after merge (Ben's ruling, already relayed once).

## Done and committed (verified green, do not redo)

- Commit `2c220bb1a`: added `DELETE` to the migration wire-contract checker's allowlist
  (`packages/db/src/migrations/module-sql-runner.ts`) + unit test.
- Commit `65869f2ee`: the two migrations exist and are proven to apply —
  `packages/sports/sql/0185_sports_whole_league_dedupe.sql` (dedupe DELETE),
  `packages/sports/sql/0186_sports_whole_league_unique.sql` (partial unique index) — manifest
  (`packages/sports/src/manifest.ts`) and both unit/integration ledger tests updated and passing.

## Not yet done — pick up here (plan's task 3, 4, 5)

1. **Task 3 — repository rewrite.** `packages/sports/src/repository.ts` `create()` (currently
   lines 37-63): replace read-then-insert with one insert + untargeted
   `.onConflict((oc) => oc.doNothing())` + re-select-on-null. Exact contract is in the plan's task
   3 section — follow it, do not re-derive. TDD it: write the two new integration tests first
   (concurrent-create barrier test per `tests/integration/commitments.test.ts:85-143` precedent;
   different-owners-same-league test), watch them fail against the CURRENT repository code, then
   rewrite `create()`, watch them pass. The existing "duplicate whole-competition follow" test at
   `tests/integration/sports-follows-repository.test.ts:103-126` must keep passing unchanged
   throughout.
2. **Task 4 — upgrade-path harness test.** Same file. Full procedure is in the plan's task 4
   section: reset, strip 0185/0186 from `app.schema_migrations`, `DROP INDEX IF EXISTS
   app.sports_follows_whole_league_unique_idx`, seed two duplicate `team_key IS NULL` rows via a
   bootstrap client, rerun `runSqlMigrations` against `packages/sports/sql`, assert one row survives
   (the older by `created_at ASC, id ASC`) and the ledger/index are restored.
3. **Task 5 — wrap-up.** Full gate via `verify-gate` skill (own scoped `$GATEDB`, drop it after).
   No live-UI Playwright proof needed (backend-only, no UI surface change) — say so plainly in the
   PR body. Release note: `Category: N/A` is the default call (see plan task 5 for the one-sentence
   reasoning), but confirm with the coordinator if unsure rather than skip silently. Run
   `node scripts/append-release-note.mjs --pr <number>` regardless once the PR exists, commit the
   `docs/WHATS_NEW.md` result. Push, open PR, use `coordinated-wrap-up`.
4. **In the final report to the coordinator: repeat that issue #1524 must stay open after merge** —
   Ben is filing separate follow-on sports-follows work; this is not the last change to that
   surface. The coordinator already acknowledged this once (see conversation), but the actual
   "don't close #1524" action happens at wrap-up, so say it again there.

## Gate DB note

A scoped gate database `jarvis_gate_1524_sports_follows` may still exist from this session's task
2 verification — check with `docker exec jarv1s-postgres psql -U postgres -c "\l"` and drop it if
found before creating your own scoped DB for tasks 3-5, per the `verify-gate` skill (fresh
DROP+CREATE every run, never reuse).
