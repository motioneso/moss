# Plan — deterministic Google schedule-root test (#1453)

**Spec:** `docs/superpowers/specs/2026-08-08-non-feature-wave-2.md` (approved by Ben, 2026-08-08)
**Issue:** Part of #1453
**Risk tier:** routine, test-only
**Scope:** `tests/integration/connectors-google-schedule-root.test.ts` only. No production change.

## Seams check

- `sendJob(boss, queue, payload, options?)` — `packages/jobs/src/pg-boss.ts:137-145` — thin
  wrapper over `boss.send`, returns `Promise<string | null>`; `null` is pg-boss's own signal that
  a duplicate was deduped. Already imported/used this way by the test's sibling suite
  `tests/integration/connectors-sync-wedge.test.ts:10,45-47,61-64` (`sendJob(...)` then
  `expect(dedupedJobId).toBeNull()`), so the exact assertion pattern is precedented in this repo.
- `GOOGLE_SYNC_QUEUE` has `policy: "exclusive"` — `packages/connectors/src/sync-jobs.ts:44-52`.
  Exclusive policy is what makes a second `send()`/`schedule()` call with a `singletonKey` matching
  an already created/active job for that queue return `null` instead of creating a row.
- Production code sets `singletonKey: actorUserId` on the per-actor schedule —
  `packages/connectors/src/google-schedule.ts:28-32` — and on the sweep's direct enqueue —
  `packages/connectors/src/google-sync-sweep.ts:98`. The test's duplicate-send call reuses
  `ids.userA` as the singleton key, matching what real schedule fires and sweep enqueues use.
- Current test's worker registration — `tests/integration/connectors-google-schedule-root.test.ts:108-110`
  — pushes each received job to `roots` and returns immediately, so the job transitions out of
  `created`/`active` within one poll tick. To land a duplicate-send attempt inside that window
  deterministically (not racily), the handler needs to hold the job open via an explicit gate the
  test controls, rather than relying on timing.
- `waitFor` helper (`tests/integration/connectors-google-schedule-root.test.ts:96-104`) is a
  bounded poll with a 5s deadline — legitimate for "wait until an event happened," kept as-is. The
  removed construct is the _fixed_ `setTimeout(1_200)` used to prove a negative
  (`tests/integration/connectors-google-schedule-root.test.ts:133`), which cannot distinguish
  "deduped" from "hasn't fired yet."
- `vitest.config.ts:302-303` sets `hookTimeout`/`testTimeout` to 30_000ms — enough headroom for a
  cron-driven wait (1s cron/poll intervals) plus the deterministic gate, no timeout change needed.

## Change

Single task, one file, one commit.

### Task 1 — replace the sleep-based negative assertion with a held-job dedup proof

File: `tests/integration/connectors-google-schedule-root.test.ts`

1. Add `sendJob` to the existing `@moss/jobs` import (line 11).
2. In the `it(...)` block, keep the schedule-row setup and the
   `expect(beforeDue[0]).toMatchObject(...)` singleton-row assertion (lines 106-126) unchanged.
3. Replace the `boss.work` registration (lines 107-110) with one that gates completion behind a
   test-controlled promise, so the job is provably still `created`/`active` when the test attempts
   the duplicate send:
   - Two deferreds: `jobActive` (resolved by the handler the instant it receives a job) and
     `releaseJob` (the handler `await`s this before returning).
   - Handler body: push the job to `roots`, resolve `jobActive`, then `await` the release gate.
4. After `await makeDue()`, `await jobActive` (replaces the `waitFor(... count === 1)` call —
   still an event-driven wait, not a sleep).
5. While the job is held active, call
   `await sendJob(boss, GOOGLE_SYNC_QUEUE, { actorUserId: ids.userA, kind: "google-sync", idempotencyKey: \`schedule:${ids.userA}\` }, { singletonKey: ids.userA })`and`expect(result).toBeNull()`. This is the direct dedup proof the issue and spec ask for.
6. Resolve the release gate so the held job completes.
7. Keep the final two assertions unchanged: `expect(roots).toHaveLength(1)` and the
   `roots[0]?.data` equality check.
8. Delete the fixed `setTimeout(resolve, 1_200)` line entirely — no replacement sleep.

### Test cases (behaviour + why each would fail against a broken implementation)

- **Schedule-row singleton options unchanged** — already covered by the existing
  `toMatchObject` assertion; unchanged, so no new failure mode introduced.
- **Duplicate send while first job active returns `null`** — new assertion. Fails (returns a
  string job id, not `null`) if the `GOOGLE_SYNC_QUEUE` policy is ever weakened from `exclusive`,
  or if `singletonKey` is dropped from the schedule/sweep enqueue paths, or if the test's own
  duplicate-send call omits `singletonKey`. This is the "still fails if dedup genuinely breaks"
  falsifiability the issue's acceptance criteria require — verified manually during build by
  temporarily deleting `singletonKey: ids.userA` from the test's duplicate `sendJob` call and
  confirming the assertion goes red, then restoring it.
- **Exactly one root observed** — unchanged assertion, now event-driven end to end (no wall-clock
  wait anywhere in the test).

## Kill gate

None needed beyond the existing gate — single-file, test-only, routine tier, no production code
touched, no new dependency. If the deterministic gate pattern itself proves unreliable (e.g. the
handler's `jobActive` promise never resolves because the schedule doesn't fire inside 30s), that is
a build-time signal to fall back and escalate to the coordinator, not a design fork to plan around.

## Verification

```bash
pnpm --filter @moss/connectors exec vitest run tests/integration/connectors-google-schedule-root.test.ts > /tmp/1453-single.log 2>&1; echo "EXIT=$?"
```

Actually run from repo root against the workspace test runner — exact invocation confirmed at
build time from `package.json` scripts; expected exit code `0`.

```bash
pnpm vitest run --repeat=5 tests/integration/connectors-google-schedule-root.test.ts > /tmp/1453-repeat.log 2>&1; echo "EXIT=$?"
```

Expected exit code `0` on every repeat — satisfies the issue's "repeated run passes consistently"
acceptance criterion.

Full isolated gate via `coordinated-wrap-up` (fresh gate DB) before PR, per handoff.

## Non-goals (per spec)

No change to production singleton/dedup behavior, no generic schedule-key helper, no absorption of
#1454.
