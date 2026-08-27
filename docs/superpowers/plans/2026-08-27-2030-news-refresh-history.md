# Build plan — #2030 Record every news refresh attempt, success and failure

Part of #1586 (Moss self-diagnostics), piece 1 of 3.
Approved spec: the `SPEC` comment on issue #2030 (fleet brief accepts an issue-comment spec).
Branch: `fleet/lane-2030`. Risk tier: security.

## Problem

`app.news_refresh_state` is one row per user holding _live_ status only. `failure_kind` is cleared
at the start of the next run and again on success, and `updated_at` only says when the row last
moved at all. Once the state returns to `idle`, a run that failed an hour ago and a run that
succeeded a minute ago are indistinguishable.

## Seams check — every assumption cited on this branch

| Assumption                                                                        | Evidence                                                                                                       | Verdict                                                 |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Table exists, owner-only, FORCE RLS                                               | `packages/news/sql/0160_news_discovery.sql:5-12`, `:29-33`                                                     | confirmed                                               |
| Policies are table-level for app **and** worker roles, so new columns are covered | `packages/news/sql/0160_news_discovery.sql:36-56`                                                              | confirmed                                               |
| Grants are table-wide (not column-scoped) for both roles                          | `packages/news/sql/0160_news_discovery.sql:60` inside the loop at `:29`                                        | confirmed                                               |
| The column-scoped worker grants do **not** apply to this table                    | `packages/news/sql/0161_news_revalidation.sql:17-22` targets `news_custom_sources` / `news_custom_topics` only | confirmed — spec's "no GRANT needed" holds              |
| Four write points + one read                                                      | `packages/news/src/personalization-repository.ts:494,508,525,537,570`                                          | confirmed                                               |
| Failure write runs in a fresh data context as the worker role                     | `packages/news/src/personalization-repository.ts:570-577`                                                      | confirmed                                               |
| Snapshot table has `compiled_at`, `expires_at`, `payload`                         | `packages/news/sql/0159_news_personalization.sql:81-88`                                                        | confirmed                                               |
| Column types live in one interface                                                | `packages/db/src/types.ts:1148-1155` (spec said 1097 — drift, harmless)                                        | confirmed                                               |
| Contract in two places, `additionalProperties: false`                             | `packages/shared/src/news-api.ts:231-235` and `:503-512`                                                       | confirmed                                               |
| Migration ledger test pins the exact file list                                    | `tests/integration/foundation-schema-catalog.test.ts:363` ends at `0201`                                       | confirmed                                               |
| Routes unit test builds a whole refresh DTO literal                               | `tests/unit/news-routes.test.ts:148,205`                                                                       | confirmed — must be updated when fields become required |

### Corrections to the spec, already verified

1. **Migration number.** The spec says take `0192` because `0191` is the highest. On this branch
   the highest is `0201`, and `0202_workflow_runs.sql` is already claimed by another branch.
   **This plan claims `0203`.** Scan used: every `02xx` SQL file across all remote branches and all
   local worktrees.
2. **Line-number drift.** `NewsRefreshStateTable` is at `packages/db/src/types.ts:1148`, not 1097.
   No behavioural difference.

No open questions. No new platform capability is assumed.

## Determinism boundary

Not applicable in the usual sense: this slice adds no UI, no chat surface and no model call. The
new values are recorded facts (timestamps and a failure category) written by the same code paths
that already write the live status. Nothing renders from model output. No prompt text is added, so
the 150-word guidance budget is not in play.

## Trust boundary (security tier)

- Every new column sits on an existing owner-only FORCE-RLS table. Reads and writes stay scoped by
  `app.current_actor_user_id()`; no new policy, no new grant, no `BYPASSRLS`.
- The new columns carry operational metadata only: four timestamps and one of three fixed failure
  categories, constrained by a CHECK. No article text, no provider response, no credential, no
  free-form string from any external source ever reaches them.
- `readRefreshDiagnostics` must never select `payload`. The item count is computed inside Postgres
  so article text never leaves the database.
- Account deletion already cascades the whole table via the manifest's data-lifecycle block; the
  table is deliberately not exported. No change needed, and this plan makes none.

## Tasks

Each task commits green on its own.

### Task 1 — migration + column types

- New file `packages/news/sql/0203_news_refresh_history.sql`. Never edit `0160`.

