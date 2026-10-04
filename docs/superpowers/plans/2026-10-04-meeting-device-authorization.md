# Meeting-device authorization checkpoint

Date: 2026-10-04. Task: #2981. Draft PR: #2982.
Approved product design: `docs/superpowers/specs/2026-10-03-meeting-companion.md`, section 9.
Status: proposed implementation plan; security review and committed-plan gate precede code.

## Outcome and boundary

Implement a separate, owner-approved authorization protocol for one meeting and one device
installation. This checkpoint permits only reading that authorization's metadata and revoking it.
It does not start capture, submit audio/transcript, expose meeting content, accept Tasks, export
Notes, call providers, or authenticate general chat/admin/ordinary meeting routes. Those future
operations require a separately reviewed scope extension and fresh owner approval; existing grants
must never silently gain authority.

The browser approval UI and native handoff remain required before the complete product can ship.
This checkpoint is backend protocol code, not a finished linking or recording experience. No real
credentials, account permissions, audio, or provider configuration will be created during this work.

## Seams verified in the current tree

- General bearer authentication reaches the UUID-only `AuthSessionResolver`, so a separately
  prefixed token is not a general session: `packages/auth/src/index.ts:409-474` and
  `packages/db/src/auth-session.ts:16-29`.
- Trail Marker has a separate resolver and auth-owned storage. Its `tm1_` credential remains
  unchanged: `packages/auth/src/companion-devices.ts:79-141` and
  `infra/postgres/migrations/0238_companion_devices.sql:1-12`.
- Browser session row IDs are distinct from bearer secrets; session revocation deletes the
  underlying row: `packages/auth/src/session-service.ts:26-32,132-155`.
- Protected module work uses `DataContextRunner.withDataContext`, which sets transaction-local
  owner identity: `packages/db/src/data-context.ts:56-80`.
- Meetings owns an RLS table with an `(id, owner_user_id)` unique key and owner-only policy;
  public repository access requires `DataContextDb`:
  `packages/meetings/sql/0260_meeting_records.sql:2-25` and
  `packages/meetings/src/repository.ts:89-106`.
- Module route declarations remain authoritative. The current route guard lets failed general
  authentication reach the route's own resolver; the separate device handler must independently
  check module availability after authentication:
  `packages/module-registry/src/route-guard.ts:275-326`.
- API composition already supplies per-owner module availability and auth services to the module
  registry: `apps/api/src/server.ts:472-495,566-609`.

CodeGraph tooling was unavailable in this execution environment. The citations above come from
reading current source, rather than an inferred graph.

## Architectural decision and rejected alternatives

Keep authorization rows in the Meetings module, protected by owner RLS. A credential contains an
untrusted owner locator, grant ID, and random secret. The owner locator is not an authenticated
actor: it is used only to enter a DataContext for reading the exact authorization row. No meeting
content read, mutation, actor audit, provider call, or module-availability lookup happens until a
constant-time comparison validates the stored credential/verifier digest. The initial proof is a
read-only transaction that closes before session/module preflight. Never return the scoped
DataContext or a general resolver from a device-facing API.

The selected design avoids adding module-specific data to the core auth store. The core auth
package supplies one small generic browser-session binding port: cookie-only resolution and a
fresh existence/owner/expiry/account-status check. Only that package reads auth tables.

Alternative: copy the existing central auth-owned companion pairing store. That is a proven
pre-auth pairing pattern and avoids untrusted owner locators. It also needs pre-owner attempt
storage, privileged auth-role module metadata, an additional transfer into module RLS, and more
coordination for meeting deletion. This checkpoint instead starts only after explicit browser
owner approval, so no unauthenticated attempt table is needed. If review cannot establish that the
untrusted-locator path is a strictly read-only digest check, stop this design and return to the
central pattern rather than weakening isolation.

No accepted ADR is reversed: ADR 0001 private-data/RLS and ADR 0009 module-owned contributions
remain in force. The decision is recorded here; a new ADR is required before a later design gives
module data a core-auth privilege exemption or changes general route authentication.

## Protocol and lifecycle

1. The native installation generates a random UUID installation ID and a 256-bit random verifier.
   It gives the browser only the installation ID, plain-text display name and SHA-256 verifier
   challenge. Its future UI handoff transports no bearer credential. This checkpoint implements
   the server interface, not that handoff.
2. A signed-in owner explicitly approves those fields for one existing meeting. Approval is a
   POST, requires an actual cookie session, rejects every Authorization header, and requires an
   exact trusted Origin. Owner identity and approving session ID are taken only from that cookie
   session. The browser supplies a request key for exact replay.
3. After owner RLS confirms the meeting, insert a pending grant containing owner, meeting,
   installation ID/name, challenge digest, approving browser session ID, creation time and fixed
   deadlines. A pending grant is redeemable for at most ten minutes. The authorization deadline
   is the lesser of eight hours from approval and the approving browser session's current expiry.
   Neither polling, redeeming nor later session extension slides those deadlines.
