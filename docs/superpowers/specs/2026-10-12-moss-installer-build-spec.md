# Moss installer and owner onboarding specification

Date: 12 October 2026  
Status: proposed engineering specification for review  
Source baseline: Moss main `b8edd4569b2de20c86ee7d86d1f917b17772c587`  
Scope: new installation through the first useful Today view, plus safe resume for existing owners

This specification turns the approved Park Press onboarding experience into a reviewable product and engineering contract. A small host helper prepares Docker, the Notes mapping and running Moss services, then opens the normal system browser at Account. Account, personalization and every subsequent onboarding step stay in that browser. The helper is not the Moss application shell.

The selected experience is already established. Architecture described as **proposed** below is this document's engineering recommendation, not a claim that it is implemented or previously approved. The [engineering contract companion](2026-10-12-moss-installer-engineering-contracts.md) contains pinned source evidence, concrete data and API boundaries, release proofs and candidate work slices. This requested documentation PR publishes the specification and companion for review and handoff. It does not authorize product implementation, installation, issue publication, merging or deployment.

## Problem Statement

A new owner currently has to understand deployment, account setup and several disconnected Settings surfaces before Moss becomes useful. The existing setup generator assumes Docker is already available. Current production publishing and first-user signup do not establish that the person claiming a new installation controls its host. Existing authentication requires email, and current onboarding progress is an instance lifecycle rather than a durable owner-specific journey. A successful Notes preference save also does not establish account-authorized read/write access to the intended host folder.

The approved experience removes that burden without concealing it behind simulated success. It must work for a person installing on their own Mac or Windows computer, a Linux/headless home server, and someone who prefers a reviewable Docker Compose template. A domain, AI account and inbox must remain optional. Interruption, provider failure and a later container recreation must preserve the actual deployment and the owner's acknowledged choices.

The result should be easy to understand and safe to resume: one focused Park Press question at a time, real capability checks, a saved recap and a useful Today page. A polished screen is not sufficient if the installation can be claimed remotely, a restart locks out an email-free owner, or a second account can discover a private vault.

## Solution

### Host preparation and browser handoff

Begin with “Where will Moss live?” and three first-class choices:

- This computer: the Mac or Windows helper checks the actual Docker host, chooses Notes scope and prepares Moss.
- Another computer or home server: the helper runs on that host, including Linux/headless, and provides a protected browser continuation.
- I’ll manage Docker myself: a version-pinned, reviewable Compose bundle provides the same deployment, identity, secret-generation and protected-connection contract.

The helper checks prerequisites, records a protected non-secret installation plan, obtains necessary platform consent, applies the reviewed configuration, starts services and verifies readiness. Only then does it open the regular system browser at Account. A headless host prints the same clean continuation address for use over verified HTTPS or a user-established SSH forward. No helper-managed browser is required for account setup or provider authorization.

A short-lived, one-use host setup code verifies every fresh first-owner browser session. It is a security substate of Account, not another identity or a permanent setup password. The code is never placed in a URL. Existing installations instead require the established owner's sign-in and resume their own state.

### The browser journey

After the backend and connection are verified:

1. Account: “What should I call you?” and a password, without required email.
2. You: assistant name, then weather location and timezone.
3. AI: featured Claude, Codex and OpenCode plus an equally visible Local model path; all availability is verified for the installed runtime.
4. Email: optional connection to an existing inbox through its supported flow.
5. News: optional topics, publications and supported custom topics.
6. Sports: optional team and league follows.
7. Ready: an expanded saved recap with precise edit actions.
8. Get started: durably complete onboarding, then open Today.

Notes scope is chosen during host preparation. After Account, the prepared intent binds to the verified owner and is checked for read/write access. A targeted recovery view may appear, but the ordinary journey does not ask for the same folder again. Get started never performs first startup or a surprise mount recreation.

### Product boundaries

macOS and Windows launchers, Linux/headless and self-managed Compose are all initial-release requirements. Exact OS, architecture, distro and Docker version support must be published from a tested matrix; “Linux” does not promise every distribution. The first required Linux certification targets and platform expansion policy are proposed in the companion.

AI, Notes, email, News and Sports are independently optional. Account ownership, a protected connection and required backend readiness cannot be skipped. Missing optional capability must not prevent using the rest of Moss. The first Today page offers Start a chat only when chat really works; otherwise it offers Connect AI.

## User Stories

The numbers are stable review and acceptance references. Each story's conditions are requirements, including its failure path.

### Installation

