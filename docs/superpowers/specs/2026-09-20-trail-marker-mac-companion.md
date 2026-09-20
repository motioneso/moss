# Trail Marker: Mac companion connection foundation

Date: 2026-09-20
Status: specification for review; product decisions agreed in the design interview, visual direction supplied by Ben. No product implementation is included in this change.
Tracking: [#2560 — Build Trail Marker: native Mac companion connection foundation](https://github.com/motioneso/moss/issues/2560). This spec is separate from the Moss desktop-server packaging project.

## 1. Outcome and scope

A user installs **Trail Marker**, enters the URL of their Moss instance, signs in and approves linking through the default browser, and sees this Mac identified in Moss's existing **Active sessions** section. They can disconnect without logging out, reconnect, log out, and revoke that Mac from Moss.

The app is a native SwiftUI/AppKit menu-bar utility for macOS 14+, supporting Apple silicon and Intel through one universal download. Its descriptor is **A Moss companion**; Moss displays **Trail Marker for Mac**.

This release builds the connection foundation, not the activity feature. It has no screenshot capture, Accessibility content reading, activity classification, model calls, coaching, task access, chat access, files access, or observation uploads. The Python/Swift Jev pilot remains a separate experiment and must not be packaged into the app. It supplied feasibility evidence, not production authentication or privacy architecture.

One macOS user's app process has one linked account on one instance. There is no account switcher or saved account collection; log out before changing either. An account can link multiple Macs, each with separate credentials and independent revocation. Different macOS users have separate local settings and Keychain items. Do not use hardware serial numbers as device identity.

## 2. Design source and precedence

The supplied source was located at `~/Jarv1s/docs/specs/Trail Marker`, with lowercase `docs/specs`. The approved package is included alongside this specification so the design does not depend on an untracked directory in another checkout:

- [Design guide](../../specs/Trail%20Marker/trail-marker-design-guide/DESIGN_GUIDE.md)
- [Approved reference board](../../specs/Trail%20Marker/trail-marker-design-guide/reference/trail-marker-approved.png)
- [Platform-neutral tokens](../../specs/Trail%20Marker/trail-marker-design-guide/tokens.json)
- [Swift starter tokens](../../specs/Trail%20Marker/trail-marker-design-guide/DesignTokens.swift)
- [Canonical Moss mark](../../specs/Trail%20Marker/trail-marker-design-guide/assets/moss-mark.svg)
- [Design handoff](../../specs/Trail%20Marker/trail-marker-design-guide/README.md)

Use the approved Trail Marker guide, not the older mockup README's alternative-direction recommendation. Behavioral requirements in this spec and accessibility take precedence over generated labels or geometry in the reference board. The board still contains generic “Moss Companion” labels and “Last synced”; implement **Trail Marker** and **Last successful contact**, since v1 does not sync content.

Native app requirements:

- Use native controls, system UI typography, focus rings, semantic status colors and light/dark backgrounds. No web wrapper or embedded Moss application.
- Use forest, bone and restrained gold for onboarding and supporting art. Keep everyday menus/settings calm and native.
- The three-line Moss mark is the only logo. Use a monochrome template image in the menu bar; do not invent a leaf/tree emblem or redraw its geometry.
- Editorial serif treatment is limited to supplied onboarding artwork/brand presentation, not form controls, settings or menus.
- One settings window with Connection, This Mac, Permissions and Updates sidebar destinations.
- Reference dimensions: onboarding about 680 pt wide; settings about 780 × 560 pt with a 196 pt sidebar; menu/popover about 320 pt wide. These are targets, not fixed sizes that override accessibility.

Browser approval and Active sessions are Moss web surfaces: reuse the existing `@moss/ui` components, authored `jds-*` primitives and web tokens. The native design palette does not authorize introducing raw colors or a second CSS design system into Moss.

## 3. First-run and browser linking

1. Show **Connect your Mac to Moss**, a URL field, one-account-at-a-time explanation, and **Connect in Browser**.
2. Validate the URL, then verify the instance supports the companion protocol. Distinguish unreachable, incompatible, invalid URL and insecure remote URL. Preserve the entered URL on failure.
3. Open an approval page on that same instance in the default browser. Existing Moss login methods and account approval/deactivation rules apply; never collect the user's password in Trail Marker or copy browser session cookies.
4. The app shows **Waiting for browser approval**, Cancel and Open Browser Again. The browser page shows **Link Trail Marker to Moss?**, account name/email, current device name, and the limited requested access: account identity and this device's connection. Approval is explicit even if the browser is already signed in.
5. On successful approval/exchange, persist the companion credential in Keychain and enable the connection. Cancelling or rejecting never leaves an active unclaimed device credential. Late results from cancelled or replaced linking attempts cannot change the current account.
6. Offer device setup: editable name defaulting to the Mac computer name, Start at login off by default, and optional Accessibility/Screen Recording permission setup.
7. Show the instance, account, device name and verified Connected state, then leave the app in the menu bar. If the network fails after linking, show Reconnecting rather than false success.

The initial name can be supplied during link initiation, then changed in device setup. Do not show an editable name at browser approval that silently binds to a different device or account.

### URL boundary

- Require HTTPS for remote instances. Permit HTTP only for literal `localhost`, `127.0.0.1` and `[::1]` on this Mac. Do not accept lookalike hostnames or arbitrary LAN HTTP addresses.
- Preserve valid ports and supported deployment base paths. Reject user-info credentials, query strings and fragments in the instance base URL.
- Use normal platform certificate validation, including explicitly trusted local CAs. No “ignore certificate errors” switch.
- Pin pairing and subsequent authenticated calls to the confirmed instance origin/base path. Never forward credentials across a redirect to another origin or downgrade HTTPS to HTTP.
- Do not have the Moss server fetch arbitrary instance URLs on behalf of clients. Compatibility discovery is performed by the Mac against the URL the user entered.

## 4. Connection state and controls

Persist connection enablement separately from the credential and account identity. A credential existing in Keychain does not by itself mean Connected.

| State            | Meaning                                                   | Primary action                          |
| ---------------- | --------------------------------------------------------- | --------------------------------------- |
| Not linked       | No linked account/credential                              | Set Up Trail Marker                     |
| Connected        | Enabled, authenticated, recent successful contact         | Disconnect                              |
| Disconnected     | User deliberately disabled communication                  | Connect                                 |
| Reconnecting     | Enabled, temporarily unable to reach Moss                 | Retry Now; Disconnect remains available |
| Sign-in required | Credential expired/revoked, or account no longer eligible | Sign In or Log Out                      |

Browser approval waiting is a setup state, not a sixth steady connection state. Local credential-access failures must be presented as actionable local errors, not misreported as server revocation.

- **Disconnect:** persist disabled state first, cancel pending network work and timers, and ignore late responses. Keep identity and Keychain login. Never automatically re-enable after restart, network recovery, update, permission grant or wake. Future observation must also stop, with no activity queue for later upload.
- **Connect:** deliberately enable communication and verify identity/credential before showing Connected. Expired or revoked credentials lead to Sign-in required.
- **Quit:** close the process and cancel work; preserve login and enablement preference. Quitting a connected app does not mean the user selected persistent Disconnect.
- **Log Out:** stop connection work, remove the local credential and linked account, and attempt bounded server-side revocation. Local logout succeeds even without connectivity. If remote revocation is unconfirmed, say so and point to Active sessions in Moss. Do not retain a secret solely to retry revocation later.
- **Start at login:** off by default, user-controlled through the native login-item mechanism. Starting the app respects saved enablement. App launch does not start observation.
- **Automatic recovery:** only while enabled. Network failures preserve credentials and use bounded retry/backoff. Authentication rejection stops retries and requests sign-in. Do not interpret every TLS, timeout or server error as expired credentials.
- **Sleep/wake:** suspend background work; revalidate after wake only if enabled. No backlog or burst of replayed operations.

Disconnect promises no automatic network activity: pause instance requests and automatic update checks while disconnected. Explicit Open Moss, Check Now or Log Out actions may perform the specific user-requested operation; they do not re-enable background communication. Explain this in supporting settings copy. UI and backend must not imply that bytes already sent before cancellation can be recalled.

Server revocation takes effect on the next authenticated request. An enabled Mac must discover it within its normal contact interval while reachable. A disconnected/offline Mac cannot learn of revocation until it reconnects. Moss must show last contact, not promise real-time presence or immediate visible changes on an offline Mac.

## 5. Settings: complete v1 inventory

All preferences are local to this Mac/macOS user unless explicitly identified as account/device metadata. No cross-Mac settings sync.

| Section     | Item                               | Behavior/default                                                                     |
| ----------- | ---------------------------------- | ------------------------------------------------------------------------------------ |
| Connection  | Instance URL                       | Read-only while linked; changing requires Log Out                                    |
| Connection  | Account name/email                 | Authenticated identity; cached display while offline, not proof of a live connection |
| Connection  | Status and last successful contact | Explicit icon and text, meaningful offline/never-contacted states                    |
| Connection  | Connect / Disconnect               | Reflect durable enablement and current state                                         |
| Connection  | Retry Now                          | Enabled recovery only; must not override manual Disconnect                           |
| Connection  | Log Out                            | Remove local login; clearly report unconfirmed remote revocation                     |
| This Mac    | Device name                        | Editable; default computer name; server validates bounded plain text, no markup      |
| This Mac    | Start at login                     | Off initially; show native registration failures and recovery                        |
| Permissions | Accessibility                      | Native status and permission/settings action; optional                               |
| Permissions | Screen Recording                   | Native status and permission/settings action; optional                               |
| Updates     | Installed version/build            | Available offline                                                                    |
| Updates     | Automatically check for updates    | On by default; suspended while manually disconnected                                 |
| Updates     | Check Now                          | Explicit check against official release channel                                      |
| Updates     | Available update                   | Version/summary, Install and Restart, Later                                          |
| Updates     | Failure/details                    | Retry and safe copyable diagnostics                                                  |

A name edit while disconnected is saved locally with clear “applies when connected” feedback; do not silently contact Moss. Device identity is an opaque installation identifier, not the display name. Relinking after logout gets a new authorization, even if the local installation identity or display name is retained.

No model, API-key, screenshot interval, focus-goal, distraction-threshold, activity-history or coaching settings in this release. No placeholder feature toggles that imply working observation capabilities.

## 6. Permission setup

Ben explicitly requested permission setup at initial setup/launch, despite observation being deferred.

- Explain Accessibility and Screen Recording, expose the corresponding native request/settings actions, and allow **Skip for Now**. Request each permission after its explanation, not by triggering capture or reading another app's content.
- Required copy: **These permissions prepare future capabilities. Trail Marker is not observing your activity.**
- Missing permissions do not block linking, Connected status or any v1 account/device action.
- Preflight status on subsequent launches; do not repeatedly open system prompts after a skip/denial. Settings always offers the recovery action.
- Use what the OS can actually report. Do not invent a distinction between “never requested” and “denied” where the native API exposes only granted/not granted; both have a useful settings route.
- Do not request microphone, camera, Input Monitoring, Full Disk Access, browser automation or notification permissions for this foundation release.
- Verify actual behavior on macOS 14+; local development and final signed builds may have different permission identities. Keep the final bundle identity stable.

## 7. Menu and accessibility

Menu order follows the supplied guide: status, instance/account, state-specific action, Open Moss, Settings, Check for Updates, Log Out when linked, Quit Trail Marker. Separate status, navigation, account actions and Quit. Disconnect is reversible and not destructive/red; Log Out and web revocation use appropriate confirmation/styling.

Support native keyboard focus/order, Return/Escape behavior, VoiceOver labels, Reduce Motion, Reduce Transparency, Increase Contrast, and usable text sizing. Status must never rely on color alone. Use semantic system backgrounds in light/dark appearance. Settings and setup must remain usable if translated text or accessibility settings increase content size.

Generated board labels are not production copy. Use the exceptional-state language in design guide section 13, with safe technical details behind **View Details** rather than raw error strings in primary messages.

## 8. Moss account/device integration

Extend **Settings → Profile & account → Active sessions** with a **Mac companions** group. Each entry shows device name, **Trail Marker for Mac**, Mac platform/app version where useful, and last successful contact. No new competing device-management settings area.

- One row per companion authorization/device. Two identical names must remain independently selectable/revocable; do not feed companion rows into the existing browser-session grouping by display name, browser, OS and IP.
- Existing **Sign out device** semantics apply to the selected companion only. **Sign out all others** also revokes companion authorizations while preserving the current browser session.
- Account deletion/deactivation and administrative session-revocation behavior must include companion credentials through the auth boundary. This confers no admin access to private user content.
- A user sees/revokes only their own connections. Cross-account identifiers return the same result as nonexistent identifiers.
- Add **Download Trail Marker for Mac** beside the group. Before a public artifact exists, show honest availability rather than a broken download or an unnotarized build labelled ready for everyone.
- Remote disconnection means authorization revocation and subsequent Sign-in required, not the Mac's reversible local Disconnect preference.

## 9. Architecture and authentication requirements

This section specifies required behavior and recommended boundaries, not existing security guarantees. New protocol details must be reviewed and executable security checks must demonstrate them before implementation is called complete.

### Existing seams inspected

| Source                                                | Finding / required reuse                                                                                                                                                |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/auth/src/index.ts`                          | Better Auth owns browser login; current general bearer path delegates to legacy UUID session auth. Do not broaden it to accept unrestricted companion credentials.      |
| `packages/auth/src/session-service.ts`                | Auth-owned service lists/revokes cookie and legacy bearer sessions. Extend its public boundary for companion metadata/revocation; keep secret handling out of settings. |
| `packages/settings/src/me-sessions-routes.ts`         | Existing owner-scoped GET sessions, DELETE one, DELETE others routes; preserve current-session behavior.                                                                |
| `packages/shared/src/me-api.ts`                       | Existing safe session DTO; extend deliberately with source/product/device identity without exposing bearer credentials or hashes used to verify them.                   |
| `apps/web/src/settings/settings-profile-subviews.tsx` | Existing session grouping merges visually identical browser sessions; companion identity must bypass this grouping.                                                     |
| `packages/shared/src/app-map-core.ts`                 | Declare new approval screen, companion settings integration, requirements, errors and remediations in the implementation PR.                                            |

These sources do not provide a ready-made restricted companion login. A companion token must not become a general browser/CLI session merely to reuse its listing UI.

### Client

Use SwiftUI/AppKit, native Keychain, login-item and permission APIs, and platform networking. Keep view state, connection lifecycle, Keychain operations and transport separable enough to test the connection transitions without live network access. Do not create a general plugin system, cross-platform framework or local database for the foundation.

Store only credentials in Keychain, scoped to this app and macOS user; instance/account binding must accompany lookup so another account's credential cannot be selected accidentally. Persist ordinary preferences in the native preferences store. Exclude credentials from exports, diagnostics, process arguments and crash/error text. Never embed a shared client secret in the downloadable app.

### Backend and protocol

Keep plain Fastify REST and shared contracts under `packages/shared`. Auth-owned code owns pairing and credential persistence/revocation; composition wires it to the existing settings boundary. Do not import module internals or add fields to `AccessContext` to smuggle credential scope through general routes.

A bounded browser-approved device pairing flow must:

1. Discover protocol compatibility on the chosen instance without credentials or unnecessary user information.
2. Create an expiring pairing attempt bound to this app attempt and device. Open only the same-origin approval page in the browser.
3. Require ordinary authenticated Moss browser approval and CSRF/origin protection. Bind the approving account to that attempt on the server.
4. Let only the initiating app redeem approval once, with proof of possession of its attempt secret/verifier. Neither a public pairing identifier nor browser approval URL alone may redeem a credential.
5. Handle pending, approved, denied, cancelled, expired, already-redeemed and network-failed states explicitly. Bound polling/retries and rate-limit both creation and verification.
6. Exchange credentials directly between app and instance, never through browser query strings, telemetry or logs. A browser callback, if used, carries no long-lived credential and must be bound to the initiating attempt; polling may instead complete linking without a custom URL handler.
7. Store server-side credential verifiers rather than reusable raw credentials. Authorize only minimal identity, own-device metadata/heartbeat and own-device logout operations. Scope checks and account eligibility are enforced server-side on every call.
8. Reject companion credentials at unrelated Moss endpoints, including task/chat/file access, other-device management and admin APIs. Browser sessions remain the authority for approving/revoking other devices.
9. Enforce bounded expiry and revocation server-side; return enough machine-readable reason information for correct UI recovery without leaking another user's device existence.

Before the build starts, the implementation plan must select and document the concrete exchange (reuse a suitable maintained auth primitive if available), endpoint schemas, credential expiry/renewal policy and replay protection. Those mechanics were not chosen in the product interview; do not treat illustrative endpoint names or the pilot's API keys as an approved protocol. A general OAuth provider product is out of scope.

Use a low-frequency identity/heartbeat request while enabled to verify reachability and update last contact. The implementation plan should start at 60 seconds, bounded exponential retry up to five minutes with jitter, and immediate user-requested Retry. Last-seen remains an estimate; no WebSocket infrastructure is needed merely to show status. Do not write an activity event for every heartbeat.

New auth schema changes require a new migration, explicit runtime grants and owner-scoped operations, expiry/cleanup, and deletion/deactivation integration. Never edit applied migrations or grant runtime BYPASSRLS. Inspect both new and existing credential consumers before claiming isolation or revocation guarantees.

## 10. Updates and distribution

Official Moss releases supply updates, independently of the user-entered instance. Do not trust an instance-provided arbitrary binary/update URL. Use a maintained macOS updater with signed update verification where suitable; the implementation plan must name the dependency, feed and signing approach rather than hand-roll executable replacement.

Automatic checks are enabled initially; installation/restart always requires the user's action. Preserve the current connection preference across updates, including manual Disconnect. No update may silently re-enable connection or future observation. Compatibility metadata must prevent an update/install onto an unsupported OS and explain incompatible instance versions without collecting a credential first.

Delivery stages:

1. **Local development and live testing:** build/install on Ben's Mac without paid distribution membership. Document the developer installation process honestly; this is not the promised public installer experience. Verify Keychain, login item and permission behavior on the actual app.
2. **Public distribution:** universal signed/notarized/stapled installer, stable bundle identity, official download/update feed, update signing and a verified install/update path. Requires Apple Developer membership and protected signing/notarization secrets, plus a macOS build environment.

Ben approved building locally first and enrolling before public distribution; no purchase/enrollment has occurred or is authorized by this spec. Local acceptance must not be described as notarized distribution or verified automatic updating. Do not publish a half-working update button: local builds report development-build availability truthfully; production update behavior is a release gate.

Apple references checked during the interview: [enrollment](https://developer.apple.com/programs/enroll/) and [Developer ID](https://developer.apple.com/developer-id/). Apple listed US$99 per membership year or regional equivalent; verify at enrollment. There is no need to list the app in the Mac App Store for direct Developer ID distribution.

## 11. Failure handling and data boundaries

- Preserve URL/name edits on recoverable setup errors. Pairing cancellation cannot resurrect a prior account through a late result.
- Retry transient network/server failures only while enabled. Surface incompatible protocol, certificate failures and denied/revoked authentication distinctly.
- Disconnect/log out/quit cancel current work; stale responses cannot set Connected, rewrite credentials, rename another account's device or re-enable timers.
- Offline logout does not claim remote revocation. A lingering server row can be removed through Active sessions; it does not mean this Mac retained a credential.
- Permission denial and login-item registration failure are recoverable settings issues, not reasons to discard a valid account connection.
- Diagnostics are bounded and categorical. Never include passwords, cookies, bearer tokens, pairing secrets, authorization headers or raw server error bodies. Device names and instance URLs may themselves be sensitive; diagnostic export must be reviewed/redacted.
- No screenshot bytes, Accessibility text, app/window titles, keyboard input or activity history are collected. Granting OS access does not change this.
- Update/permission failures must not bypass authentication, reset settings, or silently fall back to an insecure origin.

## 12. Acceptance and verification

| Area                   | Required evidence                                                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Install/identity       | Actual Mac build launches from Applications; Trail Marker naming and official mark are correct; no terminal/Python/provider keys required for end-user setup.                                     |
| Pairing                | Real browser login/approval links the intended account and displays the named Mac in Active sessions; cancellation/denial/expiry leave no usable orphan credential.                               |
| Restart                | Keychain login and device name persist; Start at login defaults off and works when enabled.                                                                                                       |
| Disconnect             | Explicit Disconnect survives app/OS restart; mocked/instrumented transport proves no automatic requests; late replies cannot undo it.                                                             |
| Recovery               | Enabled offline app reconnects after recovery; disabled app remains disabled; revoked/expired credential requires browser sign-in.                                                                |
| Logout                 | Online revoke succeeds; offline local logout removes credential and explains remote uncertainty; another account/instance can then link.                                                          |
| Device isolation       | Two Macs with the same display name remain separate. Revoke one without affecting the other; revoke-all-others includes companions and preserves current browser.                                 |
| Restricted access      | Companion credential can use only intended identity/own-device operations; tasks/chat/files/admin and other-account operations fail. Approval replay and stolen public attempt identifier fail.   |
| Permissions            | Grant/deny/skip and later recovery work on Mac; setup succeeds without grants; no content read/capture occurs in any state.                                                                       |
| Settings/menu          | Every setting/action above works; five state labels are accurate; instance/account change requires logout.                                                                                        |
| Accessibility          | Keyboard, VoiceOver, light/dark, increased contrast, reduced motion/transparency and larger text verified.                                                                                        |
| Compatibility          | Valid remote HTTPS and literal local HTTP work; insecure remote URL, invalid certificate, redirect escape and unsupported protocol give useful errors.                                            |
| Updates/public release | User-controlled signed update preserves settings/Disconnect; tampered/incompatible update is rejected; clean-machine notarized install and both CPU architectures verified before public release. |

Tests must cover the actual auth boundary, not just UI labels or mocked token acceptance. Security tests must be observed failing when their protection is removed, with evidence recorded on the implementation PR. Use the repository's verify-gate skill for database-touching verification and required full checks. Live-path proof is executable assertions and bounded textual evidence through the actual UI/installed app, following repository standards; Linux tests cannot prove macOS behavior.

## 13. Build readiness and non-goals

Before implementation: review this spec's proposed protocol/operational defaults, create the linked implementation task, commit the spec/design package, and write a bounded implementation plan. The supplied guide and approved board are the visual authority; uncovered states must use the guide's native components and copy rather than invent a new direction.

The implementation PR must keep the app map truthful, include deployment changes for every newly required setting, and include the release note. No app-map entry should claim an unimplemented feature in this docs-only change.

Not included: the Moss server desktop bundle; Windows/Linux clients; account switching inside one running app; a feature/plugin marketplace; tasks/chat/file integration; model routing; screen observation; historical activity; focus nudges; notification permission setup; background data queues; cross-Mac preference sync; or a general-purpose OAuth platform.

Success for this round is **an installed, authenticated, controllable Mac identity in Moss**, with local live proof. Public-distribution completion remains a separate gate until signing, notarization and update delivery are verified.
