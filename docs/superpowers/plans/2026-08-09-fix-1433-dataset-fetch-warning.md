# Plan — #1433: sanitized warning on dataset fetch degrade

**Spec:** `docs/superpowers/specs/2026-08-08-non-feature-wave-2.md` (row #1433)
**Issue:** #1433 (`bug`, `sev:major`)
**Risk tier:** routine
**Branch:** `fix-1433-dataset-fetch-warning`

## Problem (verified against branch)

`packages/datasets/src/client.ts:160-174` — the `getDataset` catch block only calls
`logger.warn` when `error instanceof HostPinningViolationError`
(`client.ts:161-165`). Every other failure (HTTP non-2xx from the adapter, timeout,
DNS/TLS failure, JSON parse error) falls through to `client.ts:167-173` and returns a
degraded envelope with **no log call at all**. Confirmed still true on current branch
(no changes to `client.ts` or the catch block since the spec was written).

## Seams check (file:line)

- `DatasetLogger` interface — `packages/datasets/src/client.ts:7-9` (`warn(data, message)`,
  already sanitized-only by doc comment at `client.ts:6`). No signature change needed.
- `NOOP_DATASET_LOGGER` default — `client.ts:11-16`. Unaffected.
- `HostPinnedFetchError` — `packages/host-fetch/src/index.ts:16-21`, has `readonly code:
  HostPinnedFetchErrorCode` (`"host_not_declared" | "blocked_address" | "response_too_large" |
  "fetch_timeout" | "invalid_request"`). No message beyond the code; safe to log.
- `HostPinningViolationError extends HostPinnedFetchError` — `host-fetch/src/index.ts:23-35`,
  adds `readonly host: string`. Already logged today (`client.ts:161-165`) — untouched by
  this plan.
- Adapters (`packages/sports/src/source/espn-source.ts:97`,
  `packages/news/src/source/rss-source.ts:229`) throw plain `new Error(...)` with a message
  that embeds an HTTP status but is otherwise adapter-authored free text — **not guaranteed
  sanitized**, so the plan does not log `error.message` for the generic branch. Only
  `error.name` (or `typeof error` for a non-Error throw) and, when the error is a
  `HostPinnedFetchError`, its structured `.code` are logged.
- `hit` at the point of the catch (`client.ts:125` computed before the try, re-read at
  `client.ts:167`) is truthy only for a stale-but-retained `serve-stale-on-error` entry
  (comment at `client.ts:167-170` — degrade-empty entries are already evicted by
  `DatasetCache.get`). This is the existing, correct signal to distinguish "served stale
  cache" from "served empty fallback" — no new state needed.
- Test fixture `fakeLogger()` — `tests/unit/dataset-client.test.ts:11-17` — already captures
  `[data, message]` pairs; reused as-is.

## Non-goals (from spec)

No new dependency, abstraction, counter/health-signal, or logging subsystem. No change to
`degraded`/fallback semantics or the `DatasetEnvelope` shape. No change to the
`HostPinningViolationError` branch's existing behavior or message text.

## Decision — log shape

Single `logger.warn` call per catch (unchanged: still exactly one call), keeping the
existing `HostPinningViolationError` branch verbatim and adding an `else` branch for every
other error:

```
data: {
  sourceId: string       // source.id
  datasetKey: string      // the requested key
  outcome: "stale-cache" | "empty-fallback"   // hit ? "stale-cache" : "empty-fallback"
  errorName: string       // error instanceof Error ? error.name : typeof error
  errorCode?: string      // present only when error instanceof HostPinnedFetchError
}
message: "dataset fetch failed: serving degraded response"   // static, no interpolation
```

No `error.message`, no URL, no headers, no request/response body, no credentials — the
message string is a compile-time literal, not built from the error.

## Test cases (`tests/unit/dataset-client.test.ts`)

Replace the existing test at `dataset-client.test.ts:254-266` ("does not log ordinary
(non-pinning) fetch errors — stays silent-degrade") — that behavior is exactly the bug — with:

1. **"logs a sanitized warning for an ordinary (non-pinning) fetch failure, still returns
   degraded"** — adapter throws `new Error("upstream down")`, `staleness: "degrade-empty"`
   (no cache to serve). Assert `warnings` has length 1, `warnings[0][0]` matches
   `{ sourceId: "fixture", datasetKey: "widgets", outcome: "empty-fallback", errorName:
   "Error" }`, and the envelope is unchanged (`{ data: { empty: true }, degraded: true }`).
   Fails against current code: `warnings` is empty.

2. **"captures the HostPinnedFetchError code for a non-pinning host-fetch failure"** —
   adapter throws `new HostPinnedFetchError("fetch_timeout")` (imported from
   `@moss/host-fetch`, re-exported via `packages/host-fetch/src/index.ts:419` and
   `datasets/src/host-pinning.ts:1`). Assert `warnings[0][0].errorCode === "fetch_timeout"`
   and `errorName === "HostPinnedFetchError"`. Fails against a naive fix that logs only
   `error.name` without `.code`.

3. **"distinguishes stale-cache from empty-fallback in the outcome field"** — extend the
   existing `serve-stale-on-error` scenario (mirrors `dataset-client.test.ts:128-155`) with a
   `logger`; after the stale-serving fetch, assert `warnings[0][0].outcome === "stale-cache"`.
   Fails against an implementation that hardcodes `outcome: "empty-fallback"`.

4. **"never logs the raw error message, response body, or fallback content"** — reuse test 1's
   setup with a fallback payload containing a recognizable marker string, assert
   `JSON.stringify(warnings[0]).includes("upstream down")` is `false` and does not include the
   fallback marker. This is the explicit log-safety proof required by the spec's exit
   criteria. Fails against a naive fix that spreads `error.message` or the fallback into the
   log payload.

Existing test `dataset-client.test.ts:232-252` (pinning violation) is unchanged and must still
pass unmodified — proves the pinning branch's behavior and log shape are untouched.

## Verification

```bash
pnpm --filter @moss/datasets exec vitest run ../../tests/unit/dataset-client.test.ts > /tmp/1433-unit.log 2>&1; echo "EXIT=$?"
```
Expected: `EXIT=0`, all cases in `tests/unit/dataset-client.test.ts` pass including the four
new/modified cases above.

Full gate (isolated DB, via `verify-gate` skill) at wrap-up:
```bash
pnpm verify:foundation > /tmp/1433-gate.log 2>&1; echo "EXIT=$?"
```
Expected: `EXIT=0`.

## Kill gate

Single-phase build (one file + one test file, ~20 lines). If the four new test cases cannot
be written to fail against current `main` and pass against the fix (i.e., the regression
doesn't actually discriminate), stop and escalate to `Coordinator` rather than force a green
test — owner: this build agent.

## Log-safety review (spec-required, against "secrets never escape")

- No field in the new log payload is sourced from `error.message`, request/response
  headers, URLs, or credentials — verified by test case 4 above.
- `errorCode` is a closed enum (`HostPinnedFetchErrorCode`), not free text.
- `errorName` is `Error#name` (a class name, e.g. `"Error"`, `"HostPinnedFetchError"`,
  `"TypeError"`) or `typeof error` for a non-Error throw (e.g. `"string"`) — bounded,
  developer-authored strings, never adapter/response-derived content.
- `sourceId` / `datasetKey` are manifest-declared identifiers already logged today in the
  pinning-violation branch; no new sensitivity introduced.