1. As a new owner, I can choose this computer, another computer/home server, or self-managed Docker before providing account or provider credentials, so the instructions match where Moss will actually run.
2. As an existing owner, I can identify my existing deployment, sign in and continue saved setup without creating another owner, regenerating keys or adopting arbitrary discovered volumes.
3. As an installer user, I see the actual OS/architecture, Docker endpoint/context, daemon readiness, required container mode, port conflicts and existing deployment before host changes. Missing, stopped, unsupported and unknown are different states.
4. As an installer user, I explicitly approve required installation, privilege, service, group-membership, virtualization, reboot and legal actions. The helper does not silently elevate, accept Docker Desktop terms, replace Docker or promise licensing eligibility.
5. As a local owner, I choose a directory on the Docker host through its native picker. As a headless owner, I choose a path on the server. A browser picker on a different computer is never represented as a server bind mount.
6. As a Notes user, I can choose an existing Obsidian/Markdown folder, request a private Moss-managed folder or set up Notes later before Prepare Moss. Selection does not upload, move or reorganize my notes.
7. As an owner, I review the deployment destination, pinned version, Compose project, exact Notes scope and outstanding consent before Prepare Moss. A changed destination invalidates previous unexecuted checks.
8. As an owner, I can interrupt or retry preparation without duplicate deployments, regenerated secrets, lost volumes or silently upgraded images. Concurrent helpers cannot operate on the same deployment independently.
9. As an owner, I see actual preparation phases and the retained result of cancellation. A running container, elapsed timer or successful download alone does not mean Moss is ready.
10. As a headless owner, I can continue through trusted HTTPS or my own SSH forward without giving Moss my SSH credentials, buying a domain or exposing first-owner signup on the LAN or internet.
11. As a self-managed owner, I receive a pinned configuration with secret placeholders, host-only one-time secret generation and checks for the effective Compose configuration. My chosen options must actually reach the running application.
12. As an owner, I finish host preparation before the helper opens the normal system browser at Account. All remaining onboarding, including provider sign-in, stays in that browser or provider-opened system-browser windows.

### Connection and ownership

13. As a new owner, I prove possession of the prepared host using a short-lived one-use setup code over a verified connection. Expired, revoked, already-used and wrong-installation codes have safe recovery and never create a second owner.
14. As an owner, I cannot enter credentials or read private setup information over raw LAN HTTP or an unknown transport. The backend enforces this boundary even if a client bypasses the UI.
15. As an owner, I can distinguish the intended installation from another Moss instance at a different address. A matching display name, reachable private IP or browser localhost does not establish the intended host.
16. As a new owner, I provide my addressed name once and a password under the active password policy. My name is mutable and nonunique; it is not a username or login credential. No fake email is manufactured.
17. As an email-free owner, I can sign out and sign in as the installation's owner with my password. Existing email, member and social sign-in continue to work; an OAuth-only account does not silently gain a password.
18. As an owner, a concurrent first-owner attempt or lost creation response cannot replace ownership or create duplicates. Moss checks for the actual committed account/session before offering a retry or owner sign-in.
19. As an email-free owner, I can recover through a guarded host-side password reset that confirms the installation and immutable owner, hides password entry, records an audit event and invalidates existing access. It neither creates a new owner nor promises an email that cannot be sent.
20. As an existing owner, restart, Compose recreation, restore, key rewrap and guarded administrative operations preserve my identity and data. Legacy email target guards remain until deliberately migrated to an independently confirmed owner/installation guard.
21. As a pending, deactivated or signed-out user, I see the correct account gate and can recheck or sign out with recoverable errors. Unknown authorization never mounts owner-only controls.
22. As an owner who connects email later, I understand that an inbox connection does not become a login/recovery email, merge accounts or grant blanket permission to send messages.

### Saved progress and navigation

23. As a user who leaves during host preparation, I resume the last acknowledged private host checkpoint. After sign-in, I can resume the same owner's server-saved setup from another browser or device.
24. As an owner, I see Saved only after the represented value is durably acknowledged. Continue flushes meaningful pending changes; failed or uncertain writes remain distinguishable from saved choices.
25. As an owner, Back, browser Back/Forward, Save and leave, skips and recap edits preserve saved connections and do not repeat host execution. Skipping does not erase already-saved preferences.
26. As an owner, I can recover from offline operation or an uncertain response by checking canonical saved state before retrying. A failed read is never silently treated as empty, disconnected or unchecked.
27. As an owner using two tabs or Settings, I get a visible revision conflict rather than a stale request overwriting a newer choice. A deliberate reload or reapply resolves it.
28. As an owner who navigates away, signs out or switches accounts while an operation is pending, I do not get redirected by an old response or shown another account's private state.
29. As an owner, my passwords, API keys, app passwords, OAuth tokens, setup codes and pasted authorization URLs never enter general progress drafts, browser persistence, URLs, support logs or analytics.
30. As an owner on a newer journey version, I retain compatible acknowledged choices and review incompatible steps without resubmitting unknown old fields or replaying secrets.

