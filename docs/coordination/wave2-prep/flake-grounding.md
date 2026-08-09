# Wave 2 prep — #1453

## Freshness and reproduction

- GitHub: `motioneso/moss#1453`, open `task`, created 2026-08-07; no assignee, no PR, no
  issue comments. The local remote is `motioneso/Jarv1s` but GitHub resolves the renamed repo
  as `motioneso/moss`.
- GitHub Actions run `31140648511`, attempt 1, failed job `Verify foundation and app` at
  `tests/integration/connectors-google-schedule-root.test.ts:135`: `roots` was length 2, expected
  1. Attempt 2 of the same run passed. The reported tree was identical between the PR and merge
  run, so this is a live timing flake, not a code-regression signal.
- Current `main` (`00ec6d5f5`, aligned with `origin/main`) still has:
  `waitFor(roots.length === 1)` followed by `setTimeout(resolve, 1_200)` and
  `expect(roots).toHaveLength(1)`.

## Grounded seam

- Test: `tests/integration/connectors-google-schedule-root.test.ts`.
- Production seam: `packages/connectors/src/google-schedule.ts`,
  `reconcileGoogleAccountSchedule`, schedules `connectors.google-sync` with
  `singletonKey: actorUserId`; that queue is `policy: "exclusive"` in
  `packages/connectors/src/sync-jobs.ts`.
- pg-boss v12's scheduler turns a due schedule into a send-it job and then sends the target
  payload. A fixed sleep proves only that no second tick arrived during 1.2 s; it does not prove
  the singleton prevented a duplicate.

## Smallest deterministic test fix

Keep the existing schedule-row assertions and positive `waitFor` for the first due root. Remove
the fixed 1.2 s sleep. Make the test worker hold the first root active behind a deferred release,
then call `boss.send(GOOGLE_SYNC_QUEUE, beforeDue[0].data, { singletonKey:
beforeDue[0].options.singletonKey })` while that first job is active and assert the returned job id
is `null`; release the first job in `finally`, then assert one root and its payload. This drives
the dedup seam directly, without waiting for a second cron boundary, and fails if the production
schedule drops `singletonKey` (the duplicate send would enqueue instead of returning `null`).
No production code change is indicated.

## Verification / risk

- Risk tier: routine test-only, with medium CI impact because this integration failure skips image
  publish and can leave prod on an old image. No user-facing/UAT proof is needed.
- Builder should run the isolated targeted integration file repeatedly (including the issue's
  repeat requirement), plus normal diff-scoped lint/format/type checks. This prep deliberately
  ran no DB-touching test or gate.

## Collision and dependency map

- Wave 1 lanes #1448, #887, #1412, #903, and #1272 touch disjoint intended files; no merge
  collision found. They share the same `main` base and require the coordinator's normal rebase
  and diff-scoped QA sequencing.
- No open branch/PR is assigned to #1453. #1454 (image-publish alarm) is operationally related
  but has no file dependency. #1428 (Google-sync split) and #1155 (pg-boss schedule-key bug)
  are related history/open backlog only, with no active branch collision identified.

## Recommendation

Accept as a Wave 2 routine lane: one integration-test file, deterministic singleton assertion,
no production change; retain the schedule-row `singletonKey` assertion as defense in depth.
