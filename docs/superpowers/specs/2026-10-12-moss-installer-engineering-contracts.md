# Moss onboarding engineering contracts

Date: 12 October 2026  
Status: proposed contracts and research companion for spec review  
Read with: [2026-10-12-moss-installer-build-spec.md](2026-10-12-moss-installer-build-spec.md), which contains the product requirements and stable User Story numbers  
Source pin: `b8edd4569b2de20c86ee7d86d1f917b17772c587`

This document selects proposed technical boundaries and evidence needed to build the approved experience. It is deliberately not the repository's executable implementation plan. This requested documentation PR publishes the two documents for review and handoff only; it does not authorize product implementation, installation, issue publication, merging or deployment. Moss requires an approved spec and an authorized task issue before that plan is written. Candidate slices below express scope, ownership and dependencies for review only; they do not create tickets, reserve agents or authorize execution.

All example names and paths below are generic product/repository names. No real credentials, personal host paths, inbox identities or machine configuration are included.

## 1 Decision ledger

| ID  | Decision                                                                                                           | Status and reason                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Docker helper prepares host and Notes, then opens the regular system browser at Account                            | Approved product boundary. No long-lived desktop application shell or embedded account/provider-auth webview                                         |
| D2  | Mac/Windows launchers, Linux/headless helper and self-managed Compose are v1                                       | Approved scope. Exact certified OS/version combinations remain a release matrix, not a promise of all systems                                        |
| D3  | Default first-run publishing is loopback-only; remote browser uses verified HTTPS or its own SSH forward           | Proposed implementation of the approved protected-connection requirement; no raw-LAN credential fallback                                             |
| D4  | Every fresh owner uses a host-issued one-use setup code and protected bootstrap session                            | Proposed concrete host-possession mechanism. Clean browser URL; name/password remain the ordinary Account form                                       |
| D5  | One immutable owner UUID, genuinely absent email, established password/session machinery                           | Proposed auth architecture. Must pass real vendor-consumer compatibility proof before rollout                                                        |
| D6  | Installation identity, credential creation, owner designation and claim consumption share a serialized transaction | Proposed replacement for relying on a post-create hook; session delivery can recover after commit                                                    |
| D7  | Dedicated settings-owned revisioned setup record; canonical modules retain real settings/connections               | Proposed persistence boundary. Existing instance onboarding state is only a compatibility projection                                                 |
| D8  | Account-authorized source grants plus runtime read/write proof before Notes activation                             | Proposed closure of the current global-root/privacy/readiness gap                                                                                    |
| D9  | Shared supported capability catalogs; ACP discovery is data, never executable authority                            | Proposed normalization over existing Settings/module seams; retain current supported methods                                                         |
| D10 | Deterministic installer and wizard; zero new AI-authored decisions or mutations                                    | Selected implementation boundary. AI does not choose paths, edit Compose, decide identity or infer preferences                                       |
| D11 | Existing no-Docker desktop epic remains separate                                                                   | [#2316](https://github.com/motioneso/moss/issues/2316) and its embedded PostgreSQL/Electron plan are not activated, replaced or changed by this spec |

The repository's generic AI-planning requirements do not justify inventing AI jobs here. State transitions, permissions, copy selection, configuration, readiness and navigation are deterministic. Existing optional News ranking and user-requested AI features remain behind their own established module/model contracts.

## 2 Verified baseline and source map

Every repository link in this section is pinned. It establishes what was read, not live runtime proof. New names in later sections are proposed interfaces, not claims that those interfaces already exist.

| Seam                     | Verified fact                                                                                                                                                            | Source                                                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth configuration       | Better Auth email/password enabled; shared users, auth accounts and session tables; secure-cookie behavior depends on configured proxy trust                             | [auth index 356–451](https://github.com/motioneso/moss/blob/b8edd4569b2de20c86ee7d86d1f917b17772c587/packages/auth/src/index.ts#L356-L451)                     |
| First-user bootstrap     | Registration gate permits initial bootstrap; advisory lock occurs in the after-hook; Better Auth commits user/credential/session separately and hook failure compensates | [auth index 522–713](https://github.com/motioneso/moss/blob/b8edd4569b2de20c86ee7d86d1f917b17772c587/packages/auth/src/index.ts#L522-L713)                     |
| Current email constraint | Initial user schema requires a unique non-null email                                                                                                                     | [0001 app schema 19–24](https://github.com/motioneso/moss/blob/b8edd4569b2de20c86ee7d86d1f917b17772c587/infra/postgres/migrations/0001_app_schema.sql#L19-L24) |
| Password/access helpers  | Existing hash/verify utility, credential presence and browser/companion revocation are available; extending reset still requires explicit work                           | [auth index 59–63 and 240–299](https://github.com/motioneso/moss/blob/b8edd4569b2de20c86ee7d86d1f917b17772c587/packages/auth/src/index.ts#L240-L299)           |
| Deployment publishing    | Current application port is broadly published; adding an extra loopback port would not remove it                                                                         | [production Compose 203](https://github.com/motioneso/moss/blob/b8edd4569b2de20c86ee7d86d1f917b17772c587/infra/docker-compose.prod.yml#L203)                   |
| Setup option forwarding  | Current setup service forwards image/TLS options rather than every supported Notes, UID/GID, port and origin option                                                      | [production Compose 327–343](https://github.com/motioneso/moss/blob/b8edd4569b2de20c86ee7d86d1f917b17772c587/infra/docker-compose.prod.yml#L327-L343)          |

Additional source and test anchors are listed in section 12. The main conclusion from the source is material: the new UX requires backend and host work. It is not a restyle of the current wizard.

## 3 Host preparation contract

### 3.1 Trust and process boundary

A trusted, version-pinned release provides a narrow local helper. A shared deterministic core owns plan validation and reconciliation; platform adapters own Docker discovery, native folder selection, official prerequisite flow and default-browser launch. The implementation may choose packaging technology during the authorized feasibility work, but it must not depend on a resident privileged daemon or a general-purpose web command API.

Use structured arguments and fixed operation names. Never interpolate shell commands from a browser, vault path, registry row or fetched page. Only a reviewed host plan can cause Compose execution. Sanitized environment and explicit process arguments select the Docker endpoint, project, file set and env file; ambient `DOCKER_HOST`, `DOCKER_CONTEXT`, `COMPOSE_FILE`, project names and shell variables must not silently redirect work.

Privilege is separate from the normal helper. Each necessary privileged change is identified and approved by the user through the platform's standard flow. The unprivileged helper does not retain passwords or elevate the entire application. Docker membership/service changes and vendor terms are visible prerequisites, not implicit consequences of Continue.

### 3.2 Host installation record

Proposed protected host record, schema version 1:

| Field                        | Contract                                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `installationId`             | Immutable random identifier generated once for this deployment; persisted in backend and host state                             |
| `planRevision`, `planDigest` | Versioned, validated non-secret plan; every material host/path/config change creates a new revision                             |
| `route`                      | `local`, `server`, or `manual`; records presentation intent, not permission                                                     |
| `hostBinding`                | Actual Docker endpoint and daemon identity, context label, OS/architecture and runtime account; label alone is insufficient     |
| `deploymentBinding`          | Exact Compose project, ordered file set, profiles, env-file location, pinned image reference/digest and named-volume identities |
| `notesIntent`                | `external`, `managed`, or `later`; external realpath and directory identity are private host data; no preauth root listing      |
| `connectionPlan`             | Exact intended origin, local bind address/port and permitted verified continuation mode; no claim/code or password              |
| `phase`                      | Last durably acknowledged phase plus current non-secret operation/result; a click is not a completed phase                      |
| `operationId`                | Stable ID for an in-flight fixed operation, with expected plan digest and bounded result                                        |
| `secretReferences`           | Locations/identifiers of protected secret storage only; never raw secrets or key fingerprints intended as authentication        |

Host records and env files use user-private permissions (0600 on Unix, equivalent owner ACL on Windows) and atomic write/replace with durability checks. A per-deployment OS lock serializes concurrent helpers. The lock owner/expiry record is not evidence that the operation finished; a crash requires actual-state reconciliation.

Before every apply/resume, compare the target endpoint/daemon, installation identity, exact project/file set and plan digest. A mismatch pauses for a new reviewed deployment decision. No automatic adoption, migration or cleanup of another deployment is permitted.

### 3.3 Lifecycle and fixed operations

Proposed phases:

`chosen → prerequisites_checked → notes_planned → reviewed → config_committed → images_ready → services_started → runtime_ready → browser_handoff → owner_bound`

A phase may also be `needs_action`, `failed` or `unknown`, retaining its last acknowledged predecessor. Failure is not a reset to `chosen`. Secret generation is a one-time protected sub-operation of configuration creation; an existing complete secret set is reused, a partial/missing set needs explicit recovery, and an existing deployment's secrets are never regenerated automatically.

Fixed operations are: inspect prerequisites; validate Notes intent; render/review plan; prepare/resume that plan; inspect runtime readiness; issue/revoke bootstrap code; open/print continuation; and separately review/apply a later Notes mapping. There is no arbitrary exec operation and no browser-triggered Docker operation.

Every mutating operation receives the expected installation ID, plan revision/digest and operation ID. It reports acknowledged phase, bounded error code, changed resources and next allowed action. Repeat requests reconcile the same operation. A reused ID with a different payload is rejected. Cancellation stops new phases where possible and reports already-created services/files; it does not claim rollback.

### 3.4 Configuration and startup

The renderer forwards every reviewed value, including runtime UID/GID, bind port, trusted origin, image pin and Notes mapping. Validate the **effective merged Compose configuration**, not merely the generated fragment:

- Exactly the intended application publishing exists and it is loopback-only before owner claim. No wildcard IPv4/IPv6, duplicate inherited public port or alternate direct credential route remains.
- Database/runner service exposure and management endpoints remain private as required by their existing topology.
- External Notes uses a long-form bind with `create_host_path: false`, precise read/write scope and no mount over private managed vault storage.
- No Docker socket, host root, whole home, credential/system tree or broad deployment directory is exposed to Moss.
- Original stable keys, env file, project and named volumes are retained across restart/recreation. No `down -v`, prune or automatic image change.
- File paths are serialized as data with control-character rejection and platform-aware handling. A path that no longer identifies the reviewed directory fails before apply.

Required readiness is a structured conjunction: intended installation identity; database reachable; migrations successful and supported schema; API operational; required runner healthy. Selected Notes host scope is additionally checked as mounted/accessible, with owner-specific activation still pending. AI login, email, News and Sports are optional and cannot block runtime readiness.

Poll with backoff, show the last verified phase and allow manual Check again. After bounded waits, report the specific unresolved readiness component; do not mark ready or retry destructive operations simply because a timeout elapsed.

### 3.5 Browser handoff

The local wrapper opens the OS default browser only after readiness. It opens a clean Account route and displays the one-use code in the helper for manual copy/paste. No code is appended to the URL, passed to the browser process as an argument, copied automatically to a shared clipboard, or stored in a general log.

A headless helper prints a clean address and separate short-lived code. If remote access uses an SSH forward, the user establishes it with their existing SSH setup, on the browser computer; the helper provides destination/port instructions without collecting SSH secrets. The continuation origin must match the exact registered origin, including an alternate forwarded local port.

The helper may remain as a simple local status window or exit after handoff. Browser setup must not depend on it remaining open. Reissuing a code is a host operation, not a public reset endpoint. Existing owners get ordinary sign-in and server-saved resume instead of a new code.

## 4 Protected bootstrap and owner authentication

### 4.1 Transport and origin enforcement

New endpoints join the application's existing trusted-origin and credential rate-limit mechanisms explicitly. Exact accepted origins, allowed Host values, proxy peer trust, cookie flags and transport modes are derived from the reviewed deployment configuration. A client-supplied forwarded header, URL scheme, `isSecureContext`, private IP or checkbox is not proof.

Credential/private-state operations fail closed for raw LAN HTTP, unknown proxy trust, mismatched Host or origin, unsupported direct routes, cross-origin requests and DNS rebinding attempts. A non-sensitive recovery page may explain how to connect. Preauth metadata contains only bounded readiness and public installation identity, never owner identity, vault paths, module preferences or detailed host diagnostics.

Test actual cookies and origin behavior separately for same-host loopback, SSH-forwarded browser loopback, trusted HTTPS and transition from loopback to HTTPS. HTTPS requires the correct Secure cookie behavior. Loopback bootstrap must have a deliberately validated local cookie configuration; moving origin may require sign-in again, while server progress survives. No CSRF/origin check is disabled to make the route work.

### 4.2 Code, session and owner state

The host generates a CSPRNG code with at least 128 bits of entropy, formatted for copy/paste. Only its verifier hash is persisted by the backend. It expires ten minutes after issue, is bound to one installation, code generation and exact continuation origin, and is displayed once by the host. Reissue serializes with claim/owner creation, revokes all prior unused generations and bootstrap sessions, and refuses if an owner already exists.

State is `issued → browser_bound → consumed`, or `expired/revoked`. Exchange binds at most one bootstrap session. The browser session is short-lived, HttpOnly and SameSite, transport-appropriate, origin-bound and restricted to bootstrap status/owner creation. It has no general user/session privilege. It cannot outlive the code's absolute expiry or extend it through polling.

Apply the credential endpoint limiter and additional failed-exchange limits per source and installation. Proposed initial budgets are five failed exchanges per minute per source and thirty per minute per installation, with uniform errors, bounded audit events and explicit load/denial-of-service review. These are configuration values to validate, not an invitation to disable limits for local traffic.

If the exchange response is lost, first check for the scoped bootstrap cookie. If absent, the host can reissue; replay must not mint additional browser sessions. No user-entered code is stored as a resume draft.

### 4.3 Proposed HTTP contracts

These routes are proposed. Wire formats should live in the shared public contract package and be validated at both boundaries; owning modules control their implementation.

| Operation                        | Input                                                                     | Output and authority                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `GET /api/setup/readiness`       | No secret; expected public installation ID may be compared                | Minimal readiness/version/protected-route status; no owner/host-private data; errors remain unknown   |
| `POST /api/setup/claim/exchange` | Code, expected installation ID and stable request ID over verified origin | Restricted bootstrap cookie and expiry; uniform failed exchange; no raw code in response              |
| `GET /api/setup/claim/status`    | Bootstrap cookie                                                          | Bound/expired/revoked/owner-created state; no established owner identity to an unauthenticated caller |
| `POST /api/setup/owner`          | Name, password and operation ID; valid bootstrap session                  | Owner identity transaction result and normal session if issued; no email required                     |
| `POST /api/auth/sign-in/owner`   | Password, correct installation origin; server resolves the one owner UUID | Existing normal session and normal account-status checks; generic rejected-credential response        |
| Host `issue/revoke code`         | Fixed trusted host operation; expected installation and generation        | One-use code shown locally or acknowledgment; no web issue/reset endpoint                             |

All credential endpoints use no-store responses and secret/body redaction. CSRF, origin and input checks precede state changes. Type definitions must prohibit credential fields in general setup draft types. All old email/social/OIDC paths that could create the first owner must require the same verified first-owner authority before identity creation, or be unavailable while the installer-managed instance is unclaimed. A secure new endpoint alongside open legacy bootstrap is a release failure.

### 4.4 Transaction and failure behavior

Under one database serialization boundary, recheck installation and code generation, absence of any bootstrap owner, current bootstrap-session authority and the intended operation. Atomically persist the UUID-keyed user, password credential, owner designation/pointer, claim consumption, the installation-intent-to-owner association, initial setup record and successful bootstrap audit. An invariant or unique constraint must prevent more than one bootstrap owner, beyond an application-only check. A populated database with no bootstrap owner is a recovery condition, never a fresh-claim candidate. Current legacy tests deliberately allow signup-based recovery in that state; replacing it requires a reviewed host-guarded repair/migration path and compatibility tests, not deleting those tests or silently reopening initial signup.

This must be a real shared transaction using the established privileged auth boundary, not a second transaction inside the current Better Auth after-hook. Respect module-owned public audit functions and database-role restrictions; do not grant the ordinary Settings runtime access to password tables to achieve it.

After commit, issue the normal session through the established session machinery. If that step or the response fails, retain the committed owner and consumed claim. The same browser reconciles its session; otherwise it signs in as owner with the chosen password. Do not delete a valid owner because cookie delivery failed, replay account creation or reopen initial signup. Store no password for retries. If identity commit fails, no owner credential or privileged session may survive.

The feasibility proof must demonstrate the actual vendor library/session consumer accepts a genuinely absent email. If it cannot, stop and review the adapter boundary; no synthetic address or username plugin workaround is allowed. Any alternate crash-safe protocol requires explicit review and must prove that an orphan account/session cannot claim or access owner data.

### 4.5 Schema and migration boundary

Proposed logical changes, with exact DDL reserved for the authorized implementation plan:

- Immutable installation identity with one optional bootstrap-owner UUID, enforced uniqueness and explicit schema/journey compatibility versions.
- Nullable/absent owner email through user storage, DB types, public DTOs, session serialization, profile/admin/export rendering and every vendor consumer. Present-email uniqueness and existing account links are preserved.
- Explicit local-owner credential mode resolving the existing credential/hash authority by immutable user UUID. No second user identity or parallel password store is introduced.
- Hashed bootstrap claim, generation, expiry, bound-session identity and terminal operation metadata under auth ownership.
- Dedicated revisioned setup progress under Settings ownership, and explicit Notes source ownership/grants.
- Guarded self-delete accepts a no-email owner's explicit immutable-target confirmation and current credential/re-authentication requirement; legacy `confirmEmail` remains supported for legacy accounts. Removing the email field must not remove destructive-action confirmation.

Use additive migrations and verified pre-migration backup/restore procedures. Preserve user IDs, grants, source links, stable encryption/auth keys, sessions where compatible and existing email/social accounts. Never rewrite applied migration history. A failed migration leaves the application closed to unsafe bootstrap and reports recovery, not a new empty-owner state. Publish a minimum compatible binary/schema fence; an automatic image downgrade is not a safe database rollback.

### 4.6 Guarded recovery and administrative targets

Unify target checking across reconcile, password reset, delete-user-data, restore and key rewrap. Independent expected installation ID and owner UUID must match the actual exactly-one owner under the operation's transaction/lock. A UUID is target confirmation, not operator authentication; the sanctioned host/admin execution boundary remains required. Zero, multiple, missing or mismatched targets fail closed except a narrowly defined, genuinely empty fresh installation before any ownership exists.

For legacy installs, retain existing email confirmation until an explicit authenticated/host-authorized migration records the owner UUID and installation identity. Do not substitute a value queried in the same operation as its own independent confirmation. Fix the existing reconcile `LIMIT 1` ambiguity gap rather than copying it.

Password reset changes only the intended existing credential, requires exactly one affected credential row, uses hidden terminal input or protected IPC, and prohibits plaintext argv. It atomically updates the credential, records the audit and revokes all supported existing authentication access: browser sessions, legacy bearer sessions/bindings and paired/companion credentials as applicable. Recheck identity inside the lock, then verify a new sign-in and rejection of old access. The current echoing prompt/argv path and lack of full reset revocation are new work to replace, not safe behavior to inherit.

Email-free accounts never enter fallback email verification/reset/notification sends. Test this at the last sender boundary. A later optional recovery-email feature requires separate explicit enrollment, verification and delivery support; connecting an inbox does none of those.

## 5 Durable setup and navigation contract

### 5.1 Owner record

Use a dedicated Settings-owned record rather than expanding the existing global `onboarding.state` value into a multiuser draft:

| Field                        | Proposed meaning                                                                                           |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Key                          | Composite installation ID and immutable owner UUID, with one journey record                                |
| `journeyVersion`, `revision` | Compatible schema/journey version and monotonic compare-and-swap revision                                  |
| `status`                     | `pending`, `completed` or legacy-compatible `skipped`; terminal state is not overwritten by stale requests |
| `lastSavedScreen`            | Stable meaningful screen/subscreen identity, not an array index inferred from current readiness            |
| `steps`                      | Visited and deliberate saved/skipped decisions, separate from live capability status                       |
| `drafts`                     | Strictly allowlisted non-secret incomplete user input; no arbitrary JSON payload passthrough               |
| `resourceRefs`               | Canonical provider/connection/source and pending host-change references, not duplicated settings           |
| `pendingOperations`          | Bounded resource/action/request references and last acknowledged results, never secret payloads            |
| `completedAt`                | Set only by a committed completion transition                                                              |

RLS/authorization must prevent another account reading the row or inferring private drafts/references. Installation mismatch is a distinct rejection. An existing member never inherits the owner's journey.

Proposed API: authenticated owner `GET /api/onboarding/progress`, `PATCH /api/onboarding/progress` with `expectedRevision` and stable `operationId`, and an extended completion operation taking the expected journey revision. Retain `GET /api/onboarding/status` and existing complete/skip callers through explicit compatibility adapters; do not let global legacy writes overwrite another owner's record.

A stale revision returns a typed conflict with safe current saved state. Same operation ID and payload return the acknowledged result; a different payload under that ID is rejected. Where a canonical module's own mutation has an uncertain outcome, reconcile that module's state first, then advance the checkpoint. Do not claim an atomic transaction across external OAuth, filesystem operations and the progress database.

### 5.2 Resume, settings and concurrency

After authentication, load the owner's acknowledged checkpoint before deriving navigation, then refresh canonical resources. Failed reads retain last-known content visibly unverified and disable dependent edits. The wizard does not create default provider/source/preferences to fill a missing response.

Keep browser-local secrets in current credential-screen memory only; clear them on success, exit, origin change, sign-out or account change. Optional non-secret in-memory drafts may survive a transient request failure, but only acknowledged server data is promised after browser kill. Do not silently replay credentials on reconnect.

Each pending action is bound to installation, actor, resource, operation and initiating navigation generation. Late results can reconcile the same owner's resource after navigation but cannot change the current route without authority. Account changes invalidate private caches and callbacks. Completion and global finish share one same-account pending authority, preserving the shipped recovery behavior.

Settings and onboarding operate on the same underlying values. Canonical resource revisions prevent a stale wizard save from undoing a newer Settings change. Where an existing API has no version contract, extend that owned API or explicitly reconcile/review before committing; client timestamps alone are not CAS.

### 5.3 Completion

Ready reads canonical saved state and presents the expanded recap. Unresolved optional capabilities may remain skipped/failed/unknown with truthful consequences; unresolved required identity, transport, runtime readiness or an explicitly pending host recreation blocks completion.

Completion serializes the journey revision and terminal transition. A duplicate request returns the terminal acknowledgment without a second action. Unknown outcome triggers readback. If committed, show Open Today or navigate only when the original owner and navigation generation still apply. Never run host preparation, reconnect services, generate content or silently clear unsaved choices as a side effect.

## 6 Notes ownership and read/write readiness

### 6.1 Scope and binding

The host's pre-account external path or managed-folder intent is private installation data. Bind its opaque intent reference to the verified installation/owner inside the owner-creation transaction. Actual canonical source creation, filesystem preparation and probing happen afterward as idempotent owner-authorized operations. Only then permit account-private enumeration or ingestion under the granted scope. A source grant must be checked on directory listing, direct requests, preference reads, Notes tools, background indexing/jobs, status and exports. The host-global allowlist remains necessary but is not the permission model.

The managed source is one idempotent private owner directory. Onboarding must never expose, select or grant the entire multiuser vault root as a Notes source. Preserve the existing backend’s legitimate canonical private-vault storage mount and its account isolation; this requirement does not remove that storage. Failure retains intent and an existing working source; retry uses the same owner/intent rather than creating more directories. For legacy global roots, migrate only independently established exact account-source scopes and explicitly legitimate shared grants. Ambiguous/unowned roots require authenticated host/operator review; a saved path is not permission to grant its parent/global root to every account. Include cross-account migration, export and indexing negative tests.

The external mount contract continues to recognize `JARVIS_NOTES_VAULT_HOST_PATH` to `/data/external-notes`, but new generated binds use long syntax and strict existence checks. Grant only the reviewed directory. Reject host root, whole home, system/credential roots, unexpected aliases and path injection. Revalidate realpath/directory identity at selection, apply and probe to address symlink/mount time-of-check/time-of-use changes. Do not recursively change existing vault permissions.

### 6.2 Probe and activation

A proposed authenticated `POST /api/onboarding/notes/verify` takes an owner-visible candidate source ID, expected source/intent revision and operation ID, never an arbitrary host path. Server code uses the real runtime UID/GID and the authorized source resolver.

After disclosure, check read/list access and create a uniquely named temporary file exclusively in an authorized location, write/read a bounded sentinel, then remove that exact file safely. Never overwrite or test by editing an existing note. Bind cleanup to the created file identity, not an unchecked later path. A cleanup failure is `cleanup_required`, includes a private owner-visible location/recovery action and is not a successful readiness result.

Typed states: `not_configured`, `unavailable`, `missing`, `disallowed`, `read_denied`, `read_only`, `verification_unknown`, `cleanup_required`, `ready_rw`. Only `ready_rw` allows activating the replacement. Indexing has separate `not_started/running/failed/complete` status and does not hold up Continue after readiness.

A later mount edit has a saved owner checkpoint, approved host plan revision and explicit Compose recreation using the original project/file set/keys/volumes. The helper validates the owner target guard before recreation. On return, reauthenticate if necessary, verify the intended installation and new mount/source and then activate it. Existing selected subfolders within an already authorized mount need no host recreation. Existing Restart cannot be repurposed to claim new mount application.

## 7 Shared capability and preference boundaries

### 7.1 Provider and email adapters

Proposed shared descriptors include stable provider/method ID, label/verified logo, supported installation platforms, prerequisites, required disclosure, supported connection-flow kind, runtime status and per-feature readiness. They are authored by the existing Settings/connector/ACP authorities and consumed by both Settings and onboarding. UI featured ordering is presentation metadata, not a forked provider implementation or popularity score.

Connection state separates available, installed, authenticating, authenticated, model-discovery and feature-ready. A server-reported readiness result is timestamped and can become unknown/stale without deleting the saved connection. Existing supported auth sessions own their secrets and expiries; setup progress stores only a bounded reference.

Registry discovery is a read-only official feed joined by stable identity to reviewed, pinned Moss install definitions. Failure retains known supported choices with a stale-discovery notice. Unsupported entries get an honest integration-needed state. No registry-provided executable command, icon/script URL or version becomes privileged execution authority.

Local endpoints are tested from the Moss server. Validate scheme, target, redirects and credentials through a bounded server-request policy: permit only explicitly approved local-model destinations for that connection; reject metadata services, unrelated internal targets and credential-bearing URLs; revalidate DNS/address changes; constrain timeouts/response sizes and strip secrets from errors. Local-network support does not justify a general SSRF proxy. Model discovery and actual chat/structured-output capability determine readiness.

Retain the current Google Desktop/manual-return flow and exact Gmail/Calendar permission disclosure. Do not invent a one-click callback or generic Gmail device flow. Proton Bridge and IMAP prerequisites use actual backend reachability and TLS validation. Connected inbox identity, connection status and sync status are separate. Before retrying a lost connect response, read back canonical connections to avoid duplicates.

### 7.2 Location and preferences

Propose a supported server-side city-to-IANA-timezone resolver behind the existing weather-location search/Settings boundary. Pick a deterministic maintained lookup or bounded service with explicit provenance and failure behavior during implementation planning; do not infer the mapping from browser or server timezone. The interface returns selected place identity/coordinates, canonical weather location and derived IANA timezone, or `mapping_unavailable`.

Persist timezone provenance as `location`, `manual`, `browser_suggested` or `explicit_utc`. A saved manual override is independent from the weather city; Use location time zone deliberately switches back. For a genuinely absent preference, initialize Fahrenheit once. Do not overwrite saved units during migration/resume.

Canonical preference saves and checkpoint advancement report partial outcomes correctly. A saved city and failed timezone update must show precisely that state, not roll back the city or show a false all-saved badge. Search does not request geolocation permission. Existing timezone-based weather fallback is retained and visibly identified in skip/recap/Today.

### 7.3 News and Sports

Use current News catalog/effective-default behavior and its custom label/guidance model. Custom topic creation requires usable structured output plus web search, with data-processing context disclosed. Protect the ten-topic cap under concurrent requests with a per-owner transaction/lock or equivalent invariant; the existing count-guarded insert without demonstrated concurrency serialization is not sufficient proof. A stable create-operation key/readback must prevent duplicate topics after response loss. Save and first refresh remain distinct outcomes.

Sports uses stable provider/team/league IDs, one shared saved-follow state and request-scoped pending authority. Partial catalog coverage is distinct from successful empty search. Preserve existing pause/reduced-motion behavior if any rotating shared component is reused; the onboarding screen itself has no carousel.

## 8 Platform and distribution acceptance

This is a proposed certification policy, not a claim of released installers or completed tests. All three host families remain in the initial release. A failed platform gate pauses that platform/release; silently relabeling it unsupported to finish the project requires an explicit product-scope decision.

| Route                | Proposed initial certification                                                                                            | Required proof before claiming support                                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| macOS local          | Apple silicon and Intel on a vendor-supported macOS release; release manifest enumerates exact tested OS/Desktop versions | Signed/notarized helper and clean-machine trust; official Docker path and consent; native picker; runtime file sharing; system-browser launch; reboot/resume                         |
| Windows local        | Windows 11 x86_64, supported servicing version, Docker Desktop Linux containers on WSL 2                                  | Signed publisher/trust flow; WSL/virtualization and reboot recovery; ACL/private storage; Windows paths with spaces/Unicode; actual Linux-container UID and file access              |
| Linux/headless       | Ubuntu 24.04 LTS on amd64 and arm64 as the first bounded distro target, Docker Engine plus Compose plugin                 | Official package/source verification; explicit service/privilege steps; UID/GID and path validation; terminal resume; separate-browser SSH/HTTPS; signed/checksummed helper artifact |
| Self-managed Compose | Same tested image architectures and runtime feature minimums; independent of the launcher                                 | Reviewable pinned template; host-only secrets; complete option forwarding; effective binding/mount checks; identity/claim/recovery parity                                            |

Before release, record exact minimum and tested maximum Docker Engine/Desktop/Compose versions and required features in a versioned manifest consumed by the helper and CI. Reject unknown/unsupported capability combinations with an official-guidance/manual route. Do not invent universal support from the current multi-architecture image build.

Docker's [Mac documentation](https://docs.docker.com/desktop/setup/install/mac-install/) supports Apple silicon/Intel and uses a rolling current-plus-two macOS policy. Its [Windows documentation](https://docs.docker.com/desktop/setup/install/windows-install/) distinguishes Windows servicing support and WSL prerequisites; Windows Arm remains a distinct support tier rather than assumed x86 parity. Docker's [Ubuntu instructions](https://docs.docker.com/engine/install/ubuntu/) support a concrete Engine/Compose installation path. Recheck these vendor requirements when freezing the release matrix; vendor eligibility is necessary but is not Moss certification.

Rootless Docker, remote Docker contexts, Windows Arm, Windows Server, non-Ubuntu distributions and unusual network/NFS vaults are not silently certified by this proposal. Detect them and provide truthful instructions or the reviewed manual path; an unsupported combination must not run untested privileged automation. Support may expand through its own host/readiness/Notes proof.

New distribution work is required. The existing Trail Marker application is a separate macOS companion, with unsigned/unnotarized local-build instructions; it is not a Docker installer or Windows/Linux packaging foundation. A release must provide signed/notarized Mac artifacts, verified Windows publisher artifacts and checksum/signature verification for Linux, all tied to an immutable release/version manifest. Do not use an insecure web page to supply executable update/install commands.

No updater is required to complete onboarding. If later updates change privileges, origins, schema or host mappings, they are separate reviewed operations with compatibility/rollback policy. A browser warning is never a reason to instruct “run anyway.”

## 9 Public test seams and release gates

These are proposed test boundaries for approval with the spec. Each deliberately tests a public behavior. For every claimed security protection, record an observed negative control: the relevant assertion must fail when that protection is deliberately removed or disabled in the isolated test path, and the test must follow the protected value to its real consumer. Merely observing a denied adversarial request with the protection enabled is insufficient. Remove test bypasses afterward; no production disable switch or weakened release configuration may remain. Tests may double a true external process/service boundary for deterministic failures, but must not substitute mocked Moss persistence/API responses for the assembled live path.

| Public seam                                         | Behavior tested and why a broken implementation fails                                                                                | What it does not prove                                                                         |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Plan validator and effective-configuration verifier | Wrong daemon/project, changed path, inherited wildcard binding, missing image pin or forbidden mount must reject the plan            | That a real Docker daemon applies the configuration or the OS trust flow works                 |
| Host prepare/resume interface                       | Kill/restart at each receipt boundary preserves deployment/key/volume identity; concurrent invocation cannot duplicate work          | Real OS privilege, Docker Desktop licensing or native picker behavior without target-host runs |
| Bootstrap/auth HTTP and database boundary           | Two simultaneous claims yield one owner; old signup routes cannot bypass it; lost cookie response never reboots identity             | Stock library absent-email support unless the real installed vendor consumer is exercised      |
| Owner-password and guarded-reset public paths       | Real absent-email sessions survive restart; wrong/ambiguous target fails; reset rejects every prior access path                      | Third-party social-provider behavior without the relevant live provider flow                   |
| Setup progress/CAS and completion API               | Stale revision fails, duplicate operation reconciles, wrong actor/installation is denied, terminal state cannot regress              | Browser route/focus behavior; test those through the UI                                        |
| Canonical source access and verification port       | Another account cannot list/read/index/export; read-only and cleanup failure cannot become ready; replacement preserves prior source | Host bind correctness without a real mount/runtime-UID test                                    |
| Shared capability projection                        | Missing install/login/model/feature never becomes ready; stale discovery remains distinguishable from empty                          | Real provider authorization or chat execution without the installed provider path              |
| Location resolver and canonical save interface      | Unselected place/mapping failure/manual override/unit preservation produce independent correct outcomes                              | Accuracy of an external timezone service without bounded known-location checks                 |
| Existing News/Sports public APIs                    | Concurrent tenth-topic boundary and response-loss retry never exceed cap/duplicate; partial sports search is truthful                | Actual provider/source freshness without a live retrieval                                      |
| Browser route and view contracts                    | Newer navigation/account switch outlives old results; skips retain saved choices; focus/dialog/history remain correct                | Database atomicity or deployment safety by itself                                              |

### Gate G0 First feasibility proof

Before detailed planning of later phases, prove the smallest real Linux/manual end-to-end path with the selected auth boundary: a fresh protected deployment, code exchange, genuinely email-free owner creation, normal owner sign-in/session, skip-to-Today and guarded recovery after restart. Use real database/vendor-session paths and actual browser cookies. The proof must also deny a simultaneous claim, old signup bypass, raw-LAN credential route, mismatched installation and ambiguous owner. Populated/no-owner installer state must stay closed; separately prove a sanctioned host-guarded replacement for the existing legacy signup-recovery behavior before retiring it.

**Kill criterion:** if true absent-email vendor/session handling, atomic first-owner authority, host identity preservation or safe reset/restart cannot be demonstrated without weakening an invariant, stop the affected approach. Do not proceed with polished downstream screens around an unproven auth path. The designated implementation coordinator/security owner records the failing assertion and routes a bounded adapter/architecture proposal to spec review. No fallback fake email, open signup, broad cookie/origin disablement or no-email recovery omission is accepted.

Native packaging feasibility may proceed independently with inert install-only UI and fixed-operation stubs; it cannot claim real installation or unblock G0. Later phase detail waits for G0's recorded ruling, consistent with the repository process.

### Gate G1 Identity and migration

Pass fresh no-email owner, legacy password owner, OAuth-only owner, member, empty instance, populated/no-owner corruption, multiple-owner corruption and wrong expected target fixtures. Exercise signup → logout/login → normal restart → Compose recreation → guarded reset → old access rejected → same owner data returned. Test legacy email target confirmation before migration and UUID/installation confirmation after. Confirm no unintended mail at the final sender boundary.

### Gate G2 Installation and transport

On every claimed target, verify effective ports from both host and another machine, Docker endpoint identity, stable keys/volumes/project, dependency/image pins and correct mount behavior. Pin dependency images as well as the Moss image; preserve the existing bounded container capabilities and per-user CLI UID isolation instead of expanding or disabling them for convenience. Exercise blocked privileges/terms, stopped daemon, port conflict, reboot and killed helper. Test loopback, SSH-forwarded loopback and trusted HTTPS with real sessions; incorrect Host/origin/proxy/DNS-rebinding inputs fail. Required readiness cannot be green while DB/migration/API/runner is unhealthy.

### Gate G3 Durability and ownership

Prove browser close/reopen, second-device sign-in, API/container restart, two-tab conflict, delayed mutation, account switch and stale completion. Test owner-scoped Notes enumeration, direct access, jobs/status and export across two accounts. Probe cleanup failure leaves a visible action and no ready replacement. A finished optional external operation can update saved state without hijacking navigation.

### Gate G4 Capability and first-use behavior

Run each advertised supported provider/connector path on the installed build. Verify ready versus background-only/unavailable states, local server reachability, exact Google permission/return behavior, real mailbox identity and separate sync. Test News effective defaults and concurrent custom-topic cap/idempotency, Sports identity/partial catalog and all-skipped Today. The release does not advertise unsupported API-key or local chat based on #3411's design document. If a local chat path is still unimplemented, its prominent discovery entry must remain truthfully unavailable/background-only, and the acceptance record must identify that limitation; adding chat requires its reviewed runtime dependency, not a UI flag.

### Gate G5 Accessibility and release evidence

Check normal and recovery panels at 320px, 390px and desktop, 200% zoom, keyboard-only and representative screen-reader use. Verify live reduced-motion change and light/dark/park-theme contrast. Signing, artifact integrity, exact support manifest, fresh install and legacy upgrade/recovery evidence are required for every claimed release route. An uninstall/removal flow, if included, must leave services, config, data and user Notes intact unless an independently confirmed destructive removal is designed.

### Verification procedure and evidence status

Use the repository's current verify-gate skill as the command authority. Database-touching aggregate verification runs through `scripts/run-gate.sh start`, then `scripts/run-gate.sh wait --follow`, with its isolated throwaway database. Interpret exit 0 as pass, 1 as fail and 2 as dead. Do not use bare database-touching tests/migrations, pipe the gate or copy the older redirected `pnpm verify:foundation` recipe from plan-build. Browser CI is separate from local foundation green.

Future user-facing work needs `tests/uat/specs/<slug>.uat.spec.ts` and the coordinator UAT trigger-map entry. Each slice records its installed live check, build/commit reference, run reference, exit verdict and bounded executable/DOM/network/log assertions. Screenshots, test counts, intercepted Moss API responses and source inspection are not assembled-path evidence. A true external service stand-in must be disclosed and cannot prove provider authorization it did not perform.

No build, DB, browser-auth, Docker, platform or live-provider test has been run as part of this document task. All gates above are proposed acceptance obligations. Until actual evidence passes, the status is a reviewed specification or, later, code-complete/unverified, never released/Done.

## 10 Candidate vertical slices and parallel ownership

This is a scope/dependency review map in the style of Matt Pocock's to-tickets skill. It is not a step-by-step implementation plan. Slice granularity and dependencies need approval before any tracker publication. Exact files, exported signatures, migration DDL, commands and detailed phase sequencing belong in the later authorized repository plan. Each slice below includes tests and a live proof of the behavior it claims.

| Candidate                     | Blocked by                                                           | What it delivers                                                                                                          | Acceptance and live proof                                                                                                                                    |
| ----------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S0 Prove protected owner path | Approved spec/task/plan prerequisites                                | G0 tracer proof using the current DB/auth stack and one Linux/manual deployment, plus fixed host-plan boundary            | Real absent-email owner/session/restart/reset; one claim winner; alternate signup denied; no arbitrary host target; failure invokes G0 stop decision         |
| S1 Resume owner setup         | S0 accepted contracts                                                | Durable six-section browser journey, safe skips, expanded recap and idempotent completion, including existing-owner entry | Reopen in another browser, survive API/container restart, two-tab conflict and stale completion/account switch; all-skipped owner reaches Today              |
| S2 Personalize first Today    | S1 progress contract                                                 | Canonical addressed/assistant name, city-to-zone provenance, manual override and temperature-unit behavior                | Real saved preferences drive Today; city changes preserve override; resolver/partial-save failures and browser fallback are truthful                         |
| S3 Connect private Notes      | S0 host/identity contract; S1 checkpoint contract                    | Pre-start external/managed intent, owner binding, actual read/write probe and deliberate later recreation                 | Existing empty vault and managed folder both work; second account denied; missing/read-only/cleanup error retained; prior source survives failed replacement |
| S4 Ship macOS preparation     | S0 shared host contract; S3 Notes plan contract                      | Signed/notarized thin Mac preparation wrapper with native picker and normal-browser handoff                               | Clean supported Mac, Docker absent/stopped/ready, consent/denial and reboot; exact host folder; browser account flow; helper can close                       |
| S5 Ship Windows preparation   | S0 shared host contract; S3 Notes plan contract                      | Signed thin Windows preparation wrapper, WSL/virtualization handling and native picker                                    | Clean supported Windows, reboot/privilege failure recovery, Windows/WSL path boundaries, runtime access and browser handoff                                  |
| S6 Add supported AI choices   | S1 progress contract                                                 | Shared Settings/onboarding capability view, existing supported auth flows and truthful ACP/local discovery                | Real supported provider reaches verified chat; installed/no-login, key/no-chat, unsupported registry and unreachable local endpoint remain honest            |
| S7 Connect existing email     | S1 progress contract                                                 | Shared supported email descriptors and reused provider flows with permissions and sync distinction                        | Google current manual-return, one supported IMAP path and reachable Bridge condition; wrong-account/canceled/lost-response states recover                    |
| S8 Save News and Sports       | S1 progress contract; S6 capability interface for custom topics only | Existing effective News choices/custom topics and stable Sports follows through the wizard                                | Concurrent cap-ten, duplicate retry, refresh failure, partial sports search and repeated follows; recap reflects canonical saved state                       |
| S9 Certify complete release   | Applicable S1–S8; G0–G4                                              | Published tested support matrix, trusted release artifacts, upgrade/recovery rehearsal and whole-journey proof            | G5 plus all claimed platform/capability tests; no unsupported platform or feature described as ready                                                         |

S4/S5 may do isolated packaging feasibility before S3 completes, but may not independently modify the shared host contract. S6/S7 do not wait for desktop packaging. S8's ordinary News/Sports choices do not wait for a usable AI provider; only the custom-topic operation depends on verified structured-output/web-search capability. Local/API-key chat implementation is an explicit dependency if the desired route is not shipped; it is not hidden inside an onboarding UI ticket.

### Ownership boundaries

Assign a single owner per shared boundary and keep parallel lanes on feature-specific surfaces:

- **Host-core owner:** shared plan/renderer/record contract and production/Notes Compose templates. Mac and Windows owners consume it through fixed typed operations; neither edits core files opportunistically.
- **Identity owner:** auth bootstrap/session compatibility, claim/rate-limit wiring and shared target guard. Guarded CLI call-site changes coordinate through this owner; unrelated lanes cannot add alternate signup behavior.
- **Progress and UI integrator:** setup repository/routes, the common wizard/navigation shell, application route/app-map integration and completion authority. Feature lanes add isolated screen/adapters against agreed props/public contracts, not concurrent edits to the wizard root.
- **Notes owner:** source grants, access resolver, probe/activation and canonical source UI. It requests host-plan changes through the host-core owner and identity binding through the identity owner.
- **Feature owners:** personalization, AI, email, News/Sports own their canonical adapters and isolated screens/tests. Shared catalog/DTO barrel changes go through their designated single owner.
- **Migration/release integrator:** reserves migration identifiers, reviews role/RLS grants and assembles cross-lane schema changes. Applied migrations are immutable; no two lanes assign the same number or edit one migration in parallel.
- **Independent review:** separate Standards and Spec review against a pinned diff plus security/installed-path proof review. The coordinator owns final QA/merge/tracker transitions under the repository process.

These are responsibilities, not additional horizontal “build all database, then all UI” tickets. Each candidate still delivers a narrow end-to-end user behavior. If a refactor is necessary, scope it to the smallest contract extraction and prove existing behavior first; do not import the executing setup generator merely to reuse its functions.

## 11 Requirement traceability and review checklist

The new story IDs retain all substantive approved acceptance obligations without copying the historical feedback archive.

| Approved design acceptance                      | New stories          | Contract/gate               |
| ----------------------------------------------- | -------------------- | --------------------------- |
| 1–6 journey, optionality and useful Today       | 1–2, 6, 10–12, 41–57 | Sections 3, 5, 7; G0/G4     |
| 7–12 security, ownership and secret handling    | 13–22, 28–29         | Section 4; G0/G1/G2         |
| 13–19 saved state and navigation                | 23–30, 53–56         | Section 5; G3               |
| 20–26 truthful AI/email behavior                | 41–48, 52            | Section 7; G4               |
| 27–34 Notes/host mapping                        | 5–9, 36–40           | Sections 3/6; G2/G3         |
| 35–40 interests, location and accessible design | 31–35, 49–60         | Sections 7/9; G4/G5         |
| Expanded installer route/lifecycle matrix       | 1–15, 19–20, 23, 40  | Sections 3/4/8; G0/G1/G2/G5 |

Before approving the spec, confirm:

- The Docker-first helper-to-normal-browser boundary and all three host families remain the selected initial scope.
- D3–D9 proposed technical contracts are acceptable, including code exchange and real no-email compatibility/transaction proof.
- Public test seams and G0's stop condition have a named implementation/review owner once work is authorized.
- Candidate slice size/dependencies are sensible; no issue has been published by this document task.
- Release evidence will identify exact platform/version support instead of inferring it from Docker documentation or image build jobs.
- The separately reviewed private prototype and design materials remain outside this public repository. These two documents preserve self-contained requirements; any public import of design assets needs its own authorization.

## 12 Additional source and test anchors

The following supplemental map is pinned to the same source revision. Reinspect at the actual implementation baseline before writing the executable plan; mutable main or a PR title is not a contract.

### Existing implementation anchors

| Area                         | Pinned source and relevance                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Setup renderer inputs        | [setup generator](https://github.com/motioneso/moss/blob/b8edd4569b2de20c86ee7d86d1f917b17772c587/scripts/setup-prod.ts#L1), [Notes mapping 10–17](https://github.com/motioneso/moss/blob/b8edd4569b2de20c86ee7d86d1f917b17772c587/scripts/setup-prod-notes.ts#L10-L17), [TLS/origin helpers 115–198](https://github.com/motioneso/moss/blob/b8edd4569b2de20c86ee7d86d1f917b17772c587/scripts/setup-prod-origins.ts#L115-L198). Generator import has side effects; extract deterministic logic before reuse                                                                                                                               |
| Existing startup ordering    | [startup plan 178 onward](https://github.com/motioneso/moss/blob/b8edd4569b2de20c86ee7d86d1f917b17772c587/scripts/start-jarv1s.ts#L178). Preserve runtime/migration/reconcile ordering; do not introduce a competing supervisor for container internals                                                                                                                                                                                                                                                                                                                                                                                   |
| Current Notes mount          | [Notes Compose](https://github.com/motioneso/moss/blob/b8edd4569b2de20c86ee7d86d1f917b17772c587/infra/docker-compose.notes.yml#L1). Current short syntax is not the required existence-safe new renderer                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Target guards                | [shared target guard 55 onward](https://github.com/motioneso/moss/blob/b8edd4569b2de20c86ee7d86d1f917b17772c587/packages/db/src/target-identity-guard.ts#L55), [reconcile guard 138–194](https://github.com/motioneso/moss/blob/b8edd4569b2de20c86ee7d86d1f917b17772c587/scripts/module-reconcile.ts#L138-L194). Shared guard rejects ambiguity; reconcile currently selects only one owner                                                                                                                                                                                                                                               |
| Reset deficiencies           | [reset input/update/audit 29–85](https://github.com/motioneso/moss/blob/b8edd4569b2de20c86ee7d86d1f917b17772c587/scripts/admin-reset-password.ts#L29-L85). New hidden-input and complete access revocation requirements are not already implemented                                                                                                                                                                                                                                                                                                                                                                                       |
| Identity consumers           | [DB user type 37–49](https://github.com/motioneso/moss/blob/b8edd4569b2de20c86ee7d86d1f917b17772c587/packages/db/src/types.ts#L37-L49), [UserDto 4–6](https://github.com/motioneso/moss/blob/b8edd4569b2de20c86ee7d86d1f917b17772c587/packages/shared/src/platform-api.ts#L4-L6), [user schema 259–275](https://github.com/motioneso/moss/blob/b8edd4569b2de20c86ee7d86d1f917b17772c587/packages/shared/src/platform-api.ts#L259-L275), [self-delete 85 onward](https://github.com/motioneso/moss/blob/b8edd4569b2de20c86ee7d86d1f917b17772c587/packages/shared/src/me-api.ts#L85)                                                        |
| Credential routing           | [server throttle routes 880 onward](https://github.com/motioneso/moss/blob/b8edd4569b2de20c86ee7d86d1f917b17772c587/apps/api/src/server.ts#L880), [auth route 951 onward](https://github.com/motioneso/moss/blob/b8edd4569b2de20c86ee7d86d1f917b17772c587/apps/api/src/server.ts#L951). New endpoints require explicit limiter inclusion                                                                                                                                                                                                                                                                                                  |
| Current onboarding lifecycle | [shared DTO 12 onward](https://github.com/motioneso/moss/blob/b8edd4569b2de20c86ee7d86d1f917b17772c587/packages/shared/src/onboarding-api.ts#L12), [status route 516 onward](https://github.com/motioneso/moss/blob/b8edd4569b2de20c86ee7d86d1f917b17772c587/packages/settings/src/onboarding-routes.ts#L516), [complete/skip 879–917](https://github.com/motioneso/moss/blob/b8edd4569b2de20c86ee7d86d1f917b17772c587/packages/settings/src/onboarding-routes.ts#L879-L917), [repository lifecycle 647 onward](https://github.com/motioneso/moss/blob/b8edd4569b2de20c86ee7d86d1f917b17772c587/packages/settings/src/repository.ts#L647) |
| Reusable CAS pattern         | [preferences repository 16–140](https://github.com/motioneso/moss/blob/b8edd4569b2de20c86ee7d86d1f917b17772c587/packages/structured-state/src/preferences-repository.ts#L16-L140), [notification-only CAS port 11 onward](https://github.com/motioneso/moss/blob/b8edd4569b2de20c86ee7d86d1f917b17772c587/packages/settings/src/preferences-port.ts#L11). Reuse the pattern without pretending all canonical ports already have CAS                                                                                                                                                                                                       |
| Completion navigation guards | [wizard 93–150](https://github.com/motioneso/moss/blob/b8edd4569b2de20c86ee7d86d1f917b17772c587/apps/web/src/onboarding/onboarding-wizard.tsx#L93-L150). Actor-scoped pending mutation and current-account/requested-URL guards are shipped behavior                                                                                                                                                                                                                                                                                                                                                                                      |
| Source access gap            | [Notes roots/list 43–132 and routes 156 onward](https://github.com/motioneso/moss/blob/b8edd4569b2de20c86ee7d86d1f917b17772c587/packages/settings/src/notes-source-routes.ts#L43-L193). Authentication plus global roots is not an account-grant/read-write probe                                                                                                                                                                                                                                                                                                                                                                         |
| Location gap                 | [weather location DTO 41–52](https://github.com/motioneso/moss/blob/b8edd4569b2de20c86ee7d86d1f917b17772c587/packages/shared/src/weather-api.ts#L41-L52), [locale routes 23–54](https://github.com/motioneso/moss/blob/b8edd4569b2de20c86ee7d86d1f917b17772c587/packages/settings/src/locale-routes.ts#L23-L54). Lat/lon/label and locale save do not establish city-to-zone provenance                                                                                                                                                                                                                                                   |
| Provider truth               | [Settings catalog](https://github.com/motioneso/moss/blob/b8edd4569b2de20c86ee7d86d1f917b17772c587/apps/web/src/settings/settings-ai-provider-catalog.ts#L1), [ACP definitions](https://github.com/motioneso/moss/blob/b8edd4569b2de20c86ee7d86d1f917b17772c587/packages/acp/src/providers.ts#L1), [API-key chat rejection 59](https://github.com/motioneso/moss/blob/b8edd4569b2de20c86ee7d86d1f917b17772c587/packages/chat/src/live/chat-session-provider-identity.ts#L59). [#3411](https://github.com/motioneso/moss/pull/3411) remains design-only at the inspection                                                                  |
| Email authorities            | [shared IMAP domains](https://github.com/motioneso/moss/blob/b8edd4569b2de20c86ee7d86d1f917b17772c587/packages/shared/src/imap-providers.ts#L1), [server presets](https://github.com/motioneso/moss/blob/b8edd4569b2de20c86ee7d86d1f917b17772c587/packages/connectors/src/imap-presets.ts#L1), [Google connection service](https://github.com/motioneso/moss/blob/b8edd4569b2de20c86ee7d86d1f917b17772c587/packages/connectors/src/google-connection.ts#L1). Normalize metadata; reuse service behavior                                                                                                                                   |
| News concurrency target      | [topic create 458 onward](https://github.com/motioneso/moss/blob/b8edd4569b2de20c86ee7d86d1f917b17772c587/packages/news/src/personalization-repository.ts#L458), [personalization routes](https://github.com/motioneso/moss/blob/b8edd4569b2de20c86ee7d86d1f917b17772c587/packages/news/src/personalization-routes.ts#L1). The observed count-guarded insert without demonstrated concurrency serialization and uncertain retry behavior need tests; no concurrency defect was live-reproduced in this review                                                                                                                             |
| Build/distribution evidence  | [CI image matrix 450–469](https://github.com/motioneso/moss/blob/b8edd4569b2de20c86ee7d86d1f917b17772c587/.github/workflows/ci.yml#L450-L469), [Trail Marker README 27 onward](https://github.com/motioneso/moss/blob/b8edd4569b2de20c86ee7d86d1f917b17772c587/apps/trail-marker/README.md#L27), [unsigned Release build 61 onward](https://github.com/motioneso/moss/blob/b8edd4569b2de20c86ee7d86d1f917b17772c587/.github/workflows/trail-marker-mac.yml#L61). Image architectures do not prove native installers                                                                                                                       |
| Separate desktop proposal    | [deferred desktop plan](https://github.com/motioneso/moss/blob/b8edd4569b2de20c86ee7d86d1f917b17772c587/docs/superpowers/plans/2026-09-05-moss-desktop-install.md#L1). Its no-Docker runtime is not assumed by this spec                                                                                                                                                                                                                                                                                                                                                                                                                  |

### Existing tests and compatibility changes

The first four suites below were read during source research, not executed. Other anchors are explicitly marked discovery-only.

- [Auth bootstrap recovery](https://github.com/motioneso/moss/blob/b8edd4569b2de20c86ee7d86d1f917b17772c587/tests/integration/auth-bootstrap-recovery.test.ts#L186): lines 186/215 intentionally allow a populated/no-owner signup recovery, including disabled registration. Installer bootstrap now requires fail-closed behavior plus a sanctioned host-guarded replacement for that legacy recovery. Lines 249/325/384 cover race/compensation/orphan cleanup and must be reconsidered against the true transaction boundary, not discarded.
- [Reconcile target guard](https://github.com/motioneso/moss/blob/b8edd4569b2de20c86ee7d86d1f917b17772c587/tests/integration/module-reconcile-target-guard.test.ts#L49): lines 49/55 distinguish genuine empty/trusted role; 66/76 missing/mismatched confirmation; 86 success; 96 populated/no-owner rejection. Extend with ambiguity and installation/UUID confirmation.
- [Onboarding recovery](https://github.com/motioneso/moss/blob/b8edd4569b2de20c86ee7d86d1f917b17772c587/tests/unit/audit-onboarding-recovery.test.tsx#L161): same-account remount 161, changed address 185, auth-before-props 233, pending remount 252, other-account isolation 270, skip/finish retry 284/296, concurrent skip 310. Preserve these behaviors under the new journey.
- [Onboarding integration](https://github.com/motioneso/moss/blob/b8edd4569b2de20c86ee7d86d1f917b17772c587/tests/integration/onboarding.test.ts#L356): completion audit 356, existing skip-replaces-complete semantics 383, member versus owner lifecycle separation 541. The proposed monotonic versioned terminal state is a deliberate compatibility change; define legacy projection behavior and update tests explicitly.
- [Setup Notes derivation](https://github.com/motioneso/moss/blob/b8edd4569b2de20c86ee7d86d1f917b17772c587/tests/unit/setup-prod-notes.test.ts#L1) and [Notes directory listing](https://github.com/motioneso/moss/blob/b8edd4569b2de20c86ee7d86d1f917b17772c587/tests/unit/notes-source-directories.test.ts#L1) were read. They prove env/listing logic, not actual host mounting, owner grants or runtime read/write.
- Discovery-only anchors to inspect before planning: `tests/unit/audit-source-truth.test.tsx`, `tests/unit/audit-source-connections.test.tsx`, `tests/unit/audit-source-vault-export.test.ts`; `tests/integration/settings-weather-location-search.test.ts`, `settings-weather-unit.test.ts`, `settings-locale.test.ts`; `tests/integration/news-personalization-routes.test.ts`, `news-personalization-repository.test.ts`; `tests/e2e/onboarding.spec.ts`; `tests/uat/specs/real-chat-onboarding.uat.spec.ts`; `tests/uat/specs/1571-weather-location-and-units.uat.spec.ts`.

### Development process authorities

- [Matt to-spec 7–75](https://github.com/mattpocock/skills/blob/49dd158d1076134a641b33efb035946536778336/skills/engineering/to-spec/SKILL.md#L7-L75): synthesize the discussed product decisions, numbered user stories, module/test seams; no new interview.
- [Matt to-tickets 25–105](https://github.com/mattpocock/skills/blob/49dd158d1076134a641b33efb035946536778336/skills/engineering/to-tickets/SKILL.md#L25-L105): end-to-end slices and approved dependencies before tracker publication.
- [Moss plan-build 15–144](https://github.com/motioneso/moss/blob/b8edd4569b2de20c86ee7d86d1f917b17772c587/.claude/skills/plan-build/SKILL.md#L15-L144): approved spec plus task issue before plan; exact seam evidence, contract-oriented plan, phase live checks and kill criterion.
- [Moss coordinated-build 90–153](https://github.com/motioneso/moss/blob/b8edd4569b2de20c86ee7d86d1f917b17772c587/.claude/skills/coordinated-build/SKILL.md#L90-L153): tracked spec/plan and coordinator responsibilities.
- [Moss verify-gate](https://github.com/motioneso/moss/blob/b8edd4569b2de20c86ee7d86d1f917b17772c587/.claude/skills/verify-gate/SKILL.md#L1): authoritative isolated database checks and gate verdicts.
- [Development Standards 53–213](https://github.com/motioneso/moss/blob/b8edd4569b2de20c86ee7d86d1f917b17772c587/docs/DEVELOPMENT_STANDARDS.md#L53-L213): real installed path, public-repository hygiene, app-map and security consumer evidence.

The checked-in Moss tree has no `.agents/skills` and does not vendor Matt's skill collection at this pin. This does not establish what is installed globally on a developer's machine. The document uses the inspected current upstream skill shape while respecting Moss's stronger local gates.
