# Plan — #1524 make whole-league sports follows unique

Spec: `docs/superpowers/specs/2026-08-10-1140-backend-low-followups.md`, section 1140-B.
Issue: #1524 (task issue, open).

**Ben's rulings (already given, do not re-ask):**

1. Add DELETE support to the shared migration file-format checker, then finish the migration and
   uniqueness fix as planned.
2. After this merges, do NOT close #1524 — Ben will file separate follow-on work. Say so in the
   final report to the coordinator.

## Deviation from the spec's literal text, and why

The spec says "Add one sports-owned append-only migration." That is not possible as written: the
shared checker in `packages/db/src/migrations/module-sql-runner.ts` (`validateModuleMigrationSql`)
caps every migration file at exactly one top-level SQL statement. The dedupe `DELETE` and the
`CREATE UNIQUE INDEX` are two statements and cannot share a file, so this plan ships **two** files
(0185, 0186) instead of one. This is the predecessor's finding, not a new judgment call, and is
covered by Ben's "finish it as planned."

## Seams check (file:line citations)

- `packages/sports/src/repository.ts:37-63` — current `create()` still does read-then-insert (the
  race the spec describes).
- `packages/sports/sql/0133_sports_follows.sql:15` — plain `UNIQUE (owner_user_id, competition_key,
team_key)`; Postgres treats `team_key IS NULL` as distinct per row, so it never dedupes
  whole-league follows.
- `packages/db/src/migrations/module-sql-runner.ts:13-19` — `FIRST_COMMAND_ALLOWLIST` has no
  `DELETE` entry today.
