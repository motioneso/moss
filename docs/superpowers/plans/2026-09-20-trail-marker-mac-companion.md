# Trail Marker: Mac companion connection foundation — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A native Mac menu-bar app links to one Moss account through browser approval, holds a restricted companion credential, shows an honest connection state, and appears as a revocable "Mac companion" row in Moss's Active sessions.

**Architecture:** A bounded, browser-approved pairing exchange lives in `@moss/auth` and mints an opaque companion credential that only `/api/companion/*` routes accept. The settings session service lists and revokes companion rows alongside browser sessions. The Mac app is SwiftUI/AppKit with a testable connection state machine, Keychain storage and a URLSession transport, updated by Sparkle 2 from a fixed official feed.

**Tech Stack:** Fastify + shared TypeScript contracts, Postgres migration under `infra/postgres/migrations`, `@moss/ui` + `jds-*` for web surfaces, Swift 5.10 / SwiftUI / AppKit (macOS 14+), XcodeGen, Sparkle 2, GitHub Actions `macos-14` runner.

**Spec:** `docs/superpowers/specs/2026-09-20-trail-marker-mac-companion.md` (sections cited as §N). Design authority: `docs/specs/Trail Marker/trail-marker-design-guide/DESIGN_GUIDE.md`.

**Tracking:** #2560. Plain-English rule for every status update and every spawn prompt: name things by what they do, one backtick per sentence at most, no coined shorthand. See `~/.claude/CLAUDE.md`.

## Global constraints

- macOS 14+, Apple silicon and Intel, one universal download (§1).
- Product names: app is **Trail Marker**, descriptor **A Moss companion**; Moss displays **Trail Marker for Mac** (§1). Status text says **Last successful contact**, never "Last synced" (§2).
- Companion credential is never a browser/CLI session and is rejected everywhere except `/api/companion/*` (§9.8).
- Credential is minted only at redemption by the initiating app; cancel, deny and expiry can never leave a usable credential (§3.5, §9.4).
- Manual Disconnect is persisted before any cancellation and is never re-enabled by restart, wake, update, network recovery or permission grant (§4).
- No screenshots, Accessibility reads, activity classification or model calls in this release (§1, §11).
- No new required env var or hand-edited settings file (`feedback-no-new-required-env-vars`). Everything new has a default.
- Never edit an applied migration; auth SQL goes in `infra/postgres/migrations/` (auth is platform, not a module). Take the next free number at build time; 0237 is the highest as of 2026-09-20 and five branches once collided on one number.
- Every new API route is added to `PLATFORM_UNGUARDED_ROUTES` in `packages/module-registry/src/route-guard.ts`, otherwise the server refuses to boot (`route-must-be-declared-in-a-manifest`).
- Security tests are observed failing with the protection removed, and the PR records that (CLAUDE.md, "Claims About Security Properties").
- Database-touching tests run only through the `verify-gate` skill.
- App map, deployment config and release note ship in the same PR as the feature (CLAUDE.md process gates).
- Web surfaces use `@moss/ui` and `jds-*` only; the native palette never enters Moss CSS (§2).

---

## Part 1. Decisions the spec left open

### 1.1 Pairing exchange: custom bounded flow, not Better Auth's device-authorization plugin

Better Auth 1.6 ships a device-authorization plugin (RFC 8628). Its `/device/token` response is a **Better Auth session token** — the documented client example passes it straight to `getSession` as a Bearer. That is exactly the broad credential §9 forbids ("a companion token must not become a general browser/CLI session"). Wrapping it to strip scope would mean fighting the library on every call. So the exchange is a small custom flow in `@moss/auth`, modelled on RFC 8628 plus a PKCE-style proof of possession.

