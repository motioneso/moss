# Plan — manual-run job idempotency race (#1547)

Spec: `docs/superpowers/specs/2026-08-11-1547-job-idempotency-race.md`
Task issue: #1547 (`task`)
Risk tier: routine (backend-only, no UI surface, no live-path UAT required per spec's own text)

## Seams check (file:line citations)

- `packages/jobs/src/module-jobs.ts:93-110` — current `sendModuleJob` signature, no db param.
  Ends with `return boss.send(queue.name, payload, options);`.
- `packages/jobs/src/pg-boss.ts:1-9` — `sql`/`Kysely` already imported from `kysely`; no new
  import needed to add a Kysely `sql` helper in this file.
- `packages/jobs/src/pg-boss.ts:148-163` — `hasInFlightJob(rootDb, queueName, actorUserId)`,
  the exact `sql` tagged-template idiom this fix mirrors. State-based (`state in (...)`), no time
  bound — confirmed not reusable as-is (would block a legitimate #965 rerun past 5s).
- `packages/jobs/src/index.ts:1` — `export * from "./pg-boss.js"` already re-exports everything in
  that file; a new `hasRecentJob` export needs no index.ts edit.
- `packages/briefings/src/repository.ts:220-227` — the `pg_advisory_xact_lock(hashtextextended(lockKey, 0))`
  idiom this fix's lock acquisition mirrors. Precedent takes the lock on an **already-open**
  transaction (`scopedDb.db`); this fix has no ambient open transaction at its call site, so it
  opens its own via `Kysely<MossDatabase>.transaction().execute(...)`.
- `apps/api/src/external-module-jobs.ts:11-19` — `registerExternalModuleJobRoutes(server, deps)`,
  `deps` has no db handle today.
- `apps/api/src/external-module-jobs.ts:66-82` — the manual-run handler's `sendModuleJob(...)` call,
  6 positional args today (`boss, access, module, queue, command, options`).
- `apps/api/src/server.ts:195-203` — `createApiServer`: `appDb` constructed/available here.
- `apps/api/src/server.ts:386-393` — `registerExternalModuleJobRoutes(server, {...})` registration
  call site; `appDb` is in scope at this point in the function.
- `tests/unit/jobs-pg-boss.test.ts:115-152` — existing `sendModuleJob` unit test calls it with 6
  positional args, `options` has `singletonKey` only (no `singletonSeconds`), no db arg. Must stay
  green **unmodified**.
- `tests/unit/external-module-jobs.test.ts:12-64` — existing route unit test, fake `boss`, no real
  DB, asserts exact `boss.send` call args. Must stay green **unmodified**.
- `tests/integration/external-modules-routes.test.ts:1-90` — existing harness: temp-dir module
  fixture (`acme-widgets`, queue `acme-widgets.manual`, `allowManualRun:true`), real
  `createApiServer({appDb, ...})`, `appDb = createDatabase({connectionString: connectionStrings.app,
maxConnections: 1})`. Lines 110-181 already contain a **sequential** two-call dedupe test
  (202/`{jobId:string}` then 202/`{jobId:null}`) — must stay green and unmodified in intent (spec's
  "Existing manual-run API/worker surface tests remain green").
- `tests/integration/job-search-worker-surface.test.ts` Test 6 (sequential dedupe) — separate
  precedent test, must also stay green and unmodified in intent (spec, Additional acceptance item).
- `apps/api/src/server.ts:203` — `boss = options.boss ?? createPgBossClient(...)` constructed
  internally; the new integration test does not need to construct or pass a `boss`.

No platform capability this plan needs is missing; no open questions requiring escalation before
building.

## Design decisions

### 1. `packages/jobs/src/pg-boss.ts` — new `hasRecentJob` export

```ts
export async function hasRecentJob(
  db: Kysely<MossDatabase>,
  queueName: string,
  singletonKey: string,
  singletonSeconds: number
): Promise<boolean>;
```

SQL (mirrors `hasInFlightJob`'s tagged-template style):

```sql
select exists (
  select 1
  from pgboss.job
  where name = ${queueName}
    and singleton_key = ${singletonKey}
    and state <> 'cancelled'
    and created_on >= now() - (${singletonSeconds} || ' seconds')::interval
) as recent
```

Scoped by `singleton_key` directly (a real column backing unique index `job_i4`), not by
reconstructing the composite key from `data->>`. Time-bounded on `created_on`, independent of which
`singleton_on` bucket the existing row landed in — this is what makes it safe to reuse across a
bucket boundary without narrowing the 5s double-click window from #965.

### 2. `packages/jobs/src/module-jobs.ts` — `sendModuleJob` gains an optional trailing param

```ts
export async function sendModuleJob(
  boss: PgBoss,
  access: AccessContext,
  module: { readonly id: string; readonly manifestHash: string },
  queue: ExternalModuleQueueDeclaration,
  command: { readonly jobKind: string; readonly params?: Readonly<Record<string, unknown>> },
  options?: Pick<SendOptions, "singletonKey" | "singletonSeconds">,
  rootDb?: Kysely<MossDatabase>
): Promise<string | null>;
```

`rootDb` is appended, not inserted — preserves every existing positional call site. Gate: the new
locked path runs only when `rootDb && options?.singletonKey && options?.singletonSeconds` are all
present; otherwise behavior is byte-identical to today (`return boss.send(queue.name, payload,
options);`). This is why `tests/unit/jobs-pg-boss.test.ts` (no `rootDb`, no `singletonSeconds`)
needs zero changes: its call falls straight to the unchanged path.

Locked-path control flow (decision, not a body — exact statements, no surrounding error handling
beyond what already exists in `assertModuleJobPayload`):

```
return rootDb.transaction().execute(async (trx) => {
  await sql`select pg_advisory_xact_lock(hashtextextended(${options.singletonKey}, 0))`.execute(trx);
  const recent = await hasRecentJob(trx, queue.name, options.singletonKey, options.singletonSeconds);
  if (recent) return null;
  return boss.send(queue.name, payload, options);
});
```

Ordering is the whole fix: the advisory lock is held on `trx` for the full duration of the awaited
`boss.send()` call (a separate pg-boss-owned connection, not `trx`'s connection) and is only
released when `trx` commits, which happens after `boss.send()`'s own INSERT has already committed.
A second concurrent caller blocked on the same lock key therefore always sees the first caller's
job row already visible by the time its own `hasRecentJob` check runs — independent of which
`singleton_on` bucket either insert landed in. This sidesteps the actual defect (competing epoch
buckets) rather than trying to force both inserts into the same bucket, matching the spec's locked
fix contract (candidate (a): app-level idempotency ahead of `boss.send`, `pg_advisory_xact_lock`
scoped to the singleton key, no new table).

`assertModuleJobPayload` and `ExternalModuleJobPayload` are untouched — payload shape unchanged.

### 3. `apps/api/src/external-module-jobs.ts` — thread a db handle through

`deps` gains one new **optional** field:

```ts
readonly rootDb?: Kysely<MossDatabase>;
```

Optional (not required) so `tests/unit/external-module-jobs.test.ts`'s existing fake-`boss`,
no-DB unit test needs zero changes — with `deps.rootDb` absent, the call falls to
`sendModuleJob`'s unchanged path, and the route's response/assertions are byte-identical to today.
The manual-run handler's existing `sendModuleJob(...)` call (line ~67-82) gets one added trailing
argument: `deps.rootDb`.

### 4. `apps/api/src/server.ts` — wire the real handle

At the `registerExternalModuleJobRoutes(server, {...})` call (~line 386-393), add:

```ts
rootDb: appDb,
```

`appDb` is already in scope (constructed at line ~197). No other change at this call site.

## New deterministic reproduction test

### Location

Append to `tests/integration/external-modules-routes.test.ts`, as a new, separate `it(...)` inside
the existing `describe("external-module admin routes (#917)", ...)` block, positioned immediately
after the existing "enables the module, then /api/modules includes it with external:true" test (so
the module is already enabled — relies on the same in-file sequential-execution dependency this
file's later tests already rely on).

### Fixture changes (both required, both additive)

1. `beforeAll`'s manifest fixture (`worker.queues`, ~line 53-60) gets a second queue entry:
   ```json
   { "name": "acme-widgets.manual-race", "handler": "manual", "allowManualRun": true }
   ```
   A dedicated queue avoids any dependency on job rows/singleton-key state left behind by the
   existing sequential dedupe test on `acme-widgets.manual` — reusing that queue would make the new
   test's "first call must return a real jobId" assumption depend on how much wall-clock time has
   elapsed since the earlier test ran, which is exactly the kind of timing coupling this test must
   not have.
2. `beforeAll`'s `appDb` construction (line 65) — `maxConnections: 1` → `maxConnections: 2`. At
   `maxConnections: 1`, the fix's two concurrent `rootDb.transaction()` calls would serialize on
   pool-connection acquisition alone, which would mask a broken/no-op advisory lock (the test would
   pass even if the lock were never actually taken, since pool starvation would still force the same
   observable ordering). `maxConnections: 2` lets both transactions hold a connection
   simultaneously, so the advisory lock is the thing actually providing the serialization the test
   observes. No other test in this file constructs its own `appDb`, so this is a one-line,
   file-scoped change with no effect on other tests' behavior.

### Boundary-forcing mechanism

Per the spec's "Boundary-forcing technique" section: wall-clock scheduling alone is explicitly
insufficient; the harness must force the outcome via a controlled DB-side mechanism, not client-side
margin/estimation. Given criterion 1 (real `server.inject`, real pg-boss, no `boss.send` connection
hook — the relay's prior grounding already rejected pg-boss's undocumented `options.db` as
unreachable/unsafe), and given that Postgres fixes `now()` at the point each INSERT's implicit
transaction begins executing (not at lock-acquisition or commit time — this is why a
trigger-holds-a-lock approach was ruled out during design), the only lever available to place each
real insert on a chosen side of the boundary is _when_ each `server.inject()` call is dispatched.
The mechanism below makes that placement DB-anchored rather than client-clock-estimated: every
timing decision reads Postgres's own `now()` directly, never `Date.now()`, eliminating client/DB
clock skew as a variance source and gating dispatch on an _observed_ condition rather than an
_estimated_ delay.

Three helpers, added directly in the new test file (test-only, no production code):

```ts
async function readDbEpoch(client: Client): Promise<number>;
// SELECT extract(epoch from now())::float8 AS now_epoch  -- returns now_epoch

async function waitForBoundaryApproach(
  client: Client,
  singletonSeconds: number,
  leadMs: number,
  minMarginMs: number
): Promise<{ boundaryEpoch: number; bucketStart: number }>;
// Polls readDbEpoch every ~20ms. bucketStart = floor(now_epoch / singletonSeconds) * singletonSeconds;
// boundaryEpoch = bucketStart + singletonSeconds. Exits when
// minMarginMs <= (boundaryEpoch - now_epoch) * 1000 <= leadMs. Bounded to at most one
// singletonSeconds period (no timeout param needed — worst case ~ singletonSeconds).

async function waitForDbEpochAtLeast(
  client: Client,
  targetEpoch: number,
  timeoutMs: number
): Promise<number>;
// Polls readDbEpoch every ~15ms until now_epoch >= targetEpoch; returns the observed now_epoch.
// Throws if timeoutMs (safety net, e.g. 8000) elapses first -- should never trip given
// singletonSeconds=5 and a sub-second polling interval.
```

Test sequence (both `server.inject` calls dispatched without awaiting between them, so both are
genuinely in-flight concurrently — matching criterion 2's "same logical run a double-clicking user
produces" — while their relative DB-insert timing is forced by the polling gate in between):

```ts
const client = new Client({ connectionString: connectionStrings.bootstrap });
await client.connect();
const { boundaryEpoch, bucketStart } = await waitForBoundaryApproach(client, 5, 500, 150);
const first = server.inject({
  method: "POST",
  url: ".../acme-widgets.manual-race/run",
  headers: { cookie: adminCookie },
  payload: { jobKind: "manual" }
});
const crossedEpoch = await waitForDbEpochAtLeast(client, boundaryEpoch, 8000);
const second = server.inject({
  method: "POST",
  url: ".../acme-widgets.manual-race/run",
  headers: { cookie: adminCookie },
  payload: { jobKind: "manual" }
});
const [firstRes, secondRes] = await Promise.all([first, second]);
```

`leadMs=500, minMarginMs=150` gives request A a 150-500ms cushion before the boundary — wide enough
to absorb ordinary Node event-loop/GC jitter for an in-process `server.inject()` call (typically
low-single-digit ms), while keeping the total A-to-B gap sub-second, i.e. in real double-click
territory.

**Named residual risk (for Coordinator review, not silently accepted):** this mechanism does not
hold a DB lock across the boundary — it cannot, since `now()` is fixed at each INSERT's transaction
start, before any lock-wait could occur, which is exactly why a lock/trigger-based hold was ruled
out earlier. It instead grounds every timing decision in the database's own clock via direct
polling. The spec explicitly rules out client-side margin/estimation as insufficient and requires
"something at the DB layer must make the final placement certain, not probable"; this design reads
the DB layer's own clock at each decision point rather than estimating it, which is qualitatively
different from the `Date.now()`-margin approach the spec calls out by name, but it retains a
bounded (not literally zero) residual scheduling-jitter window between "DB confirms margin" and
"the INSERT statement actually begins." Flagging this explicitly per the spec's own instruction
("if no such controlled mechanism proves reachable ... stop and escalate") — this is the strongest
mechanism reachable given criterion 1's constraints; escalating it in the plan-approval message
rather than silently deciding it clears the bar.

### Self-check assertion (defense in depth, not a substitute for the primary assertions)

Independent of pre/post-fix behavior, assert the harness itself achieved a genuine straddle:

```ts
expect(crossedEpoch).toBeGreaterThanOrEqual(boundaryEpoch);
expect(Math.floor(crossedEpoch / 5)).toBeGreaterThan(Math.floor(bucketStart / 5));
```

This is a hard assertion (fails the test outright), not a conditional skip — it does not fall into
the spec's "not an acceptable substitute" pattern (asserting after the fact and quietly passing if
the straddle didn't happen); it fails loudly alongside the primary assertions below.

### Primary assertions (post-fix green state; this is what the test file carries)

```ts
expect(firstRes.statusCode).toBe(202);
expect(firstRes.json()).toEqual({ jobId: expect.any(String) });
expect(secondRes.statusCode).toBe(202);
expect(secondRes.json()).toEqual({ jobId: null });

const rows = await client.query(
  `select count(*)::int as n from pgboss.job where name = $1 and data->>'actorUserId' = $2`,
  ["acme-widgets.manual-race", adminUserId]
);
expect(rows.rows[0].n).toBe(1);
await client.end();
```

Why this fails pre-fix (red, by construction — not "usually"): pre-fix, `sendModuleJob` has no
`rootDb` param wired through this route at all, so both concurrent inserts hit `boss.send()`
directly with no lock/check ahead of it; the harness's DB-anchored polling guarantees their
`now()`s land in different `singleton_on` buckets, so pg-boss's own per-bucket uniqueness (`job_i4`)
does not collide and both inserts succeed — `secondRes.json()` is `{ jobId: expect.any(String) }`
(distinct from `first`'s), and the row count is `2`, not `1`. Both failures are structural
consequences of the missing lock, not timing luck.

Also requires: `migrationBoss.createQueue("acme-widgets.manual-race")` inline in the new test
(mirrors the existing pattern at the "enables the module" test), using the same
`createPgBossClient(connectionStrings.migration)` / `.start()` / `.stop({graceful:false})` sequence
already in this file.

## No changes needed

- `tests/unit/jobs-pg-boss.test.ts` — falls to the unchanged `boss.send()` path (no `rootDb`, no
  `singletonSeconds`). Zero changes.
- `tests/unit/external-module-jobs.test.ts` — `deps.rootDb` absent, falls to the unchanged path.
  Zero changes.
- `tests/integration/external-modules-routes.test.ts:110-181` (existing sequential dedupe test) —
  unaffected; still exercises `acme-widgets.manual`, now via the new locked path (real `rootDb` is
  wired in production/this test's server since `appDb` is always passed at the `server.ts` call
  site) but its assertions (202/`{jobId:string}` then 202/`{jobId:null}`) are unchanged by the fix,
  since sequential calls already trivially serialize.
- `tests/integration/job-search-worker-surface.test.ts` Test 6 — separate module/harness, untouched
  by this diff.
- `ExternalModuleJobPayload`, `assertModuleJobPayload`, singleton key composition, 202/`{jobId}`
  UX contract — all unchanged (spec's "must preserve exactly" list).

## Determinism boundary

Not applicable — this PR has no user-facing surface, no model-authored output, no chat/UI turn.
Pure backend control-flow around an existing enqueue path.

## Kill gate

After the red test is committed and confirmed failing for the stated reason (both calls return a
distinct non-null `jobId`, 2 rows), STOP before writing the fix if the red run does _not_ fail that
way (e.g. if it fails on setup/fixture issues, or the harness's own self-check assertion fails) —
that means the boundary-forcing mechanism itself is broken, not that the race is unreproducible;
escalate to the Coordinator rather than adjusting margins or looping.

Owner of the kill-gate call: this build agent, escalating to the Coordinator before any margin
adjustment or fallback design.

## Verification commands

```bash
pnpm exec tsc --noEmit -p packages/jobs/tsconfig.json > /tmp/1547-tsc-jobs.log 2>&1; echo "EXIT=$?"
pnpm exec tsc --noEmit -p apps/api/tsconfig.json > /tmp/1547-tsc-api.log 2>&1; echo "EXIT=$?"
# expected EXIT=0 for both

# Red run — before the fix (task 2 committed, before task 3):
pnpm vitest run tests/integration/external-modules-routes.test.ts > /tmp/1547-red.log 2>&1; echo "EXIT=$?"
# expected EXIT=1, failure on the two `expect(secondRes...)`/row-count assertions specifically

# Green run — after the fix:
pnpm vitest run tests/integration/external-modules-routes.test.ts > /tmp/1547-green.log 2>&1; echo "EXIT=$?"
pnpm vitest run tests/unit/jobs-pg-boss.test.ts tests/unit/external-module-jobs.test.ts > /tmp/1547-unit.log 2>&1; echo "EXIT=$?"
pnpm vitest run tests/integration/job-search-worker-surface.test.ts > /tmp/1547-jsws.log 2>&1; echo "EXIT=$?"
# expected EXIT=0 for all three

# Full gate at wrap-up: per the verify-gate skill (never run pnpm verify:foundation directly).
```

## Task breakdown (TDD order)

1. Red: add the new `it(...)` + fixture changes to `external-modules-routes.test.ts` (no production
   code changes yet). Run it, confirm it fails for the stated reason. Commit.
2. Add `hasRecentJob` to `packages/jobs/src/pg-boss.ts`. Commit (no caller yet — or combine with
   task 3 if TDD granularity favors one commit; default to separate, `hasRecentJob` is independently
   testable if a fast unit test is added — optional, not required by the spec).
3. Add the `rootDb` param + locked path to `sendModuleJob` (`packages/jobs/src/module-jobs.ts`).
   Commit.
4. Thread `rootDb` through `registerExternalModuleJobRoutes` deps and the `server.ts` call site.
   Run the full verification list above. Confirm the new test goes green and the two existing
   sequential-dedupe precedents stay green. Commit.
5. `pnpm format:check && pnpm lint && pnpm typecheck`, rebase on `origin/main`, then
   `coordinated-wrap-up` (gate-DB run via `verify-gate` skill, push, PR with explicit "no live-path
   UAT required — backend-only" statement, both red and green run logs referenced in the PR body).

## Rulings ledger

- `rootDb` is **optional**, appended as a trailing param/field (not inserted positionally, not
  required) — this is what keeps both existing unit tests at zero changes. Locked this session,
  superseding an earlier draft that considered a required `db` field.
- Reusing the existing `acme-widgets.manual` queue for the new race test was considered and
  rejected — creates timing coupling with the existing sequential dedupe test's leftover job rows
  once the fix's `created_on`-bounded recency check exists. New queue `acme-widgets.manual-race`
  used instead.
- A DB-lock-held-across-the-boundary mechanism (as illustrated in the spec's own example text) was
  considered and rejected as _not actually achieving_ boundary placement, independent of
  feasibility: Postgres fixes `now()` at transaction/statement start, before any lock-wait can
  occur, so holding a lock only controls commit/visibility order, not which bucket an insert's
  `now()` lands in. The DB-clock-polling mechanism above was adopted instead, with its residual risk
  named explicitly for Coordinator review rather than silently accepted.
