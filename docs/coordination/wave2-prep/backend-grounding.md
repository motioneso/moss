# Wave 2 backend grounding — #1155 and #1433

Read-only prep completed 2026-08-08. GitHub API is the live source of truth (`motioneso/moss`; the
checkout remote still says `motioneso/Jarv1s`). Code graph project used: `home-ben-Jarv1s`.

## #1155 — proactive-monitoring schedule keys

- **Freshness/status:** open, label `bug`, updated 2026-07-18. No closing PR or fix found on `main`;
  the bad key is still present.
- **Root cause:** `packages/module-registry/src/index.ts:904-928`,
  `buildReconcileProactiveSchedule`, constructs `${actorUserId}:${source}` and passes it as
  `boss.schedule(..., { key })` and `boss.unschedule`. The repository pins pg-boss `12.18.2`, whose
  `assertKey` allows only `[\\w.\\-/]`; `:` throws `AssertionError` before a schedule row is written.
  This is the same failure fixed in commit `1c2477cb` for the external-module reconciler.
- **Impact/callers:** `registerBuiltInApiRoutes` wires this function when `deps.boss` exists
  (`index.ts:1117`), then settings PATCH `/api/me/proactive-monitoring-settings` calls it through
  `packages/settings/src/proactive-monitoring-routes.ts:75-84`. The safe wrapper catches the failure,
  so the preference write can return success while scheduled checks are absent. It affects every
  enabled built-in proactive provider (`tasks`, `calendar`, `email`, `notes`) and the shared
  `proactive-scan-source` worker; manual refresh is a separate enqueue path and is unaffected.
- **Smallest fix:** change the separator to `/` (`${actorUserId}/${source}`). No key parser or
  cleanup path consumes these proactive keys; sources are a fixed enum, and no valid pg-boss v12
  colon key can have been created. Keep the payload and cron unchanged.
- **Test seam:** add one real-pg-boss schedule assertion beside the existing settings integration
  patterns (new focused `tests/integration/proactive-monitoring-schedule.test.ts`, or the existing
  proactive integration file if setup is reused): PATCH enabled settings, query `pgboss.schedule`,
  assert one key matches `${actorUserId}/${source}` and no `:`. A fake boss alone is insufficient
  because it bypasses `assertKey` (the documented reason this escaped).
- **Risk/tier:** medium implementation risk, high reliability impact for the proactive feature;
  no schema/RLS/security change. No UAT/live-path proof is needed (backend scheduling/test-only
  behavior), but the focused integration test must use pg-boss 12.

## #1433 — silent dataset fetch failures

- **Freshness/status:** open, labels `bug`, `sev:major`, updated 2026-08-05 after the sports outage.
  No closing PR or superseding fix found.
- **Root cause:** `packages/datasets/src/client.ts:113-175`, shared `getDataset` catch logs only
  `HostPinningViolationError`; ordinary HTTP failures, timeouts, DNS/TLS and parse errors are
  swallowed into stale cache or the authored fallback with `degraded: true`. Production wiring of
  a real logger in `packages/module-registry/src/index.ts` is already present; the missing call is
  the bug, not composition.
- **Impact/callers:** every dataset SDK consumer routes through this catch, currently sports ESPN
  and news RSS (plus future modules). Sports services thread `degraded`; news does not currently
  consume it. API routes can remain HTTP 200 with empty/fallback data and no signal.
- **Smallest fix:** in the same catch, add one sanitized `logger.warn` for non-pinning errors with
  `sourceId`, `datasetKey`, error class/name, optional numeric status, and a static message. Include
  a safe outcome field (`stale-cache` vs `fallback`) if desired. Do not log `error.message`, body,
  URL, headers, credentials, or a new metric/health subsystem; preserve existing return semantics.
- **Test seam:** update the existing ordinary-error case in `tests/unit/dataset-client.test.ts`
  (currently asserts `warnings` length 0) to assert one warning with source/dataset and no sensitive
  fields; retain the host-pinning regression. One focused unit test covers all SDK consumers.
- **Risk/tier:** medium implementation risk, high operational/observability severity; no data,
  response-shape, RLS, or user-visible behavior change. Unit test + normal CI is sufficient; live
  UAT is not required, though a controlled log check can verify the production logger receives it.

## Wave 1 collision check

The active local branches are disjoint from both proposed seams:

| Issue | Active branch/PR state | Changed area | Collision |
|---|---|---|---|
| #887 | `fix-887-quiet-hours-flake`, PR #1471 open | notifications integration test/docs | none |
| #1448 | `fix-1448-news-vitest-alias`, local only | `vitest.config.ts`, news/page-context tests | none |
| #1412 | `fix-1412-masthead-space`, local only | `packages/ui`, masthead tests/spec | none |
| #903 | `fix-903-sports-tiebreak`, local only | `packages/sports`, sports tests | none |
| #1272 | `test-1272-structured-state-migrations`, local only | structured-state migration test/docs | none |

#1155 and #1433 also do not overlap each other (`packages/module-registry/src/index.ts` versus
`packages/datasets/src/client.ts` and its unit test). The shared checkout has unrelated pre-existing
changes in `docs/coordination/2026-08-08-non-feature-wave-1.md` and `.claude/launch.json`; neither
should be touched.

## Recommendation

Both issues are genuinely actionable Wave 2 backend fixes. Take #1155 first if scheduling reliability
is the priority (one-character production fix plus a real pg-boss regression test); take #1433 first
if outage detection is the priority (one catch-block log plus one existing unit assertion). Keep
#1433 limited to sanitized warn logging; counters/health signals are a separate follow-up.