```sql
ALTER TABLE app.news_refresh_state
  ADD COLUMN IF NOT EXISTS last_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_attempt_at   timestamptz,
  ADD COLUMN IF NOT EXISTS last_success_at   timestamptz,
  ADD COLUMN IF NOT EXISTS last_failure_at   timestamptz,
  ADD COLUMN IF NOT EXISTS last_failure_kind text;

ALTER TABLE app.news_refresh_state
  DROP CONSTRAINT IF EXISTS news_refresh_state_last_failure_kind_check;
ALTER TABLE app.news_refresh_state
  ADD CONSTRAINT news_refresh_state_last_failure_kind_check
  CHECK (last_failure_kind IS NULL OR last_failure_kind IN ('fetch', 'ai', 'internal'));
```

Drop-then-add on the constraint is deliberate: bare `ADD CONSTRAINT` is not re-runnable.
File header records the owner-only RLS classification and why no GRANT/POLICY is added.

- Declare `"sql/0203_news_refresh_history.sql"` in `database.migrations` in
  `packages/news/src/manifest.ts` (after the `0200` entry).
- Add the file to the pinned ledger in `tests/integration/foundation-schema-catalog.test.ts`
  after the `0201` entry, with a one-line comment naming #2030.
- Add five fields to `NewsRefreshStateTable` (`packages/db/src/types.ts:1148`):
  `last_requested_at`, `last_attempt_at`, `last_success_at`, `last_failure_at` as
  `TimestampColumn | null`; `last_failure_kind` as `"fetch" | "ai" | "internal" | null`.

**Kill gate (owner: this lane, reported via `fleetctl`).** If the migration cannot be applied
without touching an existing applied file, or if the worker role turns out to need an explicit
column grant after all, stop and record a blocker rather than widening the migration. Evaluated
after Task 1's verification, before Task 2.

Verify: `pnpm typecheck > /tmp/t1.log 2>&1; echo "EXIT=$?"` → expect `EXIT=0`.
Migration + ledger test run under the `verify-gate` skill in Task 4.

### Task 2 — record the four events, and the two reads

In `packages/news/src/personalization-repository.ts`. Live-status columns keep their current
meaning; new columns mean "the last time this happened, ever", and a later success must not clear
them.

- `bumpRefreshRequest` — set `last_requested_at = now()` on the INSERT and the ON CONFLICT branch.
- `beginRefreshRun` — set `last_attempt_at = now()` on both branches.
- `publishSnapshotIfCurrent` — set `last_success_at = now()` in the existing compare-and-set
  UPDATE (the branch already setting `state = 'idle'`).
- `failRefreshRunIfCurrent` — set `last_failure_at = now()` and `last_failure_kind = <kind>`
  alongside the existing `state`/`failure_kind` writes.

Signatures — no existing signature changes. One new method:

```ts
readRefreshState(scopedDb: DataContextDb): Promise<NewsRefreshStateDto>   // unchanged signature
readRefreshDiagnostics(scopedDb: DataContextDb): Promise<NewsRefreshDiagnostics>

interface NewsRefreshDiagnostics {
  readonly refresh: NewsRefreshStateDto;
  readonly requestedGeneration: number;
  readonly compiledGeneration: number;
  readonly snapshotCompiledAt: string | null;
  readonly snapshotExpiresAt: string | null;
  readonly snapshotAgeSeconds: number | null;
  readonly itemCount: number;
}
```

`readRefreshState` returns the five new fields as ISO strings or `null`; with no row at all it
returns `{ state: "idle", updatedAt: null }` plus `null` for each new field.

`readRefreshDiagnostics` answers the freshness question in one query, joining refresh state and
snapshot off a one-row select so it works with no refresh row, no snapshot, either or both. It
selects `compiled_at`, `expires_at`, an epoch-seconds age, and a count computed as
`jsonb_array_length(payload -> 'articles')` guarded by `jsonb_typeof(...) = 'array'`, defaulting to 0. **It never selects `payload`.** No owner filter — row-level security already restricts each
table to the acting user's row, matching the style of the existing methods in this file.

This method has no production caller in this slice; the diagnostics provider that consumes it is
the next piece. Integration tests are its caller for now.

Verify: `pnpm typecheck > /tmp/t2.log 2>&1; echo "EXIT=$?"` → expect `EXIT=0`.