### Personalization and Notes

31. As an owner, I can name my assistant from an initial Moss value using “Hi, \<name\>, I'm Moss. But you can change my name if you want. What would you like to call me?” The addressed-name question is not repeated.
32. As an owner, I select a real city that sets weather and derives an IANA timezone. A typed but unselected query is not a saved city, and a mapping error does not silently guess a timezone.
33. As an owner, I can retain a browser-suggested timezone, choose an explicit UTC fallback, or make a manual override. An explicit override survives later city changes until I choose automatic location mapping again.
34. As a new owner, Fahrenheit is the default, with a visible Celsius choice. Existing saved units survive resume and migration. Skipping location shows the actual timezone-based weather fallback rather than silently using server time.
35. As an owner, ordinary city search does not request device location. Optional Use my location needs my deliberate action, and denial returns to usable search without claiming continuous tracking.
36. As an owner, my prepared Notes intent becomes a canonical source only after it binds to my immutable owner/installation identity. Another account cannot discover its roots, names, contents, jobs or exports merely because a folder is mounted.
37. As a Notes user, I get read/write readiness from the actual runtime account, including a disclosed non-destructive temporary-file check and verified cleanup. Missing, disallowed, read-only, unknown and ready are separate states.
38. As an owner choosing managed Notes, I get one idempotently created private account directory without exposing a whole vault root. Failed creation or binding keeps the intent and allows Retry, another source or Skip.
39. As a Notes user, I can continue when the source is verified while indexing continues. Connected, reading notes, indexing failure and synced are not interchangeable, and no invented note count appears.
40. As an owner changing a host mapping later, I save progress, review the exact host change and deliberately recreate the affected service before verifying it. The prior working source remains available until the replacement succeeds; restart alone does not apply a mount.

### Optional capabilities

41. As an owner, I see AI as strongly encouraged and plainly skippable. Claude, Codex, OpenCode and Local model are featured without unsupported popularity claims, with official logos and usable text labels.
42. As an owner, I choose providers from the same supported authority as Settings. Registry presence, installation, authentication, model availability and chat capability remain separate facts.
43. As an owner, I can search official ACP discovery while unsupported entries explain their integration requirement. Discovery never executes remote commands or silently updates a reviewed adapter version.
44. As an owner, I use the provider's actual supported key, browser/device authorization or returned-code flow. Pending, canceled, expired and uncertain authorization recover without duplicate connections or navigation hijacking.
45. As a local-model user, I can choose an endpoint/model path when the installed Moss runtime supports it. Moss verifies server-side reachability and feature capabilities; browser localhost, a saved key or a catalog label is not proof of chat.
46. As an owner with one usable provider, I can Continue or Add another provider from the same result panel. Advanced routing and model policy remain in Settings.
47. As an owner, I can connect a supported inbox after seeing the actual provider permissions. Google’s current Desktop/manual-return flow stays truthful, and Proton Bridge requires actual server reachability. No new automatic callback is implied.
48. As an owner, I see the verified connected inbox identity and distinguish connection from initial sync or sync failure. I can skip email without granting messaging authority or seeing an invented mail client.
49. As an owner, I select News topics/publications while preserving effective defaults and exclusions. Skipping makes no preference changes, and unavailable modules are not silently enabled.
50. As an owner, I can add a custom News topic with a label and optional include/exclude guidance using the current ten-topic limit. Saving and first refresh are separate; structured-output model and web-search prerequisites are checked first.
51. As an owner, I search or browse Sports teams with stable team/league identities, retain selected teams across results, and recover failed follow/unfollow. Partial indexing is not reported as unsupported or no matches.
52. As an owner, failures in one optional module do not prevent unrelated setup. I can Retry, stay, or deliberately continue with identified saved choices without silently losing an unsaved draft.

### Completion and presentation