4. Return only nonsecret grant, owner-locator, meeting and installation IDs, permitted operations,
   status and deadlines. The future browser/native handoff returns this descriptor to the native
   installation. Seeing the descriptor alone gives no authority.
5. Native POST redemption supplies the descriptor and original verifier in the body. Validate
   bounded syntax, then use a **read-only cryptographic-probe transaction** to find the exact
   pending row and compare its challenge in constant time. Close that transaction before any
   session/module preflight. Only a successful proof permits fresh checks of the approving session
   and owner module availability. Finally open a separate transaction, lock the row, and repeat
   the exact digest, owner/device/meeting, pending state and fixed-deadline checks. One winner
   changes pending to active and receives `md1_<owner UUID>.<grant UUID>.<random secret>` in this
   one POST response only. Store only the credential digest. Send `Cache-Control: no-store`.
6. Device status/revoke POSTs carry that credential in Authorization plus exact meeting and
   installation IDs in the body. Reject browser cookies as a substitute and reject `tm1_`, legacy
   UUID bearer and malformed tokens. Apply the same three stages: read-only cryptographic proof
   with exact scope/state/deadline checks; close that transaction; fresh session/account/module
   preflight; then a final locked transaction repeating digest, exact scope, active status, fixed
   expiry and revocation checks before the bounded operation. No module resolver or auth preflight
   runs while an app transaction is held. Never expose a general-purpose authenticated callback.
7. Browser owner revoke can revoke one grant or all grants for one installation in the selected
   meeting. It uses the same cookie/Origin guard and RLS. Revocation and each final device operation
   serialize on the grant row. Operations already committed before grant revocation are not
   undone; once grant revocation commits, a later final operation must fail. Meeting/account
   deletion cascades. Approval also performs module/session preflight before its app transaction.
8. Browser sign-out/session revoke/expiry and account deactivation invalidate the fresh public
   session-binding preflight on the next request. Module disable rejects the next preflight.
   These cross-service checks are request-bound and uncached, not atomically locked with grant
   operations: a request already admitted by preflight can finish while session/module revocation
   happens concurrently. The final grant-state/deadline checks still run in its locked transaction.
   Do not claim that account/session/module revocation cancels in-flight work or implements a push
   disconnect. Future capture transport needs a separate interruption design and proof.

The transaction boundary is mandatory: the public module-availability resolver acquires its own
app connection. Calling it while holding another app transaction could deadlock a one-connection
pool or exhaust the pool under concurrent requests. Tests must assert that both preflight ports
are called with no app transaction active and that the final locked check rejects a grant revoked,
expired or scope-changed between the initial proof and final transaction.

An installation ID plus verifier/credential proves possession of that installation's secret. It
does not provide hardware attestation, and a copied bearer credential is still a stolen bearer.
There is no claim of OS secure storage or end-to-end credential confinement until the native
transport and storage consumers are implemented and inspected.

### Replay and lost responses

- Exact browser approval replay returns the same nonsecret descriptor. Changed input under the
  same request key returns conflict; it cannot change the approved meeting/device/challenge.
- Redeem is one-use and never recreates a token from a receipt. Concurrent redeem has one winner.
  A lost successful redeem response requires owner revocation and a fresh approval/request key.
  No plaintext secret is persisted to make retries convenient.
- Unknown row, wrong verifier/credential, wrong scope, expired/revoked binding, and owner mismatch
  return the same safe authorization-unavailable response without confirming private identities.
- Browser list/status never returns verifier digest, credential digest, session ID or a bearer.
  GET is not used for secret-bearing input or credential issue. Default logs carry no body fields.
- A bounded cap of 20 retained grants per meeting prevents unlimited receipt growth. Approval
  can replace expired/revoked grants only through explicit repository cleanup of those rows; a
  retry whose expired receipt was pruned is no longer idempotent and must use a new request key.
  Prefer rejecting at the cap in this checkpoint rather than silently pruning replay history.

## Files and public seams

New files:

- `packages/shared/src/browser-session-binding.ts`: generic server-side public port types,
  `BrowserSessionBinding` and `BrowserSessionBindingService`.
- `packages/shared/src/meeting-device-api.ts`: bounded request/response contracts, operation
  literals, explicit error codes and Fastify schemas.
- `packages/auth/src/browser-session-binding.ts`: cookie-only session resolution plus fresh
  session/owner/account-status existence check through the existing auth pool.
- `packages/meetings/src/device-authorization-crypto.ts`: mint/parse/digest/constant-time checks.
- `packages/meetings/src/device-authorization-repository.ts`: `DataContextDb`-only row access.
- `packages/meetings/src/device-authorization-service.ts`: explicit approve/redeem/authorize/revoke
  flow; no generic action dispatch or provider client.