### Task 3 — the contract

Both edits in `packages/shared/src/news-api.ts`, or neither:

- `NewsRefreshStateDto` (`:231`) gains `lastRequestedAt`, `lastAttemptAt`, `lastSuccessAt`,
  `lastFailureAt` as `string | null`, and `lastFailureKind` as
  `"fetch" | "ai" | "internal" | null`.
- `newsRefreshStateDtoSchema` (`:503`) gains the same five in `properties` **and** in `required`.

The trap: the schema sets `additionalProperties: false`, so Fastify silently drops any field not
listed — the repository would return the history and the API would not, and it would read as a
repository bug.

Follow-on: `tests/unit/news-routes.test.ts:148,205` builds whole `NewsRefreshStateDto` literals;
both need the five new fields once they are required.

Verify: `pnpm typecheck > /tmp/t3.log 2>&1; echo "EXIT=$?"` → expect `EXIT=0`.
`pnpm vitest run tests/unit/news-routes.test.ts > /tmp/t3u.log 2>&1; echo "EXIT=$?"` → expect
`EXIT=0` (no database).

### Task 4 — tests (test-driven; written before Tasks 2 and 3 where practical)

All of these touch the database. **Every run goes through the `verify-gate` skill** — an unscoped
run hits the live dev database.

In `tests/integration/news-discovery-repository.test.ts`:

1. **History.** Walk one owner through request → attempt → success → request → attempt → failure.
   Asserts each of the four timestamps moves only on its own event, that the failure kind is
   stored, and that a following success clears the live `failure_kind` while leaving
   `last_failure_at` and `last_failure_kind` untouched.
   _Fails against a broken implementation:_ if a new run cleared history the way it clears live
   status, the post-success assertion on `last_failure_at` goes null.
2. **Freshness.** With no snapshot, `readRefreshDiagnostics` returns item count 0 and a null age.
   After publishing a snapshot with a known article count, the count matches and the age is small.
   Asserts the payload text never appears anywhere in the returned object.
   _Fails against a broken implementation:_ a `SELECT payload` or a JS-side `.length` puts article
   text in the result and the payload-absence assertion trips.
3. **Owner scoping and row-level security.** A second owner reading their own state sees an
   all-null history, never the first owner's. Extends the existing cross-owner case so an UPDATE
   naming the new columns on the other owner's row changes nothing, and a direct SELECT of that row
   returns no rows.
   _Fails against a broken implementation:_ any missed owner scoping or a policy gap on the new
   columns lets the second owner read or write the first owner's history.

In `tests/integration/news-refresh-jobs.test.ts` (the worker path):

4. A successful run records both an attempt and a success.
5. A failing fetch records an attempt plus a failure time and the kind `"fetch"`, with the stored
   feed left alone.
   _Fails against a broken implementation:_ the failure path runs as the worker role in a fresh
   data context; if the new columns were not writable there, this is where it shows.

In `tests/integration/foundation-schema-catalog.test.ts`: the ledger entry from Task 1. Omitting it
makes every integration test in the suite fail on an unrelated-looking assertion.

### Verification (all through the `verify-gate` skill, never piped)

```
pnpm db:migrate                                                        # EXIT=0
tsx scripts/test-integration.ts tests/integration/news-discovery-repository.test.ts \
  tests/integration/news-refresh-jobs.test.ts \
  tests/integration/foundation-schema-catalog.test.ts                  # EXIT=0
pnpm verify:foundation                                                 # EXIT=0
```

A green local gate still excludes CI's end-to-end browser step, so watch CI too.

## End-to-end / live-path position

This slice adds no user-facing surface: no screen, no new endpoint, no visible change. The
end-to-end proof for each phase is therefore the integration coverage above, which exercises the
real database with real row-level security under the real worker role — not a fake. Per
`docs/DEVELOPMENT_STANDARDS.md` → Live-Path Gate, there is no browser proof to record.

If a reviewer wants a live check anyway: run `pnpm db:migrate` against the dev instance, open News
so a refresh runs, and show `GET /api/news/personalization` now carrying the history fields.

## Release note

Category: N/A. Nothing changes on screen for a user in this piece.

## Out of scope

No assistant tools, no diagnostics service, no module provider seam, no source inspection — those
are the two follow-on pieces of #1586. Do not start them here.
