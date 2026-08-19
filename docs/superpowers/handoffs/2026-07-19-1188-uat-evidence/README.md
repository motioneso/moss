# UX #1188 — Connector Onboarding: UAT Evidence

Manual real-dev-instance UAT (per the #1000 UAT harness rule for UI/UX features), run against
live API (`:3902`) + web (`:5179`) dev servers and an isolated dev Postgres database
(`jarv1s_uidemo_1188`, dropped/recreated/migrated clean for this run), on PR #1206
(HEAD `7986454e`). Verified checklist:

- Fresh DB → real owner-bootstrap signup flow completes.
- Provider picker: Google and IMAP cards render with equal visual weight
  (`f822d53d`/`fe2a0c6d`).
- Add-account picker does **not** collapse back into the connected summary (`c2f56e66`).
- Connected-account summary renders after a real seeded account (server-side AES-256-GCM
  encrypted).
- Google card: one-click consent popup opens synchronously (`9d077038`).
- IMAP path: per-provider setup guide link is nested inside the **last** numbered step (`a382c8ac`).

**Seed-account method:** the add-account-picker-not-collapsing bug only reproduces with an
existing connected account, and a real IMAP/Google connect both require a live probe/OAuth
round-trip that fails without real creds in dev. Worked around by seeding one account through the
real authenticated `POST /api/connectors/accounts` endpoint (a genuine app endpoint — server-side
AES-256-GCM encrypts `tokenPayload`, not a DB hack), confirmed via a `201` response, then
reloading and clicking "Connect another account" to prove the picker re-renders instead of
collapsing. Reload resets the onboarding wizard to its earliest not-done step (`cliAuth`/
"Assistant"), not back to the connectors step — the script clicks "Continue" once after reload to
return there; this is existing wizard behavior, not a #1188 regression.

**Google consent popup:** clicking "Open consent screen" (after filling fake `clientId`/
`clientSecret` to pass the button's enable check) opens `about:blank` synchronously, then
navigates to Google's real OAuth error page once `authUrl` resolves
(`accounts.google.com/signin/oauth/error?authError=invalid_client...`) because no real Google
OAuth client exists in this dev environment. Expected and not a #1188 regression — the one-click
trigger itself (no extra intermediate confirm step) is what's under test.

**Console errors:** one console error was observed after navigating to the connectors step —
`[main] Failed to load resource: the server responded with a status of 401 (Unauthorized)` — from
an unauthenticated background poll made before the owner session was fully established. Pre-existing
UI behavior, not related to the #1188 connector-onboarding changes.

**Environment gotcha found and fixed this run (not a #1188 code issue):** the dev API server, as
launched per relay-6's "Start servers" recipe, defaults Better Auth's `trustedOrigins` to
`http://localhost:3000` only (`packages/auth/src/index.ts` `readTrustedOrigins`), which rejected
sign-up with `Invalid origin: http://localhost:3902` on non-default ports. Fixed for this manual
run by relaunching the API with
`JARVIS_AUTH_TRUSTED_ORIGINS="http://localhost:5179,http://localhost:3902" JARVIS_AUTH_BASE_URL="http://localhost:3902"`.
Worth folding into the standard manual-UAT server-start recipe for non-default ports.

Ran via a throwaway local script (`tests/uat-scratch/uat-manual.mjs`, Playwright-driven via
`@playwright/test`'s `chromium` launcher — `chromium-cli` is not installed in this container),
deleted after this evidence was captured — it was never intended to be committed.
