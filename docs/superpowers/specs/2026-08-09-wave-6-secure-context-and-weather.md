# Wave 6 — Secure context, and the weather that has never rendered

**Date:** 2026-08-09
**Status:** Approved by Ben on 2026-08-09 (#1402 detection order settled — see "Design forks —
settled"). Lane C is a **two-stage lane**; see Dependency and merge order.
**Tracking epic:** #1470 (batch "Runtime and data correctness"); #900 and #901 are children of #869
**Issues:** #1403 (lane A) · #900 + #1134 (lane B) · #1402 (lane C) · #901 (decision, see below)
**Grounded on:** `origin/main` = `c8946358f`

## Context

This is the one wave in the current set that ships **user-visible capability that has never worked
for anyone**, rather than correcting something already shipped.

Three shipped features are silently unavailable to every user who is not sitting at the host
machine, all for the same reason — browsers gate them behind a secure context and instances are
reached over plain HTTP on a LAN address:

- voice input (`apps/web/src/chat/composer.tsx` → `navigator.mediaDevices` is `undefined`),
- the PWA service worker (`apps/web/src/pwa/register-service-worker.ts` cannot register),
- accurate weather location (`navigator.geolocation` is secure-context only).

And weather itself is fully built — service, Open-Meteo client, route, header component, an AI tool
for setting location — and `HeaderWeather` has returned `null` on every request this instance has
ever served. `WeatherService.resolveLocation` (`packages/weather/src/weather-service.ts:54-73`) has
exactly two sources and both are dead on a self-hosted LAN instance: no UI calls
`GET`/`PUT /api/me/weather-location` (`packages/settings/src/weather-location-routes.ts:27,43`), and
`geocodeIp` (`packages/weather/src/ip-geocoder.ts:20-28`) returns `null` for every private address.
The chain has no logging at any step.

## Goals

- **#1403** — serve the dev instance and prod over tailnet HTTPS, restoring secure-context features
  at once, with sign-in still working.
- **#900** — a mic failure tells the user which failure it was: insecure origin, permission denied,
  or no microphone.
- **#1134** — the composer stops leaking live mic tracks when the drawer closes mid-recording.
- **#1402** — weather renders for a normal user: a settings surface to set location, **and**
  automatic detection that works on a private network (Ben's ruling: the setting is an override, not
  the only path).

## Non-goals

- No new weather provider, forecast surface, or weather module redesign — the module is built.
- No PWA work beyond what secure context unblocks; install-to-home-screen behaviour is not verified
  by this wave.
- No voice/STT feature work. #900 is an error-classification fix, not a voice change.
- No public-internet exposure, no ACME, no domain purchase.
- **No new outbound geocoding egress for detection.** The settled #1402 design uses the browser's own
  timezone and, later, `navigator.geolocation`; `geocodeIp` is neither extended nor replaced by a
  third-party IP-lookup service.
- **Prod is off-limits to the fleet.** Lane A produces the change and the runbook; Ben applies the
  prod half (per the prod-deploy-path rule — Portainer, never CLI `docker compose up` on the prod
  stack).

## Lanes, tiers, and collision map

| Lane | Issues      | Tier          | Owned surface (exclusive)                                                        | Intended seam                                                                                                                                                                                                                                                                                                                                                                             |
| ---- | ----------- | ------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A    | #1403       | **security**  | `infra/`, compose, `apps/api/src/server.ts` trusted-origins config, docs runbook | Add a `tailscale serve` entry mapping an HTTPS port to the app's local HTTP port; add the resulting `https://<machine>.<tailnet>.ts.net[:port]` origin to the auth trusted-origins list.                                                                                                                                                                                                  |
| B    | #900, #1134 | **routine**   | `apps/web/src/chat/composer.tsx`                                                 | Bind the caught error (`catch (err)`), branch on `err.name` / `navigator.mediaDevices === undefined`; stop the `MediaStreamTrack`s on drawer close.                                                                                                                                                                                                                                       |
| C    | #1402       | **sensitive** | `packages/weather`, `packages/settings`, `apps/web/src/settings`                 | **Two stages.** Stage 1 (independent of lane A): a settings surface calling the existing `GET`/`PUT /api/me/weather-location` routes, plus timezone-derived approximation as the automatic fallback, plus logging at each step of `resolveLocation`. Stage 2 (after lane A is live): `navigator.geolocation` as the accurate path, falling back to timezone on denial or insecure origin. |

**Tier rationale:** lane A changes a network-exposed surface **and** the auth trusted-origins list —
both `security` triggers, and getting the origin wrong returns 403 on sign-in. Lane C adds a
user-preference write path and touches outbound geocoding (sync/import-adjacent, cross-module:
`weather` + `settings` + `apps/web`) → `sensitive`. Lane B is isolated UI error text plus a resource
cleanup → `routine`, but the Live-Path Gate still binds it.

Lanes A, B, C touch disjoint surfaces. Lane B shares `apps/web` with Wave 5 lanes A and D but no
files; if Wave 5 is still open, sequence lane B after it.

## The #901 decision (not a lane)

#901 ("self-hosted TLS story so LAN browsers get a secure context") and #1403 solve the same problem
for different audiences. #1403 is one `tailscale serve` entry on a host that **already** terminates
TLS on two unrelated ports — no certificate, DNS, or firewall work. #901 proposes bundling a Caddy
or Traefik TLS proxy so _any_ self-hoster gets a secure context.

**SETTLED (Ben, 2026-08-09):** do #1403 now (it unblocks Ben's own instance today) and keep #901 open
as the **distributable tier**, explicitly not a duplicate. #901 is **not closed and not re-scoped in
its body** — the clarification lives in a comment on the issue, and #901 still needs its own spec
before it can be picked up. Its four open design questions are bundle-by-default vs opt-in, internal
CA vs a real domain, the port model, and the migration path for existing `env.production.local`
deploys. It is the only issue covering users who are not on this tailnet, so closing it as superseded
would lose the distributable story entirely.

## Design forks — settled

**#1402 detection order — SETTLED (Ben, 2026-08-09): timezone approximation is the
always-available floor; `navigator.geolocation` is an upgrade path gated on #1403 landing.**

Stage 1 (ships independently of lane A): the settings surface, plus timezone-derived approximation
as the automatic fallback when no preference is stored. Stage 2 (after lane A is live on the dev
instance): `navigator.geolocation` as the accurate path, falling back to timezone when the browser
denies it or the origin is still insecure. `geocodeIp` (`packages/weather/src/ip-geocoder.ts:20-28`)
stays as-is — it is dead on a LAN by construction and this decision stops depending on it.

_Why this over the alternatives:_ geolocation alone is the most accurate but cannot render anything
until #1403 lands, which would leave weather broken for however long that takes; a prompt-only path
contradicts Ben's ruling that automatic detection must work; a coarse server-side lookup is another
outbound egress for a worse answer than the timezone the browser already reports. Timezone
approximation is city-level at best — say that in the settings copy, and make the manual override
obviously available rather than buried.

**Privacy consequence, resolved by this choice:** timezone is already known to the app and requires
**no new outbound egress and no new permission prompt**, so the "silent detection the user did not
ask for" concern is closed for stage 1. Stage 2's `navigator.geolocation` carries the browser's own
permission prompt, which is the consent surface — lane C adds no second one.

**Deliberately unchanged:** #1403 stays in this wave exactly as specified. #901's disposition is
handled on the issue itself (a clarifying comment recording that it is the distributable-tier
follow-on and not a duplicate); its body and state are untouched, and it stays `needs-spec`.

**Prod rollout of #1403** — the fleet's deliverable stops at "dev instance proven + runbook". Ben
owns prod and applies the prod trusted-origins edit himself, via Portainer.

## Exit criteria

- #1403: voice input works from a **second device** on the tailnet over `https://`; sign-in succeeds
  from that origin (the trusted-origins entry is the failure mode that returns 403); the service
  worker registers; health/readiness endpoints remain reachable; the plain-HTTP `localhost` dev flow
  is unregressed.
- #900: over LAN HTTP the mic error reads "needs a secure connection (HTTPS)", not "denied"; on
  `localhost` recording is unchanged; a unit test covers the branch selection through a pure helper.
  Raw audio and raw error detail never leave the component.
- #1134: a test proves every `MediaStreamTrack` is stopped when the drawer closes mid-recording; live
  proof shows the browser's recording indicator clearing.
- #1402 stage 1: **live proof** — a normal user on a LAN sets a location in settings and the header
  renders a forecast; and, with no stored preference and **no secure context**, timezone
  approximation produces a location and the header renders. A test proves `resolveLocation` falls
  back to timezone when no preference is stored and `geocodeIp` returns `null`. `resolveLocation`
  logs a step name and outcome at each step so a future `null` is diagnosable rather than silent.
  Settings copy states that automatic detection is approximate and the manual override is visible,
  not buried.
- #1402 stage 2: **live proof over HTTPS after lane A is live** — granting the browser's location
  prompt yields a more accurate location than the timezone fallback, and denying it falls back to
  timezone with the header still rendering. Lane C adds no permission prompt of its own.
- No lane crosses another lane's owned files.

## Dependency and merge order

All three lanes build in parallel; merge **B → C(stage 1) → A → C(stage 2)**.

Lane C's stage 1 does not depend on lane A and must not be held for it — that is the point of the
settled decision. Lane A merges after C's stage 1 because it is the only lane that changes how the
instance is reached, so it takes the freshest rebase. Lane C's stage 2 is a **separate PR** opened
only once lane A is live on the dev instance; its live proof is impossible before then. Do not fold
stage 2 into stage 1's PR — it would gate a shippable fix on an infrastructure change.

## Hard invariants honored

- **Secrets never escape.** Lane A adds an origin to a trusted-origins list; no credential, cert
  material, or tailnet key enters the repo, a log, a payload, or a doc. Lane C logs a _step name and
  outcome_ in `resolveLocation`, never a coordinate, IP, or user identifier.
- **Private by default.** A stored weather location is owner-only user preference data on the
  existing `/api/me/weather-location` routes; lane C adds no cross-user read and no new table
  without an RLS classification recorded in the plan.
- **No admin bypass.** Untouched.
- **Metadata-only job payloads.** No lane changes a pg-boss payload.
- **Module isolation.** Lane C's settings UI talks to `packages/settings`' existing declared routes;
  it must not query `weather`'s tables or import its internals.
- **Never edit an applied migration.** If lane C needs storage beyond the existing preference route,
  it is a new migration file at `0185+` in the owning module's `sql/`, never in
  `infra/postgres/migrations/`, plus the `foundation.test.ts` row in the same PR.
- **Provider-agnostic AI.** The existing `weather-location-tool.ts` stays provider-agnostic; lane C
  adds a UI path beside it, it does not replace it.
- **`AccessContext`.** Untouched.

## Process gates

- Approved. #1402's detection order is settled; lane C is a two-stage lane and may be dispatched now
  against stage 1.
- All four issues exist on GitHub. No new `task` issue is required for #1403, #900, #1134, #1402.
  **#901 still needs a spec before it could ever be picked up** — its clarifying comment (recorded
  2026-08-09) fixes its scope as the distributable tier and names the four open design questions.
- **Live-Path Gate binds every lane.** #1402 in particular has never rendered for anyone — a green
  test suite is not evidence that it renders now.
- The `design-system` skill is mandatory before lane C's settings UI work.