Actors: **App** (Trail Marker), **Browser** (user's signed-in Moss session), **Server** (Moss instance).

```
App     POST /api/companion/protocol            -> { companionProtocol: 1 }        (no auth)
App     POST /api/companion/pair                -> { attemptId, approvalPath,      (no auth, IP rate-limited)
          { deviceName, platform, appVersion,        pollIntervalSeconds, expiresAt }
            osVersion, verifierHash }
App     opens  <instance>/link/trail-marker#code=<approvalCode>   in default browser
Browser POST  /api/companion/pair/attempt       -> { deviceName, status }          (cookie session, same-origin)
          { code }
Browser POST  /api/companion/pair/decide        -> { status }                      (cookie session, same-origin)
          { code, decision: "approve" | "deny" }
App     POST /api/companion/pair/redeem         -> 200 { credential, device, account, expiresAt }
          { attemptId, verifier }                  202 { status: "pending" }
                                                   403 { status: "denied" } | 410 { status: "expired" }
                                                   409 { status: "redeemed" } | 404 { status: "unknown" }
App     POST /api/companion/pair/cancel         -> 204                             (deletes the attempt)
          { attemptId, verifier }
```

Secrets and who holds them:

| Value                                             | Held by                                          | Purpose                                                                         |
| ------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------- |
| `verifier` (32 random bytes, base64url)           | App only, in memory for the attempt              | Proof of possession at redeem/cancel. Server stores `sha256(verifier)`.         |
| `attemptId` (uuid)                                | App, server                                      | Public handle for the attempt. Useless without the verifier.                    |
| `approvalCode` (24 random bytes, base64url)       | Browser link fragment, server as `sha256(code)`  | Lets the signed-in browser find and decide the attempt. Cannot redeem anything. |
| `credential` (`tm1_` + 32 random bytes base64url) | App Keychain; server stores `sha256(credential)` | The companion bearer credential. Issued once, at redeem.                        |

Rules enforced server-side:

- An attempt expires 10 minutes after creation. Expired rows are deleted lazily on every `pair` create (`DELETE ... WHERE expires_at < now()`); no scheduler.
- `decide` binds `user_id` to the attempt and moves `pending → approved | denied`. A second `decide` on a non-pending attempt returns 409. The signed-in user is taken from the cookie session, never from the body.
- The approval code never appears in a URL. It travels in the link fragment to the browser, which no browser sends to a server, and in the request body on both browser calls. The same Fastify server serves the approval page and logs every URL it is asked for, so a query parameter would write a live code into ordinary logs.
- `attempt` and `decide` both require a same-origin request: `Origin` header must match a trusted origin from the auth runtime's origin config, and the body must be JSON (Fastify rejects form posts by content type). This is the CSRF protection §9.3 asks for.
- `redeem` succeeds only when `status = 'approved'` AND `verifier_hash = sha256(body.verifier)`, executed as one `UPDATE ... SET status='redeemed' WHERE id=$1 AND status='approved' AND verifier_hash=$2 RETURNING user_id, device_name` so two racing redeems cannot both win. The credential row is inserted in the same transaction.
- A wrong verifier on an approved attempt returns 404 `{ status: "unknown" }`, identical to a nonexistent attempt, so the public id leaks nothing.
- `cancel` with the correct verifier deletes the attempt in any state. If the browser approved after the app cancelled, the attempt is already gone and `decide` returns 404; no credential ever existed (§3.5).
- Rate limits: `pair`, `redeem`, `cancel`, `protocol` keyed by peer IP (pre-auth, same reasoning as `/api/auth/*`); `pair`, `cancel` and `protocol` at 20/min per IP each; `redeem` in its own bucket at 120/min per IP, because polling every 3 s is 20/min per Mac and several Macs share one home address. `attempt`/`decide` inherit the global authenticated limit.

### 1.2 Credential lifetime and renewal

- Opaque bearer, prefix `tm1_` so a future format can be told apart. Server keeps only `sha256(credential)`; the raw value is returned once, in the redeem response body, over TLS.
- **Sliding inactivity expiry of 90 days**, extended on every authenticated companion call, **capped at 365 days from issue**. No refresh token and no renewal endpoint: when the credential expires the app shows Sign-in required and the user relinks through the browser, which issues a new device row. This keeps the server with one credential type and one revocation path.
- Revocation is a `DELETE` of the device row. The next authenticated call from that Mac gets 401 `{ code: "companion_credential_invalid" }` (§4 "takes effect on the next authenticated request").
- Account status is checked on every companion call exactly as `resolveRequestAccessContext` does (`app.get_user_by_id`): `pending` → 403 `account_pending_approval`, `deactivated` → 403 `account_deactivated`. Account deletion removes device rows through `user_id ... ON DELETE CASCADE`.

### 1.3 Authenticated companion endpoints and their boundary

`resolveCompanionContext(request)` is a **separate resolver** from `resolveAccessContext`. It reads `Authorization: Bearer tm1_...`, hashes it, looks the hash up in `app.companion_devices`, applies expiry and account-status checks, bumps `last_contact_at`/`expires_at`, and returns `{ actorUserId, deviceId, requestId }`. It never consults cookies, so a signed-in browser cannot call these routes, and it is never wired into any route outside `/api/companion/*`.

The reverse boundary is already true by construction and is proven by a test in Task 6: `resolveRequestAccessContext` takes the Bearer branch for any `Authorization: Bearer` header and hands the token to the legacy UUID resolver, which rejects a non-UUID. A `tm1_` token therefore gets 401 on `/api/me`, `/api/tasks`, `/api/chat/*`, `/api/admin/*` and every other route.

| Route                           | Auth      | Body → Response                                                                                                          |
| ------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------ |
| `POST /api/companion/heartbeat` | companion | `{ appVersion, osVersion }` → `{ device: { id, displayName }, account: { name, email }, serverTime, expiresAt }`         |
| `PATCH /api/companion/device`   | companion | `{ displayName }` → `{ device: { id, displayName } }` (own row only; 1–64 chars, trimmed, control chars rejected)        |
| `POST /api/companion/logout`    | companion | `{}` → 204; deletes own row. Idempotent: an already-revoked credential gets 401, which the app treats as "already gone". |

Heartbeat cadence (§9): every 60 s while enabled; on failure, exponential backoff 5 s → 5 min with ±20 % jitter; user-requested Retry Now fires immediately and resets backoff. Heartbeat writes `last_contact_at` only; no activity event.

### 1.4 Migration and authorization boundaries

One migration file, `infra/postgres/migrations/<next>_companion_devices.sql`, owned by the auth boundary like 0045/0046:

```sql
CREATE TABLE app.companion_pair_attempts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_code_hash text NOT NULL UNIQUE,
  verifier_hash    text NOT NULL,
  device_name      text NOT NULL CHECK (char_length(device_name) BETWEEN 1 AND 64),
  platform         text NOT NULL CHECK (platform = 'macos'),
  app_version      text NOT NULL CHECK (char_length(app_version) <= 32),
  os_version       text NOT NULL CHECK (char_length(os_version) <= 32),
  status           text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','approved','denied','redeemed')),
  user_id          uuid REFERENCES app.users(id) ON DELETE CASCADE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  CHECK (status = 'pending' OR user_id IS NOT NULL)
);

CREATE TABLE app.companion_devices (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  credential_hash  text NOT NULL UNIQUE,
  display_name     text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 64),
  platform         text NOT NULL CHECK (platform = 'macos'),
  app_version      text NOT NULL,
  os_version       text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_contact_at  timestamptz,
  expires_at       timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL
);
CREATE INDEX companion_devices_user_id_idx ON app.companion_devices (user_id);

ALTER TABLE app.companion_pair_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.companion_pair_attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE app.companion_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.companion_devices FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON app.companion_pair_attempts TO jarvis_auth_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.companion_devices TO jarvis_auth_runtime;

CREATE POLICY companion_pair_attempts_auth_runtime ON app.companion_pair_attempts
  FOR ALL TO jarvis_auth_runtime USING (true) WITH CHECK (true);
CREATE POLICY companion_devices_auth_runtime ON app.companion_devices
  FOR ALL TO jarvis_auth_runtime USING (true) WITH CHECK (true);
```

Only `jarvis_auth_runtime` (the auth pool) touches these tables, matching `app.auth_sessions`. `jarvis_app_runtime` and worker roles get no grant, so no module and no job can read a credential hash. RLS classification for memory: **owner-only, auth-runtime-only**.

Existing consumers that must include companions (§8, §9):

- `MeSessionsService.list / revokeOne / revokeOthers` in `packages/auth/src/session-service.ts` (Task 7).
- `revokeUserSessions` in `packages/auth/src/index.ts:166` — the admin "revoke sessions" action today deletes only `better_auth_sessions`; it gains a `companion_devices` delete (Task 7).
- Account deletion: covered by the FK cascade; Task 7 adds a test.
- Deactivation: covered by the per-call status check (Task 4).

### 1.5 Updater, feed and signing

- **Sparkle 2** via Swift Package Manager (`https://github.com/sparkle-project/Sparkle`, 2.x). Maintained, EdDSA-signed appcasts, universal binaries, delta updates optional.
- **Feed URL** is fixed in `Info.plist` (`SUFeedURL`) and never derived from the instance: `https://github.com/motioneso/moss/releases/latest/download/trail-marker-appcast.xml`. GitHub serves `/releases/latest/download/<asset>` at a stable address, so no extra hosting. The appcast and the zipped app are assets on a GitHub release tagged `trail-marker-v<semver>`.
- **Signing.** Sparkle's EdDSA public key ships in `Info.plist` (`SUPublicEDKey`); the private key lives only in a GitHub Actions secret and is used by `generate_appcast`. Developer ID signing + notarization + stapling run in the same release workflow once Apple membership exists. Until then the workflow builds, tests and produces an unsigned archive for local install only, and never publishes a release.
- **Development builds** are marked by the build setting `TRAIL_MARKER_DISTRIBUTION=0`; the Updates tab then shows "Development build. Updates come with the public release." and Check Now is disabled. No half-working update button (§10).
- **Disconnect suspends automatic checks**: `updater.automaticallyChecksForUpdates = autoCheckPreference && connectionEnabled`; Check Now stays available as an explicit user action (§4).
- Compatibility gate: appcast items carry `sparkle:minimumSystemVersion` = 14.0; the app itself refuses instances whose `companionProtocol` is missing or greater than it supports (§10).
- Preferences and Keychain items live outside the bundle, so an update never touches the Disconnect preference (§10). Task 14 proves this on a real update.

### 1.6 Repository layout for the Mac app

`apps/trail-marker/` sits outside the pnpm workspace (confirm the `pnpm-workspace.yaml` globs skip directories without `package.json`; if `apps/*` is listed, pnpm ignores folders with no package file, verify with `pnpm ls -r --depth -1` after adding).

```
apps/trail-marker/
  project.yml                      XcodeGen spec (targets: TrailMarker, TrailMarkerTests)
  README.md                        developer install steps, honest about "unsigned local build"
  TrailMarker/
    App/          TrailMarkerApp.swift, MenuBarController.swift, AppDelegate.swift
    Model/        ConnectionState.swift, ConnectionMachine.swift, LinkAttempt.swift, InstanceURL.swift
    Services/     CompanionClient.swift (transport protocol + URLSession impl), KeychainStore.swift,
                  PreferencesStore.swift, LoginItemService.swift, PermissionsService.swift, UpdaterService.swift
    Views/        Onboarding/, Menu/, Settings/ (Connection, ThisMac, Permissions, Updates)
    Design/       DesignTokens.swift (copied from the guide package), MossMark asset catalog
    Resources/    Info.plist, Assets.xcassets, TrailMarker.entitlements
  TrailMarkerTests/
    InstanceURLTests.swift, ConnectionMachineTests.swift, LinkAttemptTests.swift,
    CompanionClientTests.swift, KeychainStoreTests.swift, DiagnosticsRedactionTests.swift
```

`ConnectionMachine` is a pure value-type reducer: `(state, event) -> (state, [effect])`. Views render state; a small runtime executes effects (start heartbeat timer, cancel, call client, write Keychain). This is what makes §12 "mocked/instrumented transport proves no automatic requests" testable without a network.

### 1.7 Slices

Ben's rule: a slice is one session's work; slices share one worktree and one PR (`feedback-slices-share-worktree-and-pr`). Backend and web ship in one Moss PR; the Mac app ships in a second PR because it has its own CI job and its live proof needs Ben's Mac.

| Slice                                              | Tasks | PR        | Live proof                                                                               |
| -------------------------------------------------- | ----- | --------- | ---------------------------------------------------------------------------------------- |
| A. Server pairing + credential                     | 1–6   | Moss PR 1 | curl-driven pairing against the dev instance, recorded on the PR                         |
| B. Moss web: approval page + Active sessions       | 7–10  | Moss PR 1 | Browser walk-through on dev with a fake companion row inserted via the pairing endpoints |
| C. Mac app core (no UI)                            | 11–12 | Mac PR    | `xcodebuild test` on CI                                                                  |
| D. Mac app UI + permissions + login item + updater | 13–14 | Mac PR    | Installed app on Ben's Mac against dev, evidence on the PR                               |
| E. Release pipeline (deferred gate)                | 15    | later     | Requires Apple membership; not part of "done" for #2560's local milestone                |

---

## Part 2. Tasks

### Task 1: Shared contracts for the companion protocol

**Files:**

- Create: `packages/shared/src/companion-api.ts`
- Modify: `packages/shared/src/index.ts` (export the new file)
- Test: `tests/unit/companion-api-schema.test.ts`

**Interfaces (produces):**

```ts
export const COMPANION_PROTOCOL_VERSION = 1 as const;
export const COMPANION_CREDENTIAL_PREFIX = "tm1_" as const;

export interface CompanionProtocolResponse {
  readonly product: "moss";
  readonly companionProtocol: 1;
}

export interface CreatePairAttemptRequest {
  readonly deviceName: string; // 1–64 chars
  readonly platform: "macos";
  readonly appVersion: string; // ≤ 32
  readonly osVersion: string; // ≤ 32
  readonly verifierHash: string; // base64url sha256 of the app's verifier, 43 chars
}
export interface CreatePairAttemptResponse {
  readonly attemptId: string;
  readonly approvalPath: string; // "/link/trail-marker?code=..."
  readonly pollIntervalSeconds: number;
  readonly expiresAt: string;
}
export interface PairAttemptSummaryResponse {
  readonly deviceName: string;
  readonly status: "pending" | "approved" | "denied";
}
export interface DecidePairAttemptRequest {
  readonly code: string;
  readonly decision: "approve" | "deny";
}
export interface RedeemPairAttemptRequest {
  readonly attemptId: string;
  readonly verifier: string;
}
export interface RedeemPairAttemptResponse {
  readonly credential: string;
  readonly device: { readonly id: string; readonly displayName: string };
  readonly account: { readonly name: string; readonly email: string };
  readonly expiresAt: string;
}
export type RedeemPairAttemptPending = {
  readonly status: "pending" | "denied" | "expired" | "redeemed" | "unknown";
};
export interface CompanionHeartbeatRequest {
  readonly appVersion: string;
  readonly osVersion: string;
}
export interface CompanionHeartbeatResponse {
  readonly device: { readonly id: string; readonly displayName: string };
  readonly account: { readonly name: string; readonly email: string };
  readonly serverTime: string;
  readonly expiresAt: string;
}
export interface RenameCompanionDeviceRequest {
  readonly displayName: string;
}
export type CompanionErrorCode =
  | "companion_credential_invalid"
  | "account_pending_approval"
  | "account_deactivated"
  | "pair_attempt_not_pending"
  | "invalid_origin";
```

Plus one Fastify JSON schema per route (`companionProtocolRouteSchema`, `createPairAttemptRouteSchema`, `pairAttemptSummaryRouteSchema`, `decidePairAttemptRouteSchema`, `redeemPairAttemptRouteSchema`, `cancelPairAttemptRouteSchema`, `companionHeartbeatRouteSchema`, `renameCompanionDeviceRouteSchema`, `companionLogoutRouteSchema`) following the `listMySessionsRouteSchema` pattern in `packages/shared/src/me-api.ts:169`. Response schemas must use `additionalProperties: false` so a hash or verifier can never leak through serialization.

- [ ] **Step 1: Write the failing test** — `tests/unit/companion-api-schema.test.ts` compiles each schema with Ajv (as the existing `tests/unit/*-schema.test.ts` do), asserts `deviceName` of 65 chars is rejected, `verifierHash` of length ≠ 43 is rejected, and the redeem response schema rejects an extra `credentialHash` property.
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/companion-api-schema.test.ts` — fails, module missing.
- [ ] **Step 3: Write** `companion-api.ts` with the interfaces above and the schemas.
- [ ] **Step 4: Run** the test — passes. Run `pnpm -F @moss/shared typecheck`.
- [ ] **Step 5: Commit** `feat(shared): companion pairing and device contracts (#2560)`.

### Task 2: Migration for pairing attempts and companion devices

**Files:**

- Create: `infra/postgres/migrations/<next>_companion_devices.sql` (SQL from §1.4 of this plan, verbatim)
- Test: `tests/integration/companion-devices-rls.test.ts`

- [ ] **Step 1: Write the failing test.** Using the integration DB helpers the sessions test uses (`tests/integration/me-sessions.test.ts` for setup), open a connection as `jarvis_app_runtime` and assert `SELECT count(*) FROM app.companion_devices` raises `permission denied`; as `jarvis_auth_runtime` assert the same query succeeds. Assert the table exists.
- [ ] **Step 2: Run** through `verify-gate` (scoped: this file) — fails, relation missing.
- [ ] **Step 3: Add** the migration file. Number it with the next free number after checking `ls packages/*/sql/*.sql infra/postgres/migrations/*.sql | sed 's|.*/||' | sort | tail -1` and `git fetch` of open branches.
- [ ] **Step 4: Run** the test through `verify-gate` — passes.
- [ ] **Step 5: Commit** `feat(auth): companion pairing and device tables (#2560)`.

### Task 3: Pairing service in `@moss/auth`

**Files:**

- Create: `packages/auth/src/companion-pairing.ts`
- Create: `packages/auth/src/companion-crypto.ts` (`sha256Base64url(input: string): string`, `randomBase64url(bytes: number): string`, `mintCompanionCredential(): { credential: string; hash: string }`)
- Test: `tests/integration/companion-pairing.test.ts`

**Interfaces (produces):**

```ts
export interface CompanionPairingService {
  create(
    input: CreatePairAttemptRequest
  ): Promise<{ attemptId: string; approvalCode: string; expiresAt: Date }>;
  summarize(input: { approvalCode: string }): Promise<PairAttemptSummaryResponse | null>;
  decide(input: {
    approvalCode: string;
    decision: "approve" | "deny";
    actorUserId: string;
  }): Promise<{ ok: true } | { ok: false; reason: "unknown" | "not_pending" }>;
  redeem(
    input: RedeemPairAttemptRequest
  ): Promise<{ status: "issued"; response: RedeemPairAttemptResponse } | RedeemPairAttemptPending>;
  cancel(input: { attemptId: string; verifier: string }): Promise<void>;
}
export function createCompanionPairingService(deps: {
  pool: pg.Pool;
  now?: () => Date;
}): CompanionPairingService;
```

`redeem` inserts into `companion_devices` with `expires_at = now() + 90 days`, `absolute_expires_at = now() + 365 days`, in the same transaction as the `UPDATE ... WHERE status='approved' AND verifier_hash=$2` that flips the attempt to `redeemed`. It reads `name, email` from `app.users` for the response.

- [ ] **Step 1: Write failing tests** (one `it` each):
  - `create` returns an attempt id and a code, and stores only hashes (`SELECT approval_code_hash, verifier_hash` differ from the raw values).
  - `create` deletes attempts whose `expires_at < now()` (insert a stale row first, then create, assert it is gone).
  - `redeem` before decision returns `{ status: "pending" }`.
  - `decide(deny)` then `redeem` returns `{ status: "denied" }` and no device row exists.
  - `decide(approve)` then `redeem` with the right verifier returns `issued`, the credential starts with `tm1_`, the device row stores `sha256` of it, and the attempt is `redeemed`.
  - Second `redeem` returns `{ status: "redeemed" }`.
  - `redeem` with a wrong verifier on an approved attempt returns `{ status: "unknown" }` and the attempt stays `approved` (no state change, no device row).
  - `decide` on an already-decided attempt returns `{ ok: false, reason: "not_pending" }`.
  - `cancel` on an approved-but-unredeemed attempt removes it; a later `decide` returns `unknown`; `companion_devices` is empty.
  - `redeem` after `expires_at` (pass `now` as a fake clock) returns `{ status: "expired" }`.
  - Two concurrent `redeem` calls (`Promise.all`) produce exactly one `issued` and one `redeemed`.
- [ ] **Step 2: Run** via `verify-gate` — fails, module missing.
- [ ] **Step 3: Implement** the service. Use `pool.connect()` + `BEGIN`/`COMMIT` for redeem. Hash with `createHash("sha256").update(x).digest("base64url")`.
- [ ] **Step 4: Run** — passes.
- [ ] **Step 5: Security-removal check.** Temporarily replace the `AND verifier_hash = $2` predicate with `AND true`, rerun; the wrong-verifier test must fail. Restore. Paste the failing output into the PR body under "Security checks observed failing".
- [ ] **Step 6: Commit** `feat(auth): browser-approved companion pairing service (#2560)`.

### Task 4: Companion credential resolver and device service

**Files:**

- Create: `packages/auth/src/companion-devices.ts`
- Modify: `packages/auth/src/index.ts` (expose `companionPairing`, `companionDevices`, `resolveCompanionContext` on `MossAuthRuntime`)
- Test: `tests/integration/companion-devices.test.ts`

**Interfaces (produces):**

```ts
export interface CompanionContext { readonly actorUserId: string; readonly deviceId: string; readonly requestId: string; }
export class CompanionAuthError extends Error { constructor(readonly code: CompanionErrorCode, readonly httpStatus: 401 | 403) }
export interface CompanionDevicesService {
  resolve(input: { headers: IncomingHttpHeaders; requestId: string }): Promise<CompanionContext>;   // throws CompanionAuthError
  heartbeat(ctx: CompanionContext, input: CompanionHeartbeatRequest): Promise<CompanionHeartbeatResponse>;
  rename(ctx: CompanionContext, displayName: string): Promise<{ id: string; displayName: string }>;
  logout(ctx: CompanionContext): Promise<void>;
}
```

`resolve`: require `Authorization: Bearer tm1_...` (reuse `readBearerToken` then check the prefix); `SELECT id, user_id FROM app.companion_devices WHERE credential_hash=$1 AND expires_at > now() AND absolute_expires_at > now()`; missing → 401 `companion_credential_invalid`; then `app.get_user_by_id` status check exactly as `resolveRequestAccessContext` (`packages/auth/src/index.ts:399-412`); then `UPDATE ... SET last_contact_at = now(), expires_at = LEAST(now() + interval '90 days', absolute_expires_at)`. Log a structured event `auth.companion_credential` with `fingerprintToken` (existing helper at index.ts:610), never the raw token.

- [ ] **Step 1: Failing tests:** valid credential resolves to the right user and device and bumps `last_contact_at`; unknown credential → 401 `companion_credential_invalid`; expired (`expires_at` in the past) → 401; deactivated user → 403 `account_deactivated`; pending user → 403 `account_pending_approval`; `heartbeat` returns name/email and `expiresAt`; `rename` with 65 chars throws a validation error and with `"  Ben's Mac  "` stores `Ben's Mac`; `rename` never touches another user's row (create two devices, rename one, assert the other unchanged); `logout` deletes only own row; a second `resolve` after `logout` → 401.
- [ ] **Step 2: Run** via `verify-gate` — fails.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — passes.
- [ ] **Step 5: Security-removal check.** Drop `AND expires_at > now()` from the resolve query; the expired-credential test must fail. Restore; record output on the PR.
- [ ] **Step 6: Commit** `feat(auth): companion credential resolver and own-device operations (#2560)`.

### Task 5: Companion routes, route guard and rate limits

**Files:**

- Create: `apps/api/src/companion-routes.ts` (`registerCompanionRoutes(server, { authRuntime, trustedOrigins })`)
- Modify: `apps/api/src/server.ts` (call it next to `registerBetterAuthRoutes`)
- Modify: `packages/module-registry/src/route-guard.ts:35` (add the nine `/api/companion/*` route keys)
- Test: `tests/integration/companion-routes.test.ts`

Routes, exactly as in §1.1/§1.3 of this plan. `decide` and `attempt` resolve the actor through `authRuntime.resolveAccessContext` (cookie session) and additionally reject when `request.headers.origin` is absent or not in `trustedOrigins` with 403 `invalid_origin`. The trusted-origins list already exists as `originConfig.trustedOrigins` in `packages/auth/src/index.ts:343`; expose it on `MossAuthRuntime` rather than re-reading env. `pair`, `redeem`, `cancel`, `protocol` set `config.rateLimit` with `keyGenerator: (req) => \`ip:${req.ip}\``(copy the reasoning comment from`registerBetterAuthRoutes`, server.ts:931-946). Companion-authenticated routes use `authRuntime.resolveCompanionContext`and map`CompanionAuthError`to its`httpStatus`with`{ error, code }`.

- [ ] **Step 1: Failing tests** (build the app with the existing integration server factory):
  - `GET /api/companion/protocol` → 200 `{ product: "moss", companionProtocol: 1 }` with no auth.
  - Full happy path: pair → decide (with a real cookie session and `Origin` set) → redeem → heartbeat 200 → rename 200 → logout 204 → heartbeat 401.
  - `decide` without `Origin` → 403 `invalid_origin`; with a foreign origin → 403.
  - `decide` without a session → 401.
  - **Boundary test:** the issued credential sent as Bearer to `GET /api/me`, `GET /api/me/sessions`, `GET /api/modules`, and one module route (`GET /api/tasks` or whichever is registered in the test server) → 401 for each.
  - A cookie session sent to `POST /api/companion/heartbeat` → 401 `companion_credential_invalid`.
  - Server boots (the route-coverage assertion passes) — this is implicit in the factory; assert `server.ready()` resolves.
- [ ] **Step 2: Run** via `verify-gate` — fails.
- [ ] **Step 3: Implement** routes and allowlist entries.
- [ ] **Step 4: Run** — passes. Start the API once from the branch (`pnpm dev:api`) and confirm it boots; kill it.
- [ ] **Step 5: Security-removal check.** Make the heartbeat route fall back to `resolveAccessContext` when `resolveCompanionContext` throws; the cookie-to-heartbeat test must fail. Restore; record.
- [ ] **Step 6: Commit** `feat(api): companion pairing and device routes (#2560)`.

### Task 6: Session listing, revocation and admin revoke include companions

**Files:**

- Modify: `packages/shared/src/me-api.ts:25-46` (DTO)
- Modify: `packages/auth/src/session-service.ts` (list union, revokeOne, revokeOthers)
- Modify: `packages/auth/src/index.ts:166-171` (`revokeUserSessions`)
- Test: `tests/integration/me-sessions.test.ts` (extend)

**DTO change (produces):**

```ts
export type MeSessionSource = "browser" | "cli" | "companion";
export interface MeSessionDto {
  // existing fields unchanged …
  readonly source: MeSessionSource;
  /** Present only for source === "companion". */
  readonly companion: {
    readonly product: "Trail Marker for Mac";
    readonly displayName: string;
    readonly appVersion: string;
    readonly osVersion: string;
    readonly lastContactAt: string | null;
  } | null;
}
```

`list`: third `UNION ALL` branch over `app.companion_devices WHERE user_id=$1 AND expires_at > now() AND absolute_expires_at > now()`, `source='companion'`, `id` = device uuid (non-secret; the secret is the hash column, never selected). `deviceLabel` = display name, `deviceKind` = `"laptop"`, `os` = `"macOS"`, `browser` = null, `isCurrent` always false. Cookie rows get `source: "browser"`, legacy bearer rows `source: "cli"`.

`revokeOne`: in the UUID branch, after the `better_auth_sessions` delete returns 0 rows, run `DELETE FROM app.companion_devices WHERE id=$1 AND user_id=$2`. `revokeOthers`: add `DELETE FROM app.companion_devices WHERE user_id=$1` (a companion is never the current browser session). `revokeUserSessions`: add the same delete.

- [ ] **Step 1: Failing tests:** list shows a companion row with `source: "companion"`, `companion.displayName`, and no `credential_hash` anywhere in the JSON (`JSON.stringify(body)` does not contain the hash); two companions named identically appear as two rows with different ids; `DELETE /api/me/sessions/:deviceId` removes only that one; the other user's device id → 404; `DELETE /api/me/sessions/others` removes both companions and keeps the current cookie session; admin revoke-sessions removes companions; deleting the user cascades the rows.
- [ ] **Step 2: Run** via `verify-gate` — fails.
- [ ] **Step 3: Implement.** Update `tests/e2e/mock-api.ts` and `apps/web/src/settings/settings-sample-data.ts` fixtures with the two new fields so typecheck stays green.
- [ ] **Step 4: Run** — passes; `pnpm typecheck` green.
- [ ] **Step 5: Commit** `feat(auth): list and revoke Mac companions with sessions (#2560)`.

### Task 7: Browser approval page

**Files:**

- Create: `apps/web/src/companion/link-trail-marker-page.tsx`
- Modify: the web router (find the file that registers `/settings` routes with `grep -rn "path: \"/settings" apps/web/src`) to add `/link/trail-marker`
- Modify: `apps/web/src/api/client.ts` (two calls: `getPairAttempt(code)`, `decidePairAttempt(code, decision)`)
- Modify: `packages/shared/src/app-map-core.ts` (declare the screen, its requirement "signed in", errors "link expired", "already decided", and remediation "restart linking from Trail Marker")
- Test: `apps/web/src/companion/link-trail-marker-page.test.tsx`; e2e `tests/e2e/companion-link.spec.ts` using `tests/e2e/mock-api.ts`

Behavior (§3.4, guide §8 step 3): title **Link Trail Marker to Moss?**; shows account name and email from `/api/me`; shows the device name from the attempt; a plain list of the two things the app will be able to do (see who you are; report this Mac's connection); primary **Link this Mac**, secondary **Don't link**. Signed-out users go through the normal login redirect and return to the same URL. After a decision the page shows "You can go back to Trail Marker" (approve) or "Trail Marker was not linked" (deny). Expired/unknown code shows "This link has expired. Start again from Trail Marker." Use `design-system` skill before writing markup; `jds-*` primitives only.

- [ ] **Step 1: Failing component test:** renders device name and account; clicking Link calls `decidePairAttempt(code, "approve")` once; expired code renders the expired message; no raw error strings.
- [ ] **Step 2: Run** `pnpm -F @moss/web test link-trail-marker` — fails.
- [ ] **Step 3: Implement** page, route, client calls, app-map entry.
- [ ] **Step 4: Run** unit + `pnpm -F @moss/web lint` + design-system audit — green. Run the e2e spec.
- [ ] **Step 5: Commit** `feat(web): Trail Marker browser approval page (#2560)`.

### Task 8: Active sessions shows Mac companions

**Files:**

- Modify: `apps/web/src/settings/settings-profile-subviews.tsx:233-450`
- Modify: `packages/shared/src/app-map-core.ts` (setting entry: "Mac companions" under Active sessions; the download link's honest state)
- Test: `apps/web/src/settings/settings-profile-subviews.test.tsx` (extend or create), e2e `tests/e2e/settings-sessions.spec.ts` (extend)

Behavior (§8): `groupSessions` receives only `source !== "companion"` rows; companions render as their own **Mac companions** list under the existing group, one row each, no grouping. Row: display name, **Trail Marker for Mac**, `macOS <osVersion> · v<appVersion>`, **Last successful contact** relative time or "Never". **Sign out device** per row uses the existing `revokeOne` mutation with the device id; confirmation copy names the Mac. **Sign out all others** count includes companions. Beside the group header, a **Download Trail Marker for Mac** link whose target is a constant `TRAIL_MARKER_DOWNLOAD_URL` in `packages/shared/src/companion-api.ts`; while it is `null` the UI shows "Trail Marker for Mac is in testing and not yet available to download" instead of a link.

- [ ] **Step 1: Failing tests:** two same-named companions produce two rows with two distinct sign-out buttons; companion rows are not merged into the browser groups; the "Sign out all others" label counts companions; with `TRAIL_MARKER_DOWNLOAD_URL === null` no anchor is rendered and the availability text is.
- [ ] **Step 2: Run** — fails.
- [ ] **Step 3: Implement.** Use `design-system` skill; no new CSS classes outside `jds-*`.
- [ ] **Step 4: Run** unit, lint, design audit, e2e — green.
- [ ] **Step 5: Commit** `feat(web): Mac companions in Active sessions (#2560)`.

### Task 9: Moss PR wrap: app map, release note, live proof for slices A+B

**Files:**

- Modify: `packages/shared/src/app-map-core.ts` (verify every new screen/setting/error is declared; run `pnpm build:app-map` or the script in `scripts/build-app-map.ts`)
- Modify: PR body

- [ ] **Step 1:** Run the full gate through `verify-gate`. Fix what is yours; known flakes are listed in memory (`gateway-worker-pattern-timeout-flake`, `browser-tests-flake-under-gate-load`).
- [ ] **Step 2: Live proof on dev** (the shared dev instance; address and test login are in the `dev-preview-recipe` memory, never in this repo): from a shell, `POST /api/companion/pair` with curl; open the returned approval path in a browser signed in as the dev test account; approve; `redeem` with curl; `heartbeat`; open Settings → Profile & account and screenshot the Mac companion row (crop, save to disk, attach); Sign out device; `heartbeat` again → 401. Record each request/response (credential redacted) on the PR.
- [ ] **Step 3:** Fill the release note: Category Added; Title "Link a Mac to your account"; Description "You can now approve a Mac companion app from your browser and see or sign out each Mac from Active sessions."
- [ ] **Step 4:** Paste the three security-removal outputs (Tasks 3, 4, 5) under a "Security checks observed failing" heading.
- [ ] **Step 5:** Request cross-model review per `feedback-cross-model-reviewers` (Claude-built → gpt-6-astra medium). Merge with `--squash --auto` when green (`feedback-merge-authority`).

### Task 10: Mac project skeleton and CI

**Files:**

- Create: `apps/trail-marker/project.yml`, `README.md`, `TrailMarker/App/TrailMarkerApp.swift`, `TrailMarker/Resources/Info.plist`, `TrailMarker/Resources/TrailMarker.entitlements`, `TrailMarker/Design/DesignTokens.swift` (copy from `docs/specs/Trail Marker/trail-marker-design-guide/DesignTokens.swift`), asset catalog with the monochrome and colour marks from the guide's `assets/`
- Create: `.github/workflows/trail-marker-mac.yml`
- Test: `TrailMarkerTests/SmokeTests.swift`

`project.yml` essentials: `deploymentTarget: macOS 14.0`, `ARCHS: arm64 x86_64` via `ONLY_ACTIVE_ARCH: NO` for Release, bundle id `com.moss.trailmarker` (stable, §6), `LSUIElement: YES` (menu-bar only), `TRAIL_MARKER_DISTRIBUTION` build setting defaulting to `0`, Sparkle SwiftPM package (added in Task 13; leave a commented line now). The workflow: `macos-14`, `brew install xcodegen`, `xcodegen generate`, `xcodebuild test -scheme TrailMarker -destination 'platform=macOS'`, triggered on paths `apps/trail-marker/**`.

- [ ] **Step 1:** Write `SmokeTests.swift` asserting `Bundle.main.bundleIdentifier == "com.moss.trailmarker"`.
- [ ] **Step 2:** `xcodegen generate && xcodebuild test ...` fails (no project).
- [ ] **Step 3:** Create the files. The app shows a menu-bar item with the monochrome mark (`isTemplate = true`) and a Quit item only.
- [ ] **Step 4:** Tests pass locally on a Mac or on the CI runner (push the branch and watch the workflow).
- [ ] **Step 5:** Verify `pnpm install --frozen-lockfile` still succeeds at the repo root (the new folder must not disturb the workspace).
- [ ] **Step 6: Commit** `feat(trail-marker): Xcode project skeleton and macOS CI (#2560)`.

### Task 11: Instance URL validation and the companion client

**Files:**

- Create: `TrailMarker/Model/InstanceURL.swift`, `TrailMarker/Services/CompanionClient.swift`
- Test: `TrailMarkerTests/InstanceURLTests.swift`, `TrailMarkerTests/CompanionClientTests.swift`

**Interfaces (produces):**

```swift
struct InstanceURL: Equatable {
  let origin: URL           // scheme + host + port, no path
  let basePath: String      // "" or "/moss", no trailing slash
  static func parse(_ text: String) -> Result<InstanceURL, InstanceURLError>
  func endpoint(_ path: String) -> URL
}
enum InstanceURLError: Error, Equatable { case invalid, insecureRemote, credentialsInURL, queryOrFragment }

enum CompanionError: Error, Equatable {
  case unreachable, tls, incompatible(protocol: Int?), credentialInvalid, accountBlocked(code: String),
       rateLimited, server(status: Int), redirectedOffOrigin, decoding
}
protocol CompanionTransport {          // one method so tests can fake it
  func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}
struct CompanionClient {
  init(instance: InstanceURL, transport: CompanionTransport)
  func protocolVersion() async throws -> Int
  func createPairAttempt(_ body: CreatePairAttemptRequest) async throws -> CreatePairAttemptResponse
  func redeem(attemptId: String, verifier: String) async throws -> RedeemOutcome   // .issued(...) | .pending | .denied | .expired | .redeemed | .unknown
  func cancel(attemptId: String, verifier: String) async throws
  func heartbeat(credential: String, app: String, os: String) async throws -> HeartbeatResponse
  func rename(credential: String, displayName: String) async throws
  func logout(credential: String) async throws
}
```

`URLSessionTransport` implements `CompanionTransport` with a delegate whose `willPerformHTTPRedirection` returns `nil` (never follow), so any redirect surfaces as `redirectedOffOrigin`. Default `URLSessionConfiguration` certificate handling; no `serverTrust` override anywhere (§3 URL boundary).

- [ ] **Step 1: Failing tests.** `InstanceURLTests`: `https://moss.example.com` ok; `https://moss.example.com:8443/moss/` ok with basePath `/moss`; `http://localhost:3000`, `http://127.0.0.1:3000`, `http://[::1]:3000` ok; `http://192.168.1.10:3000` → `insecureRemote`; `http://localhost.evil.com` → `insecureRemote`; `https://u:p@x.com` → `credentialsInURL`; `https://x.com/?a=1` → `queryOrFragment`; `moss` → `invalid`. `CompanionClientTests` with a fake transport: 3xx → `redirectedOffOrigin`; 401 `companion_credential_invalid` → `.credentialInvalid`; 403 `account_deactivated` → `.accountBlocked`; 429 → `.rateLimited`; 202 on redeem → `.pending`; 200 on redeem decodes the credential; every request carries `Authorization` only for authenticated calls; the credential string never appears in `URLRequest.url` or `description` (assert on `request.url!.absoluteString`).
- [ ] **Step 2: Run** `xcodebuild test -only-testing:TrailMarkerTests/InstanceURLTests -only-testing:TrailMarkerTests/CompanionClientTests` — fails.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — passes.
- [ ] **Step 5: Commit** `feat(trail-marker): instance URL rules and companion client (#2560)`.

### Task 12: Connection state machine, Keychain and preferences

**Files:**

- Create: `TrailMarker/Model/ConnectionState.swift`, `ConnectionMachine.swift`, `LinkAttempt.swift`, `TrailMarker/Services/KeychainStore.swift`, `PreferencesStore.swift`, `TrailMarker/App/ConnectionRuntime.swift`
- Test: `TrailMarkerTests/ConnectionMachineTests.swift`, `LinkAttemptTests.swift`, `KeychainStoreTests.swift`, `DiagnosticsRedactionTests.swift`

**Interfaces (produces):**

```swift
enum ConnectionState: Equatable { case notLinked, connected(lastContact: Date), disconnected, reconnecting(attempt: Int, lastContact: Date?), signInRequired(reason: SignInReason) }
enum SignInReason: Equatable { case expired, revoked, accountBlocked(String) }

struct LinkedIdentity: Equatable, Codable { let instance: InstanceURL; let deviceId: String; let accountName: String; let accountEmail: String }

enum ConnectionEvent: Equatable {
  case launched(hasCredential: Bool, enabled: Bool)
  case userConnect, userDisconnect, userRetry, userLogout, userQuit
  case heartbeatSucceeded(at: Date, generation: Int)
  case heartbeatFailed(CompanionError, generation: Int)
  case timerFired(generation: Int)
  case wake, networkChanged
  case linkCompleted(LinkedIdentity, credential: String, generation: Int)
  case linkCancelled(generation: Int)
}
enum ConnectionEffect: Equatable {
  case persistEnabled(Bool), sendHeartbeat(generation: Int), scheduleHeartbeat(after: TimeInterval, generation: Int)
  case cancelAll, storeCredential(String, LinkedIdentity), clearCredential, revokeRemotely(generation: Int), showLogoutUnconfirmed
}
struct ConnectionMachine {
  private(set) var state: ConnectionState
  private(set) var generation: Int          // bumped on every user action; stale events carry an old one and are ignored
  mutating func handle(_ event: ConnectionEvent, now: Date) -> [ConnectionEffect]
}
```

Backoff: `min(300, 5 * pow(2, attempt)) * random(0.8...1.2)` seconds; steady interval 60 s.

Keychain: one generic-password item, service `com.moss.trailmarker`, account = `"\(instance.origin.host!)|\(deviceId)"`, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, value = credential. Lookup takes the `LinkedIdentity` from preferences and reads exactly that account, so a leftover item for another instance is never picked up (§9 client). Preferences (`UserDefaults`): `linkedIdentity` (Codable), `connectionEnabled` (Bool, default true once linked), `displayName`, `pendingDisplayName` (saved while disconnected), `startAtLogin` (default false), `autoCheckUpdates` (default true), `permissionsPromptShown` (Bool).

- [ ] **Step 1: Failing tests** (`ConnectionMachineTests`, one test per line):
  - `launched(hasCredential: true, enabled: true)` → `.reconnecting(0)` + `[sendHeartbeat]`; then `heartbeatSucceeded` → `.connected` + `[scheduleHeartbeat(60)]`.
  - `launched(hasCredential: true, enabled: false)` → `.disconnected` with **no** effects.
  - From `.connected`, `userDisconnect` → effects begin with `persistEnabled(false)` then `cancelAll`; state `.disconnected`.
  - After `userDisconnect`, a `heartbeatSucceeded` with the old generation → no state change, no effects.
  - After `userDisconnect`, `wake`, `networkChanged`, `timerFired(old)` → no effects.
  - From `.reconnecting`, `heartbeatFailed(.unreachable)` three times → backoff grows and never exceeds 300 s; `heartbeatFailed(.credentialInvalid)` → `.signInRequired(.revoked)` with `[cancelAll]` and no reschedule.
  - `heartbeatFailed(.tls)` and `.server(503)` → stays `.reconnecting`, not sign-in required.
  - `userRetry` in `.reconnecting` → `[cancelAll, sendHeartbeat(newGen)]`; in `.disconnected` → no effects.
  - `userLogout` from `.connected` → `[cancelAll, revokeRemotely, clearCredential]` and `.notLinked`; a later `heartbeatFailed` for the revoke with the old generation → `[showLogoutUnconfirmed]` only.
  - `userQuit` → `[cancelAll]` and the persisted enabled flag is untouched (no `persistEnabled` effect).
  - `LinkAttemptTests`: `linkCompleted` with a stale generation (user cancelled first) → no `storeCredential`; the verifier is 43 base64url chars and `sha256` matches the server rule (test vector from Task 3).
  - `KeychainStoreTests` (run on the CI Mac; `xcodebuild` keychain is available): store, read, delete round trip; reading with a different `LinkedIdentity` returns nil.
  - `DiagnosticsRedactionTests`: the diagnostics string for `CompanionError.server(500)` and for a heartbeat failure contains neither the credential nor the verifier nor an `Authorization` header value.
- [ ] **Step 2: Run** — fails.
- [ ] **Step 3: Implement** machine, stores, and `ConnectionRuntime` (executes effects with a `Task` per generation and cancels on `cancelAll`; registers `NSWorkspace.didWakeNotification` and `NWPathMonitor` to emit `wake`/`networkChanged`).
- [ ] **Step 4: Run** — passes.
- [ ] **Step 5: Commit** `feat(trail-marker): connection state machine, Keychain and preferences (#2560)`.

### Task 13: Onboarding, menu, settings window, permissions, login item, updater

**Files:**

- Create: `TrailMarker/Views/Onboarding/*.swift` (Welcome, WaitingForApproval, DeviceSetup, Success), `TrailMarker/Views/Menu/StatusMenu.swift`, `TrailMarker/Views/Settings/{SettingsWindow,ConnectionPane,ThisMacPane,PermissionsPane,UpdatesPane}.swift`, `TrailMarker/Services/{PermissionsService,LoginItemService,UpdaterService}.swift`
- Modify: `project.yml` (add Sparkle package, `SUFeedURL`, `SUPublicEDKey` placeholder read from a build setting; `SUEnableAutomaticChecks` NO by default so the app controls it)
- Test: `TrailMarkerTests/MenuModelTests.swift`, `PermissionsServiceTests.swift`

Follow the design guide sections 7–13 for every screen; behavior from spec §3–§7. Concrete rules the implementer must hit:

- Onboarding: URL field preserves text on error; errors are the four categories from §3.2 with copy from guide §13; **Connect in Browser** calls `protocolVersion()` then `createPairAttempt()` then `NSWorkspace.shared.open(instance.endpoint(approvalPath))`; **Waiting for browser approval** polls `redeem` every `pollIntervalSeconds` (honour 429 by doubling), offers Cancel (calls `cancel`, bumps generation) and Open Browser Again.
- Device setup: name defaults to `Host.current().localizedName`; Start at login toggle off; permissions section with **Skip for Now** and the required copy "These permissions prepare future capabilities. Trail Marker is not observing your activity."
- Menu order (guide §10): status row, instance/account rows, state action (Connect / Disconnect / Retry Now / Sign In), separator, Open Moss, Settings…, Check for Updates…, separator, Log Out… (only when linked), Quit Trail Marker. Disconnect is not styled destructive; Log Out asks for confirmation.
- Permissions: Accessibility via `AXIsProcessTrustedWithOptions` with prompt only on the explicit button; Screen Recording via `CGPreflightScreenCaptureAccess()` / `CGRequestScreenCaptureAccess()`; status shown as granted / not granted only (§6); `permissionsPromptShown` prevents re-prompting at launch.
- Login item: `SMAppService.mainApp.register()/unregister()`; surface `SMAppService.Status.requiresApproval` with a button that opens `SMAppService.openSystemSettingsLoginItems()`.
- Updater: `SPUStandardUpdaterController`; `automaticallyChecksForUpdates = prefs.autoCheckUpdates && prefs.connectionEnabled`, recomputed on each state change; with `TRAIL_MARKER_DISTRIBUTION == 0` the Updates pane shows the development-build text and disables Check Now.
- Accessibility: every status uses SF Symbol + text; respect `accessibilityReduceMotion`; no fixed frame heights on text-bearing rows.

- [ ] **Step 1: Failing tests.** `MenuModelTests`: for each of the five states, the ordered menu item titles match the guide (write the five expected arrays literally); Log Out absent in `.notLinked`. `PermissionsServiceTests`: with a fake OS adaptor, `refresh()` never calls the prompting variant; `requestAccessibility()` calls it exactly once.
- [ ] **Step 2: Run** — fails.
- [ ] **Step 3: Implement** all views and services. Use `design-system` skill only for Moss web; for the Mac app the guide is the authority.
- [ ] **Step 4: Run** tests; build Release universal (`xcodebuild -configuration Release ONLY_ACTIVE_ARCH=NO`) and confirm `lipo -info` lists `x86_64 arm64`.
- [ ] **Step 5: Commit** `feat(trail-marker): onboarding, menu, settings, permissions, login item, updater (#2560)`.

### Task 14: Live proof on Ben's Mac against dev

**Files:**

- Modify: `apps/trail-marker/README.md` (developer install steps, unsigned-build caveat, how to clear Keychain + preferences between runs)
- Modify: Mac PR body

Prerequisite: Moss PR 1 merged and deployed to the shared dev instance. Its plain-HTTP LAN address is on a LAN address, which the URL rule rejects on purpose. Use the https tailnet address on port 5443 (`dev-https-tailscale-5443` memory) as the instance URL; confirm the trusted-origins list on dev includes it before starting (`dev-instance-lan-spinup-trusted-origins`).

Ask Ben to run these on his Mac; each line is one check from spec §12, recorded as a short note plus a cropped screenshot saved to disk and attached:

- [ ] Install from the built archive; launch; the menu-bar mark appears; `Trail Marker` and `A Moss companion` visible in onboarding.
- [ ] Link with the real browser; the Mac appears under Mac companions with the chosen name and **Last successful contact**.
- [ ] Quit and relaunch: still Connected without a browser step. Enable Start at login, log out of macOS and back in: app running.
- [ ] Disconnect; relaunch; still Disconnected; Console log (or the app's request counter in Settings → Connection → View Details) shows zero requests over five minutes.
- [ ] Turn Wi-Fi off while Connected → Reconnecting; Wi-Fi on → Connected within the retry window.
- [ ] Sign out the Mac from Moss → within about a minute the app shows Sign-in required; Sign In relinks.
- [ ] Log Out while offline → app returns to Not linked with the "revocation unconfirmed" notice; the row still shows in Moss until removed there.
- [ ] Link a second time with the same name from the same Mac after logout → two rows in Moss, revoke one, the other survives.
- [ ] Companion credential (copied from Keychain Access for this test only, then rotated by relinking) sent with curl to `/api/me` and `/api/tasks` → 401.
- [ ] Permissions: skip on first run, no prompt on relaunch; grant Accessibility from Settings; status updates.
- [ ] VoiceOver reads every status; light/dark; Increase Contrast; larger text in Settings.
- [ ] Entering the dev instance's plain-HTTP LAN address → insecure-remote error; `https://expired.badssl.com` → certificate error; a URL that redirects → the redirect error.

Then: release note (Category Added; Title "Trail Marker for Mac (early build)"; Description "A Mac menu-bar app can now link to your account and show up under Active sessions; it does not observe your activity."), app map unchanged (the app is not a Moss screen; the web parts were declared in Task 7–8), cross-model review, merge.

### Task 15: Public release pipeline (deferred gate, do not start without Ben's go)

Blocked on Apple Developer enrollment (US$99/year, not purchased). When Ben says go:

- [ ] Add secrets: Developer ID certificate (p12 + password), notarytool App Store Connect key, Sparkle EdDSA private key.
- [ ] Extend `trail-marker-mac.yml` with a `release` job on tag `trail-marker-v*`: archive universal, `codesign --options runtime --timestamp`, `notarytool submit --wait`, `stapler staple`, zip, `generate_appcast`, upload `TrailMarker-<v>.zip` + `trail-marker-appcast.xml` to the GitHub release.
- [ ] Set `TRAIL_MARKER_DISTRIBUTION=1` and the real `SUPublicEDKey` for release builds only.
- [ ] Set `TRAIL_MARKER_DOWNLOAD_URL` in `packages/shared/src/companion-api.ts` to the release page; the Active sessions link switches from the availability text to a real link (Task 8 already handles both).
- [ ] Verify on a clean Mac (both architectures): notarized install with no Gatekeeper warning; an update from the previous version preserves a manual Disconnect; a tampered zip is rejected by Sparkle.

---

## Part 3. Self-review against the spec

| Spec section                                     | Where it lands                                                               |
| ------------------------------------------------ | ---------------------------------------------------------------------------- |
| §1 scope, one account per process, multiple Macs | Tasks 3, 6, 12, 14                                                           |
| §2 design precedence, naming, copy               | Task 13 (guide), Task 8 ("Trail Marker for Mac", "Last successful contact")  |
| §3 first-run, URL boundary                       | Tasks 11, 13                                                                 |
| §4 state table, Disconnect semantics             | Task 12 (machine), Task 13 (updater gating)                                  |
| §5 settings inventory                            | Task 13; pending name while disconnected via `pendingDisplayName` in Task 12 |
| §6 permissions                                   | Task 13                                                                      |
| §7 menu, accessibility                           | Tasks 13, 14                                                                 |
| §8 Active sessions integration, download link    | Tasks 6, 8                                                                   |
| §9 protocol, resolver, migration, consumers      | Part 1 §1.1–1.4, Tasks 1–6                                                   |
| §10 updates and distribution                     | Part 1 §1.5, Tasks 13, 15                                                    |
| §11 failure handling, diagnostics                | Tasks 11, 12 (redaction test), 13                                            |
| §12 acceptance                                   | Tasks 9 and 14 map one to one                                                |
| §13 non-goals                                    | No task builds observation, switching, sync or OAuth-provider surfaces       |

Known gaps accepted for this plan: no e2e test drives the real Mac app from Linux (§12 says Linux cannot prove macOS behavior; Task 14 is the proof). Deployment config changes: none, because no new env var is introduced; the trusted-origins check in Task 14 is a verification, not a change.