53. As an owner, I see the complete saved recap expanded by default, including deployment, names, weather/timezone provenance/units, actual provider capabilities, Notes readiness, inbox connection/sync and News/Sports choices.
54. As an owner, I can edit a recap line at its exact step. Deployment or mount changes take the reviewed host flow; ordinary edits do not restart Moss.
55. As an owner, Get started records completion once and then opens Today only if this account/request still owns navigation. Unknown completion is reconciled before retry; already-completed status offers Open Today.
56. As an owner without usable chat, I see that consequence in Ready and can knowingly continue without a second repetitive confirmation. A global shortcut that bypasses Ready must retain the existing consequence confirmation.
57. As an owner arriving on Today, I see my saved greeting and actual weather when available, Start a chat only when ready, and Connect AI otherwise. There is no fabricated briefing, automatic task, note editor, invented inbox, removed notes shortcut or email-sync status line.
58. As an owner, I use a distinct full-screen Park Press experience with one focal question, quiet progress, Back and optional Skip. Contextual help opens on demand; the UI does not copy Today’s rail or dashboard anatomy.
59. As a user on a phone or with a keyboard, screen reader, 200% zoom or reduced motion, I can finish and recover every route without hidden actions, lost focus, clipped text or motion-dependent meaning.
60. As an owner, I get bounded useful diagnostics without private paths, local usernames, hostnames, credential fragments or raw provider output leaking into public-facing errors.

## Implementation Decisions

### Decisions selected by the approved experience

The host helper ends its normal job at verified runtime readiness and browser handoff. It owns Docker checks, installation intent, initial Notes mapping and startup. The regular browser owns account creation and all later steps. The Linux/headless and self-managed paths share this boundary. No web Docker socket, arbitrary shell bridge, SSH credential store or embedded provider-auth browser is introduced.

The browser journey has six numbered setup sections. Initial Notes mapping precedes startup; owner-bound verification follows account creation. A later mapping edit is an explicit host operation. The final action is completion, not installation. Weather is included in the location question; all optional modules retain skips. The expanded recap and restrained Park Press presentation are mandatory.

### Proposed module boundaries

Use five deep modules with narrow, testable responsibilities rather than one wizard containing deployment logic:

1. **Host preparation** owns platform checks, reviewed plans, protected files, fixed Compose operations, actual-state reconciliation and regular-browser launch. Platform wrappers adapt native folder selection and system requirements to one lifecycle contract.
2. **Bootstrap identity** owns installation identity, code issuance/exchange, restricted first-owner creation, owner-password sign-in and guarded recovery compatibility. It exposes no general database/admin capability to the web application.
3. **Setup progress** owns owner/installation-scoped checkpoints, revisions, navigation resume and completion coordination. It stores references and non-secret drafts, not copies of canonical module settings or credentials.
4. **Capability adapters** project existing Settings/modules into consistent connect, saved-state and readiness contracts. Existing provider, email, preference and Notes authorities continue to own their real data.
5. **Browser journey** owns screen composition, accessible navigation and pending-action authority. It renders verified server state and has no authority to infer host success.

The helper's packaging technology is an implementation concern, but signed/trusted release provenance, bounded operations, current supported platforms and no arbitrary web-to-host execution are release requirements. Native wrappers must not require a permanent privileged daemon to finish onboarding.

### Proposed installation and handoff contract

Use an immutable installation ID stored in protected host metadata and persistent backend state. The host plan pins the actual Docker endpoint/daemon identity, Compose project/files/profiles, environment location, exact image version, volume identities, Notes intent and revision. Reconcile actual state under an exclusive deployment lock on resume. Do not inherit an arbitrary shell's Docker/Compose target silently.

Generate boot secrets once into protected host storage, then record acknowledgment. Effective Compose must publish the first-run application to loopback only; an additive override that leaves a second broad binding fails. Required readiness is database availability, successful migrations, API readiness, installation-identity match and required runner readiness. Optional AI or an inbox is not a readiness dependency.

Open a clean Account URL with no secret in its query, fragment or path. The proposed first-owner code has at least 128 bits of cryptographic entropy, a ten-minute lifetime, a hashed server verifier, one installation/origin binding and strict attempt limits. A protected exchange creates a short-lived bootstrap browser session. Reissue revokes older unused generations and their sessions; an existing owner makes issuance impossible. Code verification remains a concise security substate before the ordinary name/password form.

### Proposed owner identity and migration contract

