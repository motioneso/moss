# Plan — #1138 outbound HTTP hardening (weather + upgrade-check)

**Issue:** #1138 — batch of 4 confirmed Low findings from `docs/audits/2026-07-17-bug-hunt-sequential.md`
(#12, #13, #17, #18). No feature spec doc; this is a localized bugfix batch, not a new feature —
the issue itself is the spec, already adversarially vetted 2026-07-17.
**Tier:** security (finding #13 is an SSRF-adjacent private-IP guard bug).
**Collision note:** #1571 (not yet queued) will later touch `open-meteo.ts` and `ip-geocoder.ts`.
Land cleanly first — no coordination needed now.

## Seams check (file:line citations, current tree)

- `packages/weather/src/open-meteo.ts:66` — `data = (await response.json())` unguarded, no try/catch.
- `packages/weather/src/ip-geocoder.ts:31-40` — sibling pattern already exists: wraps fetch+json
  parse in `try { ... } catch { return null }`. This is the pattern to mirror in open-meteo.ts,
  except open-meteo's caller (the route) needs a distinguishable error, not a silent `null`
  (its return type is `WeatherTodayDto`, not nullable) — see Task 1.
- `packages/weather/src/ip-geocoder.ts:26` — `cleaned.startsWith("172.")` classifies all of
  `172.0.0.0/8` as private; RFC 1918 private range is only `172.16.0.0/12` (second octet 16-31).
- `packages/jobs/src/upgrade-check.ts:39-44` — `fetch(...)` call, no `signal`.
- `packages/web-research/src/providers.ts:62` — house pattern: `signal: AbortSignal.timeout(8_000)`.
- `packages/jobs/src/upgrade-check.ts:56` — `(await res.json())` unguarded, no try/catch; the
  existing `if (!release.tag_name) throw new Error("Invalid release response...")` path (line 57-59)
  is what a malformed-but-parseable body should still reach — a JSON parse failure should map to
  the same class of error, not an uncaught `SyntaxError`.

No new platform capability assumed — all four are local control-flow changes in existing functions.

## Determinism boundary

N/A — no UI surface, no model involvement. Backend network-call hardening only.

## Task 1 — `open-meteo.ts`: guard `response.json()` (finding #12)

- Add `export class WeatherUnavailableError extends Error {}` (or reuse if one already exists —
  grep first) in `packages/weather/src/open-meteo.ts`.
- Wrap the `await response.json()` call in try/catch; on catch, throw `new WeatherUnavailableError("Open-Meteo returned a non-JSON body")`.
- Function signature unchanged: `fetchOpenMeteoForecast(lat, lon, unit, location, fetchFn): Promise<WeatherTodayDto>`.
- **Test case** (`packages/weather/src/open-meteo.test.ts` or existing test file — grep first):
  mock `fetchFn` to resolve with `{ ok: true, json: () => Promise.reject(new SyntaxError("bad json")) }`;
  assert `fetchOpenMeteoForecast(...)` rejects with `WeatherUnavailableError` (not raw `SyntaxError`).
  Fails today because the raw `SyntaxError` propagates uncaught.
- Caller (the weather route) must catch `WeatherUnavailableError` and degrade — grep callers of
  `fetchOpenMeteoForecast` and confirm/add a catch that returns a degraded response instead of 500.

## Task 2 — `ip-geocoder.ts`: fix private-IP range (finding #13, SECURITY)

- Replace `cleaned.startsWith("172.")` with a correct RFC 1918 check on the second octet:
  parse `cleaned` as IPv4, extract octet 2, private iff `16 <= octet2 <= 31`.
- Add `169.254.0.0/16` (link-local) and `100.64.0.0/10` (CGNAT) to the guard per the issue's
  optional suggestion — these are also non-routable ranges an SSRF-style guard should exclude.
- Keep existing `::1`, `127.0.0.1`, `10.`, `192.168.` checks as-is.
- **Test cases** (`packages/weather/src/ip-geocoder.test.ts` — grep for existing test file first):
  - `172.20.1.1` (private, octet2=20) → blocked (returns `null` without calling `fetchFn`). Fails
    today only by accident (170.x IS blocked today too, so pick `172.32.1.1` for the regression
    case below).
  - `172.32.1.1` (public, octet2=32) → NOT blocked, `fetchFn` is called. **This is the regression
    test** — fails today because `startsWith("172.")` wrongly blocks it.
  - `172.16.0.1` and `172.31.255.255` (boundary octets 16 and 31) → blocked.
  - `172.15.255.255` and `172.32.0.0` (just outside the range) → NOT blocked.
  - `169.254.1.1` → blocked (new).
  - `100.64.0.1` → blocked (new).

## Task 3 — `upgrade-check.ts`: add fetch timeout (finding #17)

- Add `signal: AbortSignal.timeout(10_000)` to the `fetch("https://api.github.com/repos/...")` call
  at line 39, inside the existing `headers` object's sibling position (options object).
- **Test case** (`packages/jobs/src/upgrade-check.test.ts` — grep for existing test file first):
  assert the `fetch` mock is called with an options object whose `signal` is an `AbortSignal`
  instance. Fails today — no `signal` key exists.

## Task 4 — `upgrade-check.ts`: guard `res.json()` (finding #18)

- Wrap `await res.json()` in try/catch; on catch, throw the same
  `new Error("Invalid release response: unparsable body")` class already used at line 58 (reuse the
  existing explicit-error path, don't introduce a new error type here — job-level `throw` is already
  the established pattern for this function, unlike open-meteo which needs a typed error for its
  caller to catch).
- **Test case**: mock `res.json` to reject with `SyntaxError`; assert `handleUpgradeCheckJob` rejects
  with the "Invalid release response" message, not a raw `SyntaxError`. Fails today.

## Kill gate

None — this is a 4-item localized batch, not a phased rollout. If Task 2's octet-range fix turns up
a broader IP-classification helper already in progress elsewhere (grep for `isPrivateIp` /
`isRfc1918` first), stop and escalate to Coordinator rather than duplicating it — owner: whichever
lane is building that helper.

## Verification

```bash
pnpm --filter @moss/weather test > /tmp/weather-test.log 2>&1; echo "EXIT=$?"
pnpm --filter @moss/jobs test > /tmp/jobs-test.log 2>&1; echo "EXIT=$?"
```
Expected exit code: `0` for both, with the new test cases visible and passing in output.

Pre-push trio (per coordinated-build step 3b):
```bash
pnpm format:check && pnpm lint && pnpm typecheck
```
Expected exit code: `0`.

## Exit criteria

All 4 findings fixed, all new test cases passing, pre-push trio green, PR opened against #1138
with security-tier QA + Ben sign-off requested per handoff doc.