- `packages/db/src/migrations/module-sql-runner.ts:40` (`FIRST_COMMAND_ALLOWLIST.some(...)`) is
  anchored with `^` in every pattern, so a statement opening with `WITH` (a CTE) will never match
  `/^DELETE\b/i` even after the fix — the dedupe migration must be a plain `DELETE ... WHERE id IN
(subquery)`, not `WITH dupes AS (...) DELETE ...`.
- `tests/integration/test-database.ts:71-98` (`resetEmptyFoundationDatabase`) runs
  `packages/sports/sql` through `runSqlMigrations` (`packages/db/src/migrations/sql-runner.ts:34`)
  into the plain `app.schema_migrations` ledger — sports is a built-in module, not an
  `external-modules` one, so it does NOT go through `installModule`/`module_schema_migrations`
  (that pipeline is job-search/finance's). The upgrade-path harness in task 4 must target
  `app.schema_migrations` and call `runSqlMigrations` directly, mirroring
  `job-search-tables-install.test.ts`'s ledger-row-removal idea but against the built-in path, not
  its `installModule` call.
- `tests/integration/foundation-schema-catalog.test.ts:330-332` — current max landed version is
  0184 (`0184_admin_reset_password_audit_insert.sql`). Re-check this is still current at build time
  (another lane may land first); the coordinator assigns final numbers if it has moved.
- `packages/tasks/src/lists.ts:31-71` (`getOrCreate`) — closest working `ON CONFLICT DO NOTHING` +
  re-select pattern in this repo, **except** its initial fast-SELECT, which the spec's locked
  repository contract explicitly excludes (insert-first).
- `tests/integration/commitments.test.ts:85-143` — concurrent-upsert-to-one-row-with-barrier
  precedent test shape, reused for task 3's concurrent-create test.
- `tests/unit/finance-sql-files.test.ts:1-21` — precedent for loading a real module's `sql/`
  directory straight through `loadModuleMigrationFiles` to prove wire-contract compliance; not
  required by the spec's exclusive-owned-surface list, so not added here, but confirms the checker
  is designed to run against real per-module directories, which task 4's harness also exercises.

## Task 1 — allow DELETE in the migration wire-contract checker

**File:** `packages/db/src/migrations/module-sql-runner.ts`

Add one entry to `FIRST_COMMAND_ALLOWLIST` (line 13-19), immediately after the existing `UPDATE`
entry, same shape:

```ts
/^DELETE\b/i;
```

**File:** `tests/unit/module-sql-runner.test.ts`

Add one new `it`, mirroring the existing "accepts one data-only UPDATE" case (line 25-30), directly
below it:

```ts
it("accepts one data-only DELETE for an idempotent module-owned migration", () => {
  const result = validateModuleMigrationSql(
    "DELETE FROM app.acme_widgets WHERE id IN (SELECT id FROM app.acme_widgets WHERE qty = 0);"
  );
  expect(result).toEqual({ ok: true, errors: [] });
});
```

Do not touch the existing "rejects a disallowed first command" test (`DROP TABLE`, unaffected).

**Verification:**

```bash
pnpm vitest run tests/unit/module-sql-runner.test.ts > /tmp/t1.log 2>&1; echo "EXIT=$?"
```

Expect `EXIT=0`, all cases including the new one passing.

## Task 2 — the two migrations, manifest, and catalog ledger

**Files (new):**

`packages/sports/sql/0185_sports_whole_league_dedupe.sql`:

```sql
-- packages/sports/sql/0185_sports_whole_league_dedupe.sql
-- Collapses pre-existing whole-league duplicate follows (team_key IS NULL) before 0186 makes them
-- impossible going forward. Plain DELETE with a subquery, no leading WITH — the wire-contract
-- checker's regexes are anchored to the start of the statement and would not match a CTE opener.
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

`packages/sports/sql/0186_sports_whole_league_unique.sql`:

```sql
-- packages/sports/sql/0186_sports_whole_league_unique.sql
-- Partial unique index: Postgres treats NULL as distinct in a plain UNIQUE constraint, so
-- 0133's (owner_user_id, competition_key, team_key) UNIQUE never deduped two team_key IS NULL
-- rows. This closes that gap for whole-league follows going forward; 0185 already collapsed
-- pre-existing duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS sports_follows_whole_league_unique_idx
  ON app.sports_follows (owner_user_id, competition_key)
  WHERE team_key IS NULL;
```

Re-check the actual next-free version numbers immediately before creating these files (task 2
start) — 0184 was the last landed version at plan time; another lane may have landed since. Rename
both files together if so, keeping the DELETE strictly before the CREATE UNIQUE INDEX.

**File:** `packages/sports/src/manifest.ts` (`database.migrations` array, line 59)

```ts
migrations: [
  "sql/0133_sports_follows.sql",
  "sql/0185_sports_whole_league_dedupe.sql",
  "sql/0186_sports_whole_league_unique.sql"
],
```

**File:** `tests/unit/sports-manifest.test.ts` (line 8)

Update the `toEqual` assertion to the three-entry array above.

**File:** `tests/integration/foundation-schema-catalog.test.ts`

Append two rows after the `0184` entry (line 332), same object shape as neighboring entries:

```ts
{ version: "0185", name: "0185_sports_whole_league_dedupe.sql" },
{ version: "0186", name: "0186_sports_whole_league_unique.sql" }
```

**Verification:**

```bash
pnpm vitest run tests/unit/sports-manifest.test.ts > /tmp/t2a.log 2>&1; echo "EXIT=$?"
pnpm vitest run tests/integration/foundation-schema-catalog.test.ts > /tmp/t2b.log 2>&1; echo "EXIT=$?"
```

Both expect `EXIT=0`. The catalog test requires a live migrated DB — use `verify-gate`, never a
bare `pnpm vitest run` against integration tests outside that skill's procedure.

## Kill gate — evaluate before continuing to task 3

**Observation:** does `0185_sports_whole_league_dedupe.sql` apply cleanly against a database that
already has duplicate `team_key IS NULL` rows, and does `0186` then apply without a unique
violation? Prove this with task 2's own catalog test plus a manual local check (seed two duplicate
rows via a bootstrap client, rerun `runSqlMigrations` against `packages/sports/sql`, confirm one row
survives) before writing task 4's full harness test.

**If it fails:** stop, do not proceed to the repository rewrite or the harness test. Re-derive the
DELETE subquery (most likely cause: the `row_number()` window not actually catching the intended
duplicate set, or an owner-scoping bug). This is a builder judgment call, not a return to the
coordinator, since it is within the locked migration contract already approved by Ben — but if two
different DELETE formulations both fail, stop and message the coordinator rather than iterating a
third time.

**Owner:** the builder (this session), evaluated silently as part of task 2's own verification —
no separate report needed if it passes.

## Task 3 — repository rewrite + new tests

**File:** `packages/sports/src/repository.ts`, `create()` (currently lines 37-63)

Replace the existing read-then-insert body. Decision (per the spec's locked repository contract):
one insert attempt with an **untargeted** `.onConflict((oc) => oc.doNothing())` — untargeted so the
same code path absorbs a conflict against either the pre-existing three-column UNIQUE constraint
(named team follow) or the new partial unique index (whole-league follow), no branching on
`teamKey === null`. `.returning([...]).executeTakeFirst()` instead of
`executeTakeFirstOrThrow()`. If it returns a row, map and return it. If it returns nothing (lost the
race, or hit an existing row), re-read the exact owner-scoped `competition_key`/`team_key` row (same
`where` clause the current code already uses, RLS scopes it to the actor) with
`executeTakeFirstOrThrow()` — if that throws, the conflict was real but the row is somehow gone,
which is a genuine invariant violation and should surface as an error, not be swallowed. No
transaction, retry loop, lock, or second method, per the spec.

**File:** `tests/integration/sports-follows-repository.test.ts`

- Existing "duplicate whole-competition follow (teamKey null twice) does not create a second row"
  (line 103-126) — keep unchanged; it must still pass against the new `create()`.
- Add a concurrent-create test, precedent `tests/integration/commitments.test.ts:85-143` (the
  ready/gate/release barrier pattern — plain `Promise.all` does not reliably force two
  `withDataContext` transactions to overlap on fast local Postgres). Same actor, same
  `competitionKey`, `teamKey: null`, both sides released together; assert both results have the same
  `id`, and a follow-up `repo.list()` for that actor returns exactly one row for that competition.
- Add a different-owners-same-league test: two distinct actors each `create()` a whole-league follow
  for the same `competitionKey`; assert both succeed with **distinct** ids, and each actor's
  `repo.list()` shows their own row (the partial index is scoped per `owner_user_id`, not global).

**Verification:**

```bash
pnpm vitest run tests/integration/sports-follows-repository.test.ts > /tmp/t3.log 2>&1; echo "EXIT=$?"
```

Expect `EXIT=0` — via `verify-gate`, real DB required.

## Task 4 — upgrade-path harness test

**File:** `tests/integration/sports-follows-repository.test.ts` (same file, new `describe` or `it`
block — the spec's exclusive-owned-surface list names this file for the harness, not a new file)

Pattern, built on the seam confirmed above (sports is a built-in module through
`runSqlMigrations`/`app.schema_migrations`, not `installModule`):

1. `await resetEmptyFoundationDatabase()` — full reset, every migration including 0185/0186 already
   applied (fresh-DB baseline).
2. Delete the ledger rows for 0185 and 0186 from `app.schema_migrations` via a bootstrap `Client`
   (mirrors `job-search-tables-install.test.ts`'s ledger-removal idea, targeting the built-in
   ledger table instead of `module_schema_migrations`).
3. `DROP INDEX IF EXISTS app.sports_follows_whole_league_unique_idx` via the same bootstrap client
   — required because dropping only the ledger row does not undo the index 0186 already created;
   without this the duplicate seed insert in step 4 fails on the very constraint the harness needs
   to still be absent (spec: "do not simulate cleanup after the index already exists").
4. Seed two duplicate `team_key IS NULL` rows directly (bootstrap client, bypassing RLS) for one
   owner/competition, with distinct `created_at` values (older one must sort first by `created_at
ASC, id ASC`) — this is only possible because step 3 removed the index that would otherwise
   reject the second insert.
5. Call `runSqlMigrations({ connectionString: connectionStrings.migration, migrationsDirectory:
"packages/sports/sql" })` (same helper `test-database.ts` uses internally) — asserts it applies
   exactly `0185` and `0186` (both were stripped from the ledger; 0133 is already there and skips).
6. Assert: exactly one row remains for that owner/competition/`team_key IS NULL`, and its `id`
   matches the older seeded row's `id` (the deterministic `created_at ASC, id ASC` survivor).
7. Assert the ledger has both `0185` and `0186` rows again, and the partial index exists again
   (`SELECT 1 FROM pg_indexes WHERE indexname = 'sports_follows_whole_league_unique_idx'`).

**Verification:**

```bash
pnpm vitest run tests/integration/sports-follows-repository.test.ts > /tmp/t4.log 2>&1; echo "EXIT=$?"
```

Expect `EXIT=0` — via `verify-gate`.

## Task 5 — wrap-up

- Full gate via the `verify-gate` skill (never run `pnpm verify:foundation` directly, never pipe
  it). Record the unpiped exit code.
- This is a backend/race-condition + migration fix with no UI surface change (Sports settings
  screen itself is unchanged); the spec's own "Focused acceptance" list is entirely
  integration/unit tests, no UAT spec is named. Default to **not** requiring a live-UI Playwright
  proof; state this plainly in the PR body. If the coordinator disagrees, it will say so — don't
  silently skip a required gate either way.
- Fill in the PR template's Release note section. This is backend-only (race condition + data
  integrity fix, no visible behavior change for a correctly-behaving client) — `Category: N/A`
  unless the coordinator judges otherwise, since a duplicate whole-league follow was already
  functionally invisible to the user (the old repository already deduped it in application code,
  just not race-safely).
- Run `node scripts/append-release-note.mjs --pr <number>` regardless (per CLAUDE.md, "every pull
  request fills in... and carries the note" — even an N/A entry goes through the script) and commit
  the resulting `docs/WHATS_NEW.md` change onto the branch.
- Push, open the PR, use `coordinated-wrap-up`.
- **In the final report to the coordinator: state explicitly that issue #1524 must stay open after
  merge — Ben is filing separate follow-on sports-follows work and this is not the last change to
  that surface.**

## Files touched (confirmed against this branch)

- `packages/db/src/migrations/module-sql-runner.ts` (allowlist)
- `tests/unit/module-sql-runner.test.ts` (new DELETE-acceptance case)
- `packages/sports/sql/0185_sports_whole_league_dedupe.sql` (new)
- `packages/sports/sql/0186_sports_whole_league_unique.sql` (new)
- `packages/sports/src/repository.ts` (`create()`)
- `packages/sports/src/manifest.ts` (`database.migrations`)
- `tests/unit/sports-manifest.test.ts`
- `tests/integration/foundation-schema-catalog.test.ts`
- `tests/integration/sports-follows-repository.test.ts` (concurrent test, different-owners test,
  upgrade-path harness test)
- `docs/WHATS_NEW.md` (release note, via the script)
