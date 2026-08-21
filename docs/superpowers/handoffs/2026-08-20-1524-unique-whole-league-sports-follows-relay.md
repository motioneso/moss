# Relay continuation — #1524 make whole-league sports follows unique

Relaying at context-meter 70% warning. **No code written or committed yet** — this run was
research/seams-check only. Tree is clean.

**Spec:** `docs/superpowers/specs/2026-08-10-1140-backend-low-followups.md`, section "1140-B"
(lines ~100-155). **Issue:** #1524. **Coordinator label:** `Coordinator` — re-resolve fresh with
`herdr pane list`, confirm exactly one pane holds it, before messaging.

## Ben's ruling (already given, do not re-ask)

1. Add delete-row support to the shared migration file-format checker
   (`packages/db/src/migrations/module-sql-runner.ts`), then finish the migration and the
   uniqueness fix as planned.
2. **After this merges, do NOT close issue #1524.** Ben is planning more sports-follows work and
   will file a new issue separately. Say this explicitly in the final report to the coordinator —
   closing the issue is the coordinator's job normally, but this one needs to stay open.

## What I found (verified against this branch, not yet acted on)

- `packages/sports/src/repository.ts` `create()` (~lines 38-62): still has the exact
  read-before-insert race the spec describes. Needs replacing with one insert using
  `ON CONFLICT DO NOTHING` + `RETURNING`, re-reading the exact owner-scoped row on null, throwing
  if that re-read finds nothing. Closest working pattern in this repo: `packages/tasks/src/lists.ts`
  `getOrCreate` (lines ~30-70) — copy its `.onConflict((oc) => oc.doNothing())` +
  `.returningAll()` shape, but **skip its initial fast-SELECT** (the spec wants insert-first).
- `packages/sports/sql/0133_sports_follows.sql`: only migration so far. Table has a plain
  3-column `UNIQUE (owner_user_id, competition_key, team_key)`, which does NOT dedupe two
  `team_key IS NULL` rows (Postgres treats NULL as distinct). That's the gap this task closes with
  a new **partial** unique index `(owner_user_id, competition_key) WHERE team_key IS NULL`.
- **The real blocker Ben ruled on:** every module SQL migration file (sports included) is checked
  by `validateModuleMigrationSql` in `packages/db/src/migrations/module-sql-runner.ts`
  (`FIRST_COMMAND_ALLOWLIST`, lines ~12-19): a file must contain **exactly one** top-level SQL
  statement, and that statement's first command must be one of CREATE TABLE, CREATE [UNIQUE]
  INDEX, ALTER TABLE, DROP INDEX, COMMENT ON, UPDATE. Add `/^DELETE\b/i` to that list (mirrors the
  existing `UPDATE` entry) and add one new unit test case to
  `tests/unit/module-sql-runner.test.ts` (mirror the existing "accepts one data-only UPDATE" case
  around line 25) — do not touch the existing "rejects a disallowed first command" test (it uses
  `DROP TABLE`, unaffected).