Keep a single immutable owner UUID and one established session system. Make absence of email real throughout the data model and serializers. Add an explicit local-owner credential path that resolves the installation's owner server-side and retains the established password hashing, throttling, origin/CSRF, session and audit protections. Email uniqueness remains enforced for present addresses. Display names never participate in authentication or deduplication.

First-owner identity, credential, owner designation, claim consumption and durable bootstrap audit must commit under one serialized transaction. Session issuance may complete afterward; if it fails, the committed owner remains and can sign in with the selected password. Do not bolt a code check onto the current post-create hook, whose separately committed user currently requires compensation.

A mandatory bounded compatibility proof must establish that the actual authentication library, database and application consumers handle absent email through create, sign-in, session lookup, restart and recovery. If the library boundary cannot do this, stop that slice and review an adapter/schema change. A fake email, display-name login or test double is not an acceptable fallback.

Use the same independently confirmed installation ID and owner UUID guard for reconcile, reset, delete-user-data, restore and key rewrap. Host authority permits the operation; the IDs confirm its target. Keep legacy email confirmation until a verified migration. Do not use a just-read owner as its own confirmation or take the first of multiple owners. Connecting an inbox remains separate from identity. Optional verified recovery-email enrollment is a later capability, not a v1 requirement.

### Proposed progress and capability contract

Use revisioned owner-scoped server progress after authentication and protected host-local intent before it. Canonical Settings and module stores remain the source of truth. An operation has a stable request identity and resource/account scope; uncertain outcomes read back before retry. Completed or skipped decisions are distinct from capability readiness. Runtime status can become stale without erasing a saved choice.

Require explicit account-authorized Notes roots. Bind pre-account intent to the unique verified owner before listing or indexing. Verify runtime read/write access non-destructively, including successful cleanup, before publishing a ready replacement. A writable bind flag alone is insufficient.

Normalize provider and email connection metadata into a shared capability contract, reusing existing supported flows. Official ACP discovery is joined with reviewed pinned Moss support and never becomes executable authority. API-key chat and local-model chat are dependent capabilities, not inferred from a saved credential; the UI must remain truthful until the respective runtime exists. Preserve all current account/pending-action/source recovery behavior.

For location, store selected place, weather location and timezone provenance explicitly. Derive timezone from a supported city-to-zone resolver, retain a separate manual override and preserve existing units. Browser suggestion is a visible fallback, not a silent substitute for selected-location mapping.

### Delivery approach

The candidate slices in the companion are review boundaries, not an executable build plan. They prioritize a thin end-to-end owner path and deterministic state handling, then add host routes and optional capabilities through the same contracts. Each future slice must produce a narrow independently demonstrable behavior through persistence, API, UI and tests where applicable. Non-overlapping ownership should be assigned by module contract, with one integrator owning cross-cutting wiring.

## Testing Decisions

Testing must prove user-observable behavior at the actual boundary being claimed. Unit tests verify deterministic policies; database integration tests verify ownership and transaction behavior; real browser/host checks verify cookies, Docker and provider behavior. Mocks do not prove those external boundaries.

- **Host lifecycle:** force failures after each durable phase, run concurrent helpers, alter the Docker context/daemon and inspect the effective configuration. Prove retries preserve identity, keys and volumes and that a changed host does not receive an old plan. Failure rationale: happy-path installation can hide destructive replay or broad port exposure.
- **First owner and authentication:** race claims and registration paths, expire/revoke/replay codes, crash between identity commit and session response, and exercise wrong origin/host and DNS-rebinding attempts. Prove exactly one owner, no fallback first-user bypass and no credential/private-data route over unsafe transport. Run real absent-email account/session/recovery tests. Failure rationale: front-end tests cannot prove ownership or library compatibility.
- **Migration and recovery:** test fresh no-email owners, legacy email/password owners, OAuth-only owners, existing members, no owner, multiple owners, wrong expected identity and interrupted migration. Exercise reconcile, restart/recreation, reset, restore, deletion and rewrap guards together. Failure rationale: a working signup that cannot survive its first restart is not a releasable account model.
- **Progress and navigation:** test close/reopen, browser reload, second device, lost responses, double submission, Back/Forward, two-tab revisions, account switch, revoked access and later navigation before response. Failure rationale: the saved screen and its request authority are independent from the underlying operation finishing.
- **Notes:** test a valid empty vault, exact external/managed scopes, forbidden roots, path injection/symlink changes, runtime permission mismatch, temporary-file cleanup failure, account isolation and prior-source preservation. Failure rationale: global mount access and a preference save do not establish an owner's safe writable source.
- **Personalization:** test selected versus unselected city, resolver failure, browser suggestion/UTC fallback, manual override through city changes, Fahrenheit only for new preferences and explicit location permission. Failure rationale: weather and timezone have related but distinct save and fallback semantics.
- **Providers and modules:** test supported and unsupported methods, registry failure, auth expiry, installed-but-not-signed-in, saved-key-without-chat, server-unreachable local model, truthful Google permissions/manual return, Proton reachability, News effective defaults/custom-topic cap and Sports partial search. Failure rationale: a catalog entry or saved connection is not a verified feature.
- **Completion and accessibility:** test all optional steps skipped, no-AI consequence, expanded recap edits, uncertain completion and actual Today landing. Check keyboard, focus restoration, screen-reader announcements, 320px/390px, desktop, 200% zoom, light/dark/park theme and live reduced-motion changes. Failure rationale: normal navigation and recovery must be equally usable.

