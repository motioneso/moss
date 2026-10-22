# Outlook user setup: implementation spec

**Status: implementation in progress within the approved user flow.** Durable lifecycle storage and
its recovery dispatcher and internal host inventory/egress/Podman primitives are implemented;
the managed service, authenticated API/viewer, and Settings integration remain pending. See the
[implementation record](../plans/2026-10-22-outlook-user-setup-progress.md).
Ben approved the
[setup flow and disconnect semantics](2026-10-22-outlook-user-setup-design.md) on 2026-10-22.
The runtime/deployment details below carry that flow into implementation; they do not introduce
another approval checkpoint. Deployment and production migration are separate actions.
Tracking: [#3570](https://github.com/motioneso/moss/issues/3570).

## Result and initial platform

Each authenticated Moss user connects one Outlook primary calendar through Settings → Connections,
signs into Microsoft in a separate browser window, and confirms the detected address. Keep the
approved mockups, read-only calendar scope, yesterday-to-next-30-days coverage, five-minute refresh,
freshness semantics, and disconnect removing imported events and the saved local browser session.

The initial managed-browser host is Linux with rootless Podman. Users can access that Moss server
from other devices and browsers, including Firefox. This is a server requirement, not a requirement
that each user install Podman. Native Windows/macOS runtime hosts are deferred. An optional installer
step installs/enables the host broker once; there is no per-person operator configuration. Moss
without this runtime stays usable and shows the approved runtime-unavailable remediation.

## Evidence supporting the choice

[The reproducible synthetic spike](../../../spikes/outlook-browser-runtime/README.md) passed 17
checks for independent browser state, rootless container boundaries, Chromium sandbox diagnostics
with a no-sandbox negative control, HTTP frames/input, fixture-session authorization with negative
controls, graceful persistence and profile cleanup. It used no real accounts or production services.
It does not prove Moss auth integration, real Microsoft sign-in, remote usability or production
security properties. Those remain acceptance requirements below, not claims of existing behavior.

## Runtime and deployment seam

Implement a dedicated host broker, running under a dedicated non-root system account with rootless
Podman. A hardened service definition and installer belong in this feature's delivery. The API and
worker do not mount the container engine socket or launch arbitrary host commands. They access the
broker over a private Unix socket mounted only into the necessary services, with documented matching
UID/group permissions. Reject unsupported permissions at startup; do not chmod world-readable.

The broker has a fixed operation set: allocate, inspect readiness/identity, acquire interactive
lease, capture frame, send bounded pointer/key/text input, acquire collector lease, stop, and remove.
Resolve resource ownership and connection generation server-side. Runtime IDs are opaque references,
not capabilities or endpoints chosen by the client. Never expose arbitrary CDP methods, URLs, shell
commands, filesystem paths, downloads, clipboard, file transfer, profile export or recording.

Each connection gets its own rootless container, persistent profile volume, process and network
namespaces. Use a read-only root, no extra capabilities, no-new-privileges, resource limits and a
reviewed Chromium-compatible seccomp profile. Preserve Chromium namespace/seccomp sandboxing and
test it on each supported architecture. Production images need maintained pinned browser releases;
do not publish the spike image or its test-only bypass flags as the product runtime.

Microsoft needs external HTTPS access. Use a dedicated per-container network with no host/LAN,
metadata-service, database, application or peer-runtime access, and controlled outbound DNS/HTTPS.
Enforce those restrictions outside page-controlled code and test redirects, IPv6 and DNS rebinding.
Do not claim network isolation from the spike's `--network none` result: this egress-enabled path
must pass its own negative controls before shipping. Avoid fragile Microsoft-domain allowlists that
break federated employer sign-in; resolve reachability through the controlled egress boundary.

The host broker is a trusted component with access to profiles. Document this boundary and its
service privileges. Profiles contain live login material: exclude them from ordinary exports,
diagnostic bundles, AI tools and default backups. Installer guidance must specify volume access,
host-disk encryption and intentional encrypted backup/recovery options without asserting Chrome
profile files are equivalent to encrypted connector secrets.

## Data and API changes

Add a new connectors-owned migration; never edit `0331_outlook_browser_calendar.sql`. Retain its
one-provider-account-per-owner constraint. Add owner-scoped runtime/setup records with RLS and
explicit generation, lifecycle state, confirmed identity reference, expiry and cleanup status.
Keep runtime secrets behind the runtime seam and encrypt any stored connector secret through the
existing cipher. Opaque runtime references are metadata, not authority. Applied migration catalog,
export and account-deletion coverage must be updated together.

Extend `packages/shared/src/outlook-calendar-api.ts` with owner-visible setup/status/action contracts,
without leaking runtime endpoints, browser cookies or auth tokens. Preserve legacy clients' status
fields. Add Fastify routes under `/api/connectors/outlook-calendar`:

| Operation                | Purpose                                                              |
| ------------------------ | -------------------------------------------------------------------- |
| POST `/setup`            | Idempotently create/resume the actor's unexpired setup               |
| GET `/setup`             | Current setup state and detected identity, owner only                |
| POST `/setup/confirm`    | Reverify rendered identity and atomically bind it before collection  |
| POST `/setup/cancel`     | Cancel unconfirmed setup and enqueue cleanup                         |
| POST `/viewer`           | Acquire one interactive lease bound to current browser auth session  |
| GET `/viewer/:id/frame`  | One no-store frame, with fresh session/owner/generation/lease checks |
| POST `/viewer/:id/input` | Bounded input, same checks plus same-origin/CSRF validation          |
| DELETE `/viewer/:id`     | Release interactive control without deleting the signed-in profile   |
| POST `/refresh`          | Schedule an owner/generation-bound collection                        |
| POST `/disconnect`       | Revoke access, remove imported events and begin durable cleanup      |

Use the actual `SessionBindingsService.resolveBrowser` and `assertLive` paths; a generic API token
or admin privilege is insufficient for interactive control. No viewer bearer secret in a URL or
browser storage. A viewer identifier is always checked against the authenticated session. Validate
Origin/fetch metadata and CSRF on reads carrying frames as well as mutations. No CORS relaxation.
Use generic denials so substituted IDs do not reveal another account's existence.

The sign-in window is a separate same-origin Moss route showing browser pixels and forwarding
only supported inputs. It does not embed Microsoft in an iframe or supply a Moss password form.
Use shared Moss primitives for controls, errors, loading, in-use and expired states. Start with
HTTP frame polling at most twice per second while visible; stop on denial, lease expiry, navigation,
hidden page or sign-out and clear the displayed frame. Do not put frames or typed input in query
caches, service-worker caches, traces, logs, AI context or analytics. Check authorization immediately
before applying input and immediately before releasing each frame, including cancellation races.

## State, locks and timeouts

Use generation-bound leases across collection and interaction. One interactive controller or one
collector at a time for a connection; show in-use rather than stealing a live lease. Short internal
operations must not hold a global cross-user lock. Revalidate after waits and before applying results.

Initial limits: setup expires after 30 minutes without activity; interactive control after five
idle minutes or 30 minutes absolute; lease heartbeat every 15 seconds with a 45-second missed-heartbeat
expiry. A hidden viewer releases control. Background sign-in detection can continue within the setup
limit. All limits use injected time for tests and must be documented in Settings help metadata.

The collector enumerates eligible owner connections every five minutes, reusing the existing rendered
calendar collector through a private runtime session. Verify source identity before each scan, and
recheck active status, grants and generation before commit. Jobs contain IDs only. Unreadable, partial
or identity-mismatched scans do not delete events or advance successful coverage. Never infer complete
coverage from an empty DOM.

Disconnect durably marks the connection inactive and advances its generation before cleanup begins.
Revoke interactive and collector leases, remove imported events through the calendar module's public
API, then terminate the browser and remove its volume. Mark removed only after runtime confirmation.
If cleanup fails, block replacement, expose the approved cleanup-pending state and retry with bounded
backoff, capped at 15 minutes between attempts. Persist cleanup work across restarts; do not abandon
it after a retry count. User deletion invokes the same durable lifecycle without requiring login.

## Existing installation compatibility

Retain the current environment-bound collector when the new runtime is disabled. Its existing owner
continues to see their working connection. New users see managed setup only when runtime health and
deployment support are present. Never allow another user to adopt the configured browser.

Migration requires the owner to sign into a new managed session; do not copy the old browser profile.
Keep the old binding until the new source has been verified and is ready. Replace the active collector
atomically, preserve the owner's checkpoint where source identity matches, and reject late legacy
jobs. No simultaneous collectors for that owner. A failed preparation keeps the existing collector.
Production deployment/migration is a separate authorized action after the build passes its gates.

## Delivery and acceptance

Implement behind the optional runtime configuration with all affected dev/installer/production
Compose and env support in the same feature PR. Settings, Calendar source/error states, runtime
requirements and remediations must update the core/module app-map declarations in that PR.

Required proof before calling this ready:

1. Repository verification gates on an isolated database, using the verify-gate skill. Unit and
   integration coverage includes real RLS, actual auth-session resolution, ownership substitution,
   source confirmation, generation races, lease expiry, disconnect and user deletion.
2. Repeat the spike's negative controls on the real API→auth→broker→browser and worker→RLS→collector
   paths, including admin, other user, no auth, revoked session, changed origin and stale generation.
   Inspect the receiving libraries' paths for frames, input, cookies, credentials and diagnostics.
3. Two ordinary Moss users connect different synthetic sources through the live dev UI concurrently;
   data, rendered browser input and imported events stay with the correct user. Exercise restart,
   cleanup failure, abandoned setup, crash recovery, old-job completion and replacement attempts.
4. Prove the actual egress network denies host, LAN, metadata and peer access while allowing normal
   sign-in. Validate browser sandbox and both supported image architectures. Do not weaken protections
   to make a test pass; a failed boundary blocks release.
5. Human completes Microsoft sign-in/MFA in the real dev viewer, confirms their visible account,
   imports the primary calendar, and observes a later background refresh. Prove desktop Firefox
   and a phone path with keyboard/IME and MFA prompts. Use executable live DOM/network assertions;
   screenshots are not acceptance evidence. No production instance is a test target.
6. Install from the published candidate image into empty storage. It has no developer profile,
   binding, address, event or credential. Verify legacy-disabled and runtime-disabled installs,
   update/uninstall, backup exclusions and complete per-owner cleanup.

Email ingestion, Outlook writes, multiple calendars, native Windows/macOS runtime hosts, automated
MFA and silent account switching remain outside this build.
