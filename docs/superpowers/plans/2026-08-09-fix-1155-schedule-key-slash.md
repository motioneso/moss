# Plan — fix-1155-schedule-key-slash

**Spec:** `docs/superpowers/specs/2026-08-08-non-feature-wave-2.md` (row #1155)
**Issue:** Part of #1155
**Risk tier:** routine

## Seams check (file:line citations, current branch `fix-1155-schedule-key-slash`)

- Bug: `packages/module-registry/src/index.ts:910` — `const scheduleKey = \`${actorUserId}:${source}\`;`inside`buildReconcileProactiveSchedule` (`index.ts:904-928`). Used at `index.ts:921`as`boss.schedule(..., { key: scheduleKey })`and`index.ts:924`as`boss.unschedule(PROACTIVE_SCAN_SOURCE_QUEUE.name, scheduleKey)`. Colon is outside pg-boss v12's
`assertKey` charset (`/^[\w.\-/]+$/`), so `boss.schedule`throws`AssertionError`for any enabled
source — confirmed live by memory`mem_mrqn1sof_9d500c7ebba4`(2026-07-18), which flagged this
exact line as the "latent sibling" of the job-reconciler bug fixed in`1c2477cb6` (#1147).
- `buildReconcileProactiveSchedule` is **not exported** — confirmed via
  `grep -n "^function buildReconcileProactiveSchedule" packages/module-registry/src/index.ts`
  (only definition, no `export` keyword; only internal call site is `index.ts:1117-1118`). It must
  be exported to be reachable from a focused test — this is the smallest change that makes the fix
  testable without adding a new abstraction.
- Precedent fix, same bug class: `packages/module-registry/src/external/job-reconciler.ts:130-136`
  — `1c2477cb6` changed the separator from `:` to `/` with the comment reproduced below. Mirror the
  same separator and comment style.
- Already-exported seams the test can reuse directly from `@moss/module-registry`
  (`packages/module-registry/package.json:7` maps `"."` to `./src/index.ts`):
  - `getBuiltInModuleManifests()` — `index.ts:1984`
  - `proactiveMonitorProvidersFor(manifests)` — `index.ts:2087`
  - `PROACTIVE_SCAN_SOURCE_QUEUE` re-exported from `@moss/proactive-monitoring` at `index.ts:291`
- Preference shape: `packages/shared/src/proactive-monitoring-api.ts:55`
  `defaultProactiveMonitoringPreference()` — `ProactiveMonitoringPreferenceV1` with
  `sources: Record<ProactiveSource, { enabled, dailyCardCap }>`, `ProactiveSource` = `"tasks" |
"calendar" | "email" | "notes"` (`proactive-monitoring-api.ts:1`). Four built-in manifests declare
  `proactiveMonitor` (`packages/{tasks,calendar,email,notes}/src/manifest.ts`), so
  `proactiveMonitorProvidersFor(getBuiltInModuleManifests())` yields all four sources in the real
  tree — no fixture manifest needed.
- Real-pg-boss integration test precedent: `tests/integration/connectors-google-schedule-root.test.ts:1-142`
  — `createPgBossClient` from `@moss/jobs`, `connectionStrings`/`resetFoundationDatabase` from
  `./test-database.js`, queries `pgboss.schedule` via a raw `pg.Client` against
  `connectionStrings.bootstrap`. Same pattern reused here.
- Gate-DB isolation: `tests/integration/test-database.ts:49-60` (`assertIsolatedTestDatabase`)
  refuses to run against the shared dev DB; `scripts/test-integration.ts:32-36` runs a single file
  when passed as a CLI arg (`resolveVitestArgs`), so no new `package.json` script is required — this
  test rides the existing `tests/integration` glob and can be run focused via
  `tsx scripts/test-integration.ts tests/integration/module-registry-proactive-schedule.test.ts`.

## Non-goals (per spec)

No generic schedule-key helper, no change to `idempotencyKey` (index.ts:916 — that field is job
payload metadata, not a pg-boss key, and is not subject to `assertKey`), no change to
`reconcileNotesSchedule` or the job-reconciler (`1c2477cb6` already fixed that seam).

## Task 1 — fix the separator, export the function

**File:** `packages/module-registry/src/index.ts`

- Line 904: add `export` — `export function buildReconcileProactiveSchedule(boss: PgBoss):
ReconcileProactiveScheduleFn {`
- Line 909-910: replace the existing one-line comment and key with:
  ```ts
  // "/" separator, NOT ":" — pg-boss v12's assertKey restricts schedule keys to
  // [\w.\-/] (see job-reconciler.ts's identical fix, #1147). One row per user+source.
  const scheduleKey = `${actorUserId}/${source}`;
  ```
- No other lines change. `idempotencyKey` at line 916 stays `:`-separated (job data, not a pg-boss
  key — unaffected by `assertKey`).

**Verification:** `pnpm --filter @moss/module-registry typecheck > /tmp/mr-typecheck.log 2>&1; echo
"EXIT=$?"` — expect `EXIT=0`.

## Task 2 — focused real-pg-boss integration test

**File (new):** `tests/integration/module-registry-proactive-schedule.test.ts`

Test cases (behavior + why each fails pre-fix):

1. **"schedules a proactive-monitoring key with a real pg-boss client — no colon"** — build a
   `ProactiveMonitoringPreferenceV1` (spread `defaultProactiveMonitoringPreference()`, `enabled:
true`, `sources.tasks.enabled: true`, all other sources left `enabled: false`). Call
   `buildReconcileProactiveSchedule(boss)(ids.userA, pref)`. Assert the call **does not throw** —
   pre-fix, `boss.schedule` throws `AssertionError` on the `:`-separated key for the `tasks` source,
   so this assertion fails without the fix and passes with it (this is the real pg-boss v12 path:
   `createPgBossClient` from `@moss/jobs`, not a fake/mock boss).
2. Query `pgboss.schedule` for `name = PROACTIVE_SCAN_SOURCE_QUEUE.name` via a raw `pg.Client`
   against `connectionStrings.bootstrap` (mirrors `connectors-google-schedule-root.test.ts`'s
   `scheduleRows()` helper). Assert exactly one row has `key = \`${ids.userA}/tasks\``and assert
that key`.includes(":")`is`false` — proves the persisted key is accepted and slash-separated,
   not just that the call didn't throw.
3. **"unschedules with the same slash-separated key when a source is disabled"** — call reconcile
   again with `sources.tasks.enabled: false`; assert `boss.unschedule` also succeeds (no throw) and
   the row for `${ids.userA}/tasks` is gone from `pgboss.schedule`.

Structure (imports/setup, no function bodies beyond the assertions above):

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import {
  buildReconcileProactiveSchedule,
  getBuiltInModuleManifests,
  proactiveMonitorProvidersFor,
  PROACTIVE_SCAN_SOURCE_QUEUE
} from "@moss/module-registry";
import { defaultProactiveMonitoringPreference } from "@moss/shared";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const { Client } = pg;
// beforeAll: resetFoundationDatabase(); boss = createPgBossClient(connectionStrings.worker, {
//   schedule: true, connectionTimeoutMillis: 25_000 }); await boss.start();
// afterAll: await boss.stop({ graceful: false });
// scheduleRows(): SELECT key FROM pgboss.schedule WHERE name = $1 — same shape as
//   connectors-google-schedule-root.test.ts's helper.
```

`proactiveMonitorProvidersFor(getBuiltInModuleManifests())` is called only to confirm in-test that
`tasks` is a real registered source (a one-line sanity `expect(...).toContainEqual(...)`) — the
reconcile call itself only needs the preference object, not the provider list.

**Verification:**

```bash
tsx scripts/test-integration.ts tests/integration/module-registry-proactive-schedule.test.ts > /tmp/t1155.log 2>&1; echo "EXIT=$?"
```

Expect `EXIT=0`, and the log to show the new `describe` block's 3 tests passing.

Confirm the test fails pre-fix: temporarily `git stash` Task 1's change, rerun the same command,
expect `EXIT=1` with an `AssertionError` (pg-boss's, not vitest's) in the log, then `git stash pop`.

## Kill gate

None needed — single file, single well-scoped test, no architectural fork. If Task 2's real-pg-boss
run reveals `assertKey` also rejects something else about this key shape (e.g. `source` containing
a character outside `[\w.\-/]`), stop and escalate to the coordinator before widening scope; the
four `ProactiveSource` values are all plain lowercase words so this is not expected.

## Determinism boundary

N/A — no user-facing UI or model-authored content in this change.