- `packages/meetings/src/device-authorization-routes.ts`: separate cookie-owner and device routes.
- `packages/meetings/sql/0267_meeting_device_authorizations.sql`: reserved by coordinator.
- `tests/unit/meeting-device-authorization.test.ts` and
  `tests/unit/meeting-device-routes.test.ts`: pure protocol/route synthetic tests.
- `tests/unit/browser-session-binding.test.ts`: synthetic auth-pool boundary tests.
- `tests/integration/meeting-device-authorization.test.ts`: isolated CI-only RLS, race and cascade
  tests. Written here; not executed on the shared local database server.

Small coordinated edits:

- Public exports in `packages/shared/src/index.ts`, `packages/meetings/src/index.ts`, and
  `packages/auth/src/index.ts`.
- `packages/db/src/types.ts`: authorization table shape.
- `packages/meetings/src/manifest.ts`: owned table/migration, route declarations, app-map feature
  and errors/remediations. Preserve the existing truthful recording-unavailable description.
- `packages/module-registry/src/index.ts` and `apps/api/src/server.ts`: pass the public session
  binding port and trusted origins; register routes under Meetings. Do not change the general
  credential resolver or platform route allowlist.

Intended public service methods are `approve`, `redeem`, `status`, `revokeAsDevice`, and
`revokeAsOwner`. Every device method takes exact meeting/device scope. No arbitrary callback,
AccessContext, database handle, content reader or general-purpose operation string is exposed.

## Storage decision

`app.meeting_device_authorizations` has UUID `id` primary key, RLS-defaulted `owner_user_id`,
`meeting_id`, owner-scoped `request_key`, `device_id`, bounded `device_name`, 43-character base64url
`verifier_hash`, nullable `credential_hash`, `approval_session_id`, `approved_at`,
`redeem_expires_at`, `expires_at`, `status` (pending/active/revoked), and nullable `revoked_at`.
Use a composite foreign key `(meeting_id, owner_user_id)` to the Meetings record with delete
cascade, uniqueness on `(owner_user_id, request_key)`, and checks tying active status to a digest,
revoked status to revoked time, and deadlines to approval time. ENABLE and FORCE RLS; owner-only
USING/WITH CHECK for app runtime; no admin branch, worker grant or auth-role bypass. Grant only
SELECT/INSERT and necessary UPDATE columns. Browser-session ID is an opaque auth-owned handle,
validated through the public auth port, not a query of another module's tables.

## Verification and release gates

Run only pure synthetic tests locally. Do not run migrations, integration tests or the local
foundation gate while the shared database-server isolation issue (#2989) remains open. Root and
test TypeScript checks must be serialized by the coordinator, never run concurrently.

Expected exit code 0 for each unpiped command:

- `pnpm exec vitest run tests/unit/meeting-device-authorization.test.ts tests/unit/meeting-device-routes.test.ts tests/unit/browser-session-binding.test.ts`
- `pnpm exec eslint <explicit changed TypeScript paths> --max-warnings=0`
- `pnpm exec prettier --check <explicit changed paths>`
- Coordinator: `pnpm exec tsc --noEmit` and `pnpm exec tsc -p tsconfig.tests.json --noEmit`.
- Coordinator: migration-number collision check, file-size check and app-map build.

Security tests must be observed failing with their corresponding check removed, then passing
when restored: verifier/credential digest, exact device/meeting scope, fixed expiry, revocation,
cookie-only approval, Origin, approval-session validity, module disable, and denial of general
notes/Tasks/admin/chat routes. Record mutation evidence with precise test names. RLS, concurrent
redeem/revoke and actual session-cascade behavior need CI's disposable per-job database server.
Tests using synthetic repositories do not count as RLS or live-path proof.

Before calling this a complete linking feature, implement and exercise real browser approval,
native verifier handoff/storage, explicit revoke and expired/session-ended remediation through
the real UI on a live dev instance. Required future UAT must prove cookie owner approval, exact
meeting/device binding, one-time redeem and immediate next-request rejection after revoke; no
network interception. Until then the status remains backend checkpoint, live-path unverified.

## Determinism and stop condition

All approval, status, expiry and revoke feedback comes from persisted records. No model is used,
no prompt is added, and no host-chat turn is injected. If security review cannot preserve the
read-only unauthenticated locator boundary, or CI isolation/RLS proof fails, the coordinator stops
this checkpoint before adding capture transport. Native capture and provider work do not depend
on an unverified authorization assumption.

## Design-review rulings

- Review 1: the initial plan placed module-availability checks inside a held app transaction.
  `createActiveModulesResolver` enters its own DataContext, so this can deadlock under bounded
  pools. Accepted correction: read-only cryptographic probe, close transaction, fresh preflight,
  then locked cryptographic/scope/state/deadline revalidation. Cross-service revoke is explicitly
  request-bound; grant revoke serializes with the final operation.