- **Second-order consequence, not yet raised with the coordinator (my call, not a new fork —
  covered by Ben's "finish it as planned"):** the checker's regexes are anchored to the start of
  the string (`^DELETE\b` etc.), so a statement that starts with a CTE (`WITH dupes AS (...)
  DELETE ...`) will NOT match — it starts with the word `WITH`, not `DELETE`. Write the dedupe as a
  **plain `DELETE` with a subquery**, no leading `WITH`:
  ```sql
  DELETE FROM app.sports_follows
  WHERE team_key IS NULL
    AND id IN (
      SELECT id FROM (
        SELECT id,
               row_number() OVER (
                 PARTITION BY owner_user_id, competition_key
                 ORDER BY created_at ASC, id ASC
               ) AS rn
        FROM app.sports_follows
        WHERE team_key IS NULL
      ) ranked
      WHERE rn > 1
    );
  ```
  And because the checker also caps each file at exactly one statement, the DELETE and the
  `CREATE UNIQUE INDEX ... WHERE team_key IS NULL` **cannot share one file** — this needs **two**
  append-only migration files, not the single file name the original handoff doc's "exclusive
  owned surface" listed. Suggested working names (renumber at rebase — see the "Renumbered"
  precedent comments around `tests/integration/foundation-schema-catalog.test.ts` line ~245-260):
  - `packages/sports/sql/0185_sports_whole_league_dedupe.sql` — the DELETE above.
  - `packages/sports/sql/0186_sports_whole_league_unique.sql` — `CREATE UNIQUE INDEX IF NOT
    EXISTS sports_follows_whole_league_unique_idx ON app.sports_follows (owner_user_id,
    competition_key) WHERE team_key IS NULL;`
  Current max landed version in this tree: **0184** (`tests/integration/foundation-schema-catalog.test.ts`,
  last entry `0184_admin_reset_password_audit_insert.sql`) — re-check this is still current before
  finalizing numbers; the coordinator assigns final landing order per the collision notes (#1572,
  #906 queue behind this lane).

## Not yet done — pick up here

1. **Locate the sports module's install path in the integration test harness** before writing the
   required upgrade-path harness test (spec's non-blocking builder requirement). Start from
   `tests/integration/job-search-tables-install.test.ts` lines ~1-70 (its `install()` helper,
   `urls.bootstrap`, ledger table `app.module_schema_migrations`) as the precedent pattern, and
   find/build the sports equivalent. The harness must: seed duplicate NULL-team rows in an
   isolated test DB, delete only the new dedupe migration's ledger row(s), drop only the new
   partial index, then rerun the sports migration directory and assert the duplicates collapse to
   the oldest row (`created_at ASC, id ASC`) and the ledger/index are restored. Do not simulate
   cleanup after the index already exists (spec is explicit that a fresh-DB reset is insufficient
   here).
2. **Write the actual plan** with `plan-build` (DDL above, exact repository signature, test list,
   verification commands with unpiped exit codes, kill gate) to
   `docs/superpowers/plans/2026-08-20-1524-unique-whole-league-sports-follows.md` — not written
   yet.
3. Message the coordinator "plan ready" and **wait for approval** before writing any code
   (coordinated-build step 1 — not yet reached).
4. Build via `superpowers:test-driven-development`, one task at a time, committed green.
5. Files to touch, confirmed against this branch:
   - `packages/db/src/migrations/module-sql-runner.ts` (allowlist)
   - `tests/unit/module-sql-runner.test.ts` (new DELETE-acceptance case)
   - `packages/sports/sql/0185_..._dedupe.sql`, `packages/sports/sql/0186_..._unique.sql` (new)
   - `packages/sports/src/repository.ts` (`create()`)
   - `packages/sports/src/manifest.ts` (`database.migrations` array, ~line 59 — add both new
     paths, in order)
   - `tests/unit/sports-manifest.test.ts` (line ~8, update the `toEqual` migrations array)
   - `tests/integration/foundation-schema-catalog.test.ts` (append two ledger rows after 0184)
   - `tests/integration/sports-follows-repository.test.ts` — existing "duplicate whole-competition
     follow" test should keep passing unchanged; ADD a concurrent-create test (precedent:
     `tests/integration/commitments.test.ts` "resolves two concurrent upserts... to one row with no
     23505", ~line 85), ADD a different-owners-same-league test, ADD the upgrade-path harness test
     from step 1.
6. Wrap up with `coordinated-wrap-up`: gate, PR, push. This is a backend/race-condition + migration
   fix with no UI surface change (the Sports settings screen itself is unchanged) — the spec's own
   "Focused acceptance" list is entirely integration/unit tests, no UAT spec is named. Default to
   treating this as NOT requiring a live-UI Playwright proof; say so plainly in the PR body. If
   unsure, confirm with the coordinator rather than silently skipping a required gate.
7. **In the final report to the coordinator: repeat Ben's instruction that issue #1524 must stay
   open after merge.**