Before any build plan, inspect and extend current tests rather than creating a parallel test framework. The companion names the current seams and test anchors. Every future phase must include its own live end-to-end check and a stop condition when reality disagrees with the contract. Repository aggregate checks remain required; passing focused tests is not a full release pass. No product, host or live-provider verification has been performed by authoring this specification.

## Out of Scope

- Implementing product code, running an installer, changing any computer, publishing issues or implementation PRs, merging, or deploying as part of this documentation PR.
- Replacing the approved visual direction, copying the prototype's simulated persistence, or migrating its review-feedback database into Moss.
- A permanent desktop Moss shell, remote-management platform, generic shell bridge, Docker socket exposed to the app, or SSH credential manager. The deferred [no-Docker desktop epic #2316](https://github.com/motioneso/moss/issues/2316) and its embedded-PostgreSQL/Electron proposal are separate work; this specification does not activate or replace that epic.
- Universal Linux/distro/architecture support, a required domain, internet exposure, automatic certificate trust or bypassing browser warnings.
- New member onboarding, arbitrary multi-owner bootstrap, changing an existing user's authentication method implicitly or making connected email a recovery address.
- Building every ACP discovery entry, silently upgrading agents, or declaring API-key/local-model chat ready before its actual runtime support.
- Replacing Google's current connector with a new web callback, or building new email-provider protocols as a side effect of onboarding.
- A new note editor, email client, broad goals/personality questionnaire, automatic tour, silent task execution or permission expansion.
- Advanced model routing, publisher credentials, arbitrary feed setup and unrelated Settings redesign.
- Public analytics or collection of paths, inbox identities, location or credentials for onboarding telemetry.

## Further Notes

### Review and repository process

This document follows the seven-section shape of Matt Pocock's current **to-spec** skill: problem, solution, numbered user stories, implementation decisions, testing decisions, out of scope and further notes. The inspected upstream revision is `49dd158d1076134a641b33efb035946536778336`. Historical names such as write-a-prd are not presented as the current upstream interface. The tracked Moss tree does not vendor these Matt skills; that finding does not establish which skills are installed globally on any developer's computer.

Moss's checked-in process takes precedence for execution. This requested documentation PR places the specification and research companion in the repository's established specifications location for review and handoff. Approve the final spec, associate an authorized task issue, and only then use the repository's plan-build process to create an implementation plan. The current authorization covers publishing these two documents as a draft PR only. Candidate slice review does not publish tickets or satisfy the build gates.

### Design and evidence

- The approved Park Press experience was reviewed in a separate private prototype and its UX specification, screen contract and technical-boundary notes. Those private materials remain separate from this public repository. The prototype is a simulation, not evidence of installed behavior. This specification and its companion preserve the self-contained requirements needed for review and handoff; no private URLs, feedback database or design assets are imported. Any later public import of design assets requires separate authorization. The latest helper-to-regular-browser clarification governs the host/browser boundary.
- [Engineering contracts and source map](2026-10-12-moss-installer-engineering-contracts.md), using a fresh inspection of [Moss main at the pinned revision](https://github.com/motioneso/moss/tree/b8edd4569b2de20c86ee7d86d1f917b17772c587). Earlier source snapshots in the approved design are historical when they disagree with this inspection.

### Approval needed before build planning

Review the proposed technical contracts, especially the email-free compatibility proof, first-owner setup code, platform certification matrix and one-use bootstrap claim, stable deployment/owner identities and public test seams. These are engineering recommendations to accept or amend during spec review. They do not reopen the approved screen direction. There is no additional product interview required to review this specification.
