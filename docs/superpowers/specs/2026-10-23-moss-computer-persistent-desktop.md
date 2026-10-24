# Moss Computer: one persistent owner desktop

- **Date:** 2026-10-23 UTC
- **Status:** Autonomous implementation authorised. Offline candidate implemented; partial qualification accepted only for covered cases. Reconstructed candidate rapid-restart and bounded delayed-restart/reload recovery qualified by automated proofs; arbitrary-outage recovery and Moss integration remain unqualified.
- **Parent:** #3577. First qualification: #3578.
- **Plan:** [Isolated qualification](../plans/2026-10-23-moss-computer-isolated-qualification.md).
- **Authority:** Ben's supplied “Moss next steps after Stage 4, focused planning update 1”, MC0 request, device clarification, acceptance of the supplied v7 material without separate pack verification, instruction to write the spec/plan and proceed overnight, and subsequent explicit full authority to plan and implement autonomously, provider-agnostic and following repository guidelines.

## 1. Problem and outcome

Moss needs one owner-only persistent computer alongside its own runtime. Establish the smallest real execution path before building product integration. MC0 was a planning assignment, not an existing numbered guide task. Its independent review accepted a split between isolated desktop qualification and later integrated ownership proof.

The intended host is the existing server running this work. Other Moss installations run Computer on their own capable hosts. Ben views it from either this server or a MacBook Air. The first isolated qualification uses the server-local viewing path; remote MacBook viewing remains a later qualification case.

## 2. Settled product decisions

1. One persistent desktop is available once enabled. It automatically sleeps when unused to release host resources and wakes on demand. Enabled does not mean continuously running; see the idle-sleep amendment below.
2. The owner can manually use its desktop, browser and terminal first.
3. Designated files and the actual browser profile survive container removal and recreation. Website sessions can expire. Running processes and installed system packages have no persistence promise.
4. New installations select Computer by default, with opt-out and resource disclosure. Existing installations receive an explicit add-on step.
5. Disable stops Computer and retains its data. Data deletion is a separate explicit decision.
6. Agent control, watch/stop/takeover, login handoffs and useful jobs are required product capabilities, implemented in separately bounded work.
7. Preserve the desktop destination; a browser-only trial cannot redefine it.
8. The same persistent Computer is accessible inside the Moss app and through a web browser. The owner can watch Moss work and take over mouse/keyboard control; see the integrated-access amendment below.

## 3. Recommended system

```text
Owner in the Moss app or a web browser
  -> trusted Moss viewer and authenticated HTTPS/WSS gateway
  -> private persistent desktop companion
  -> dedicated Computer files/profile storage

Trusted host lifecycle interface
  -> fixed Computer enable / disable / sleep / wake / recreate operations
```

This diagram is the proposed integration, not an observed running path.

Use a separate Linux desktop image and dedicated storage. Do not reuse Moss vault, CLI-auth, model-cache or Sports volumes. LinuxServer webtop Ubuntu/Xfce was the first candidate. Its pinned Chromium launcher adds `--no-sandbox` under default Docker seccomp, so the unmodified candidate is rejected. The authorised research/implementation checkpoint below evaluates established alternatives; no vendor runtime claim is inherited.

The integrated gateway must check the Computer owner on creation, status, view, input, reconnect, sleep, wake and download requests, including WebSocket upgrades and active-session revocation. Administrator status alone grants no private-data access. Ticket ownership, expiry and replay semantics require their own reviewed contract.

Trusted viewer assets may use the Moss origin. Guest-controlled HTML, URLs and downloaded content must not acquire Moss-origin execution privileges. Downloads need owner checks, confined path resolution and safe attachment handling. A private network alone does not establish guest egress isolation: enforce restrictions against host, LAN, metadata and Moss service destinations.

Expose no additional public guest-control port. Give the guest no Docker socket, host credentials or production service network. Do not disable container security profiles or the browser sandbox to make a candidate work; incompatibility stops qualification. Use a narrow trusted lifecycle interface; the existing fixed restart sentinel is not a generic Computer controller. Guest failure must leave Moss available.

## 4. Scope and proof split

### First: isolated desktop qualification (#3578)

Qualify the pinned image, service user/init, private viewer, files/profile storage, replacement persistence, recovery and resource fit on the selected host. Use synthetic data only. This first outcome establishes no Moss owner-route security, installed-product integration or platform support claim.

The desktop envelope is at most two CPUs, 4 GiB RAM and 512 PIDs; the separate gateway adds 0.5 CPU, 128 MiB and 32 PIDs. No GPU; at most a 60-minute actively supervised runtime window. Storage limits, safe headroom and monitoring/cleanup failure behavior must be fixed before launch. A monitored byte ceiling must never be called an enforced quota.

Ben's overnight instruction authorises continued bounded preparation and safe isolated qualification. Codex `/root` is the active overnight host/finish operator. It may finish an automated session only while actively supervising it and able to perform final controls; no unattended overnight desktop or timer-only completion. Automated input is recorded as automated, not Ben's manual acceptance. Ben is the proposed finish operator for the later manual session; confirm attendance before dispatching that session.

### Later: integrated Moss proof

No qualified Computer gateway/lifecycle candidate has been identified. Prepare and independently review that implementation as separate bounded work before its live proof. The integrated proof must cover owner, foreign-owner and unauthenticated requests through the actual HTTPS/WSS path, session expiry/logout/revocation, download confinement, replacement persistence, failure isolation, disable/re-enable and idle sleep/wake. Test endpoints independently of navigation visibility.

Ben subsequently authorised autonomous implementation, including the missing gateway/storage interfaces. Each bounded candidate still needs independent review and applicable live proof; isolated acceptance does not establish production deployment or release/platform readiness.

## 5. Evidence and system fit

| Class                       | Established fact or limit                                                                                                                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source inspected during MC0 | `8814c9b43101e40619cf1e89055cf4eab2a6ce04`; citations below refer to that revision.                                                                                                                                                               |
| Documentation branch base   | `021fd9a0c`; documentation-only work must not be mistaken for a refreshed product-source review.                                                                                                                                                  |
| Installed production image  | `ghcr.io/motioneso/moss@sha256:74d2208c9c50e48465a177ff99b17e1bbb3e04bab2386d6a0268c922c4d8b8db`.                                                                                                                                                 |
| Installed metadata          | Reported build commit `85fa42c1df7d1c69fe4ca2c83e34dac6da18f893`; embedded metadata is not independently attested provenance.                                                                                                                     |
| Installed configuration     | `~/JarvisProd/docker-compose.prod.yml` and `docker-compose.notes.yml`; distinct from repository Compose.                                                                                                                                          |
| Observed host               | Ubuntu 24.04, Linux x86_64, 16 CPU threads, approximately 17 GiB available RAM; Docker 29.1.3, Compose 2.24.6, cgroup v2.                                                                                                                         |
| Resource limits             | Root filesystem was 97–98% used with roughly 13–14 GiB free, swap nearly full, and Docker's separate filesystem had roughly 959 GiB free. These are snapshots, not benchmarks.                                                                    |
| Historical research         | `~/moss-research/2026-10-04-virtual-desktop-for-moss.md`; vendor/resource claims are historical, and its browser-first recommendation is superseded.                                                                                              |
| Stage 4                     | Final report and planning addendum dated 22 October 2026, task mapping and session ledger were recovered. Acceptance retains amendments, deferred mobile evidence and unrun lifecycle/race cases. Raw execution was not independently re-audited. |
| Guide                       | User-supplied v7 material, source `b16c446fcc729f50f057d3be38d586338d4adb99`, is authoritative. Ben waived separate pack verification. Unread pack contents are not represented as inspected.                                                     |
| Runtime unknowns            | Private viewing, candidate user/init compatibility, profile location, safe resource envelope, integrated transport, egress, persistence and recovery still require actual proof.                                                                  |

## 6. Shared boundaries and ownership

Current named product owners were not established. The qualification operator owns no shared product changes. Reserve one coordinated owner for each boundary before later implementation; package location is not proof of an active assignment.

| Boundary           | Source evidence at the inspected revision                                                                                         | Required future responsibility                                                                                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity           | `packages/auth/src/index.ts:454–519`                                                                                              | Auth/gateway owner; add Computer owner comparison.                                                                                                         |
| HTTP/WS            | `packages/ai/src/terminal-routes.ts:46–63,90–267`; `apps/api/src/server.ts:349`                                                   | Auth/gateway owner. Existing terminal tickets are not actor-bound and disconnect kills the PTY; do not copy those semantics unchanged.                     |
| Shell/navigation   | `apps/web/src/app.tsx:175–189,292–345`; `apps/web/src/app-route-metadata.ts:131–175`; `apps/web/src/shell/app-shell.tsx:22,76–85` | Shell owner.                                                                                                                                               |
| App map            | `packages/shared/src/app-map-core.ts:54–86,423–426` or owning manifest                                                            | Same product PR must describe the actual navigation, settings, features, errors and remediation. No Computer declaration for this docs-only qualification. |
| Deployment/storage | `infra/docker-compose.yml`; `infra/docker-compose.prod.yml:140–237`; `docs/operations/deploy.md:9–17,108–138`                     | Deployment owner; preserve installation identity, add dedicated storage and private wiring.                                                                |
| Images/releases    | `Dockerfile:33–45,59–83,110–127`; `.github/workflows/ci.yml:456–501,526–537`; `.github/workflows/release-image.yml:43–122`        | Packaging owner; desktop digest/architecture qualification is separate.                                                                                    |
| Lifecycle/recovery | `packages/settings/src/host-restart-routes.ts:75–145`; `infra/host/jarv1s-restart.sh:4–10,28–38`                                  | Lifecycle owner. Current backup documents disagree on automatic coverage and establish no Computer backup.                                                 |
| Sports exclusion   | `infra/docker-compose.prod.yml:253–283`; `packages/sports/src/source/browser-sidecar.ts:92–115,300–315`                           | Leave the specialised renderer unchanged.                                                                                                                  |

## 7. Dependencies and exclusions

- Reuse relevant stable guide tasks: Q01-C1 (source/release), Q02-P1 (installed identity), Q04-C1 (devices/cases), Q05-R1 (readiness review). This spec does not complete those whole tasks or their stages.
- D01-C1, D01-R1 and D02-P1 inform later backup/recovery; the synthetic isolated qualification need not wait for the full recovery programme.
- Installer/authentication/image/platform release gates remain for new-install and advertised-platform claims. The first existing-owner trial does not require all Extensions or a native-shell rewrite.
- The supplied inventory reports PRs 3540/3542/3544 merged and 3532/3535/3536/3539 as drafts. None was established as a Computer prerequisite; no automatic draft adoption or repeated accepted UAT.
- News and Direct On remain independent. Preserve X03-P1 before dependent runner work, X16 review/live-proof gates and X17/X18/X19 hold markers; no dispatch or completion claim here.

## 8. Acceptance and stop

The first qualification needs actual desktop/browser/terminal input, a file hash and actual browser-profile marker surviving remove/recreate with different container IDs, reconnect/failure evidence, measured resources and disable preserving data. Record automated and manual cases separately.

Before launch, independently review exact image/configuration, private viewing, egress, memory/storage safety and final controls. If any entry gate fails, return `BLOCKED_BEFORE_LAUNCH`, retain evidence and stop. Make a bounded design decision before implementing a missing interface. Do not change host firewall/account settings, select another host or start reusable tooling to get around a blocker.

At runtime closure, stop only the labelled proof desktop, confirm no proof process/listener remains, confirm Moss health and preserve proof data. Data deletion, image pruning, production changes and a later proof need separate scope. Full overnight waiting is not a completion criterion.

## 9. Rulings and review ledger

- MC0 independent review accepted the split and planning completion, with Ben named as proposed manual finish operator and all runtime entry gates retained.
- Ben confirmed this server as host and either server or MacBook Air as viewer.
- Ben accepted the supplied v7 material without further verification.
- Ben requested these durable documents followed by bounded overnight progress; this supersedes the earlier planning-only limit only for documentation and the first isolated qualification.
- Exact-document independent review and the qualification outcome are recorded in the companion evidence report. A readiness failure cannot be represented as runtime acceptance.

## 10. Authorised implementation amendment

Ben explicitly gave full authority to plan and implement autonomously and invited research/reuse. That supersedes the earlier missing-interface permission stop, not the repository review/security/live-proof gates. The first implementation may change the isolated candidate after documented comparison. Agent/model providers play no role in this manual desktop checkpoint.

Implemented internal candidate, independently reviewed before launch: distro-packaged Xfce, TigerVNC, noVNC/websockify and Firefox ESR on a pinned Debian amd64 base. Reuse their viewer/protocol/browser implementations. Do not build a remote desktop protocol or custom Docker-exec byte tunnel. Websockify's documented Unix listener allows an offline guest (`network=none`) to be reached through one socket-only mount by a isolated trusted Nginx TLS gateway. Gateway material remains outside guest storage. A synthetic client certificate tests isolated viewer access; this is not Moss owner authentication.

This offline qualification exercises browser/profile mechanics with local synthetic content. It cannot qualify useful Internet browsing. Product integration must add reviewed outbound HTTP(S)/DNS handling that excludes host/LAN/metadata/Moss services; no silent unrestricted bridge fallback. Guest-controlled pages and downloads stay outside the Moss origin.

The proof home/files directory uses a monitored 10 GiB threshold, not a quota; the read-only image root and size-limited tmpfs contain other writes. An independent monotonic supervisor stops the labelled guest on timeout, missing heartbeat, measurement error, low headroom or threshold exceedance. The active operator closes gateway/listener and records retained data. No unattended persistence claim follows. A strict hard-quota requirement would be a separate storage/platform dependency.

## 11. First implementation checkpoint result

The [qualification ledger](../../evidence/moss-computer/2026-10-23-isolated-qualification.md) records real offline desktop input, active Firefox content sandbox diagnostics (user namespaces unavailable), isolated proof-CA route checks and negative controls, actual container replacement with retained file/profile/bookmark, resources and attended cleanup. Ben manual/MacBook cases, Internet browsing and Moss ownership integration remain NOT_RUN.

Crash socket reconnection occurred, but recovered rendering/input did not qualify. Stop/split at that gate; the [one next proposed assignment](../plans/2026-10-23-moss-computer-recovery-qualification.md) addresses only recovered viewing/input. No production, installer, release or whole-guide-stage acceptance follows. Full implementation authority remains; no new routine permission is required.

## 12. Reconstructed-candidate recovery checkpoint

The [recovery-r3 result](../../evidence/moss-computer/2026-10-23-recovery-r3.md) qualifies real
visible rendering and fresh viewer keyboard input after a rapid fixed-host restart on the adopted
reconstructed image. The synchronous readiness harness passed after a stopped-guest frame control
failed at the actual canvas assertion. Historical async readiness checks were unreliable; the
original canvas-timeout cause remains unknown. This does not transfer earlier replacement/profile
acceptance to the rebuild. Long-outage/reload, Moss integration and the other gates stay separate.
At that checkpoint the next proposal was a bounded delayed-restart/reload proof, not an integration dispatch.

## 13. Delayed-restart/reload checkpoint

The [recovery-r4 result](../../evidence/moss-computer/2026-10-23-recovery-r4.md) qualifies one
server-local automated delayed-restart loop on the same adopted image: observed terminal failed
automatic retry while stopped, actual stopped-guest12s frame negative control, fixed host restart,
then one explicit browser reload yielding a new document/RFB, substantive visible frame and fresh
viewer-keyboard marker. Guest kill-return→start-return was13392ms; arbitrary-duration recovery or
recovery without reload after terminal failure is not established. Exact evidence records collection
limits and independent review; active runtime/listener/keys were closed and retained data preserved.
No product integration or earlier-image Firefox/profile/replacement acceptance transfers. The one
next proposal is a separately reviewed bounded active Firefox sandbox and file/profile replacement
qualification on this adopted image; no further runtime is dispatched by this checkpoint.

## 14. Adopted-image persistence entry rejection

The dispatched [sandbox/replacement attempt](../../evidence/moss-computer/2026-10-23-persistence-preflight.md)
stopped before launch: fresh available RAM was 8,330,731,520 bytes, below the required 8 GiB floor.
The exact adopted image was absent; no archive verification/load or rebuild was attempted after
the resource gate failed. Moss remained healthy and no proof runtime was created. Active Firefox
sandbox and file/profile persistence across replacement remain NOT_RUN on this image. The next
proposal is the same bounded qualification after fresh entry floors pass, with exact archive
validation if needed and a committed, independently reviewed launch packet. No retry, production
change, owner integration or manual/platform/release acceptance is dispatched by this result.

## 15. Idle sleep and on-demand wake requirement

Ben's 23 October resource-sharing clarification supersedes the earlier requirement to keep Computer
running continuously while enabled: it should sleep when not in use. This is a product requirement
for the later lifecycle implementation, not a change to the paused isolated qualification runtime.

The initial design is a clean desktop-container stop after an idle grace period, releasing its
resident memory and CPU demand while retaining designated files and browser profile data. A
container pause or a blank display retains memory and does not meet the resource-release goal.
Browser/profile writes must flush before stopping; inability to stop safely must be surfaced.
Sleep preserves durable state, with no promise to resume unsaved work or live processes. The owner
must be told this behavior before relying on it; apps reopen on wake.

Opening Computer should wake it automatically. Later authorised Computer tasks should wake it
before execution and keep it awake until their work finishes. A connected owner viewer or active
operation prevents automatic sleep; viewer disconnection alone must not interrupt an active task.
The idle timeout, activity/inhibitor contract and handling of untracked background work remain
explicit lifecycle-design decisions. Automatic sleep must not discard unsaved work silently.

Sleeping remains enabled and can wake on demand; disabled stays off until explicitly re-enabled.
Neither operation deletes data. Wake must retain owner checks and resource admission controls; low
headroom produces a truthful waiting/unavailable state instead of competing blindly with host work.

Before claiming this capability, independently review and prove idle detection, clean flush/stop,
measured memory reclamation, preserved file/profile state on wake, protection of active work,
sleep/wake races and admission failure through the real product path. Product implementation must
update the app map in the same PR. No sleep implementation, new runtime, unattended waiting or
additional qualification is dispatched by this requirement amendment.

## 16. Adopted-image persistence r6: incomplete proof

Ben later resumed the same bounded assignment after freeing host resources. Fresh entry passed;
retained archive/config/seven layers were verified and the exact adopted image loaded. The committed,
independently reviewed [r6 packet](../plans/2026-10-23-moss-computer-persistence-r6.md) launched one
supervised run. Its [result](../../evidence/moss-computer/2026-10-23-persistence-r6.md) is
REJECTED_INCOMPLETE_PROOF: current viewer/frame/input and synthetic access/isolation checks passed,
but a cached Firefox window ID became invalid before actual sandbox diagnostics. The polling
harness wrongly repeated identical BadWindow errors; that stop-rule failure is retained.

No clean UI flush, persistence negative controls, guest replacement or post-replacement acceptance
was reached. A retained-profile copy contained the created bookmark after fallback SIGTERM; this
is diagnostic only and establishes none of those missing gates. No Firefox sandbox/persistence
failure is inferred from the harness error. Runtime, watchdog, browser, network, listener/reservation
and ephemeral identities were closed; retained data remains and Moss is healthy.

The next proposal is bounded window rediscovery/error handling and failure diagnostics, followed by
fresh exact independent review and a separately dispatched qualification with resource gates.
No rerun, product/sleep implementation, owner integration, merge or issue close is dispatched here.
Section14 remains the historical r5 entry rejection; the adopted-image sandbox/replacement gates
remain unqualified after r6.

## 17. Adopted-image persistence r7: protected access rejection

Ben dispatched bounded current-window/error-handling corrections and one fresh qualification through
this [handoff](../handoffs/2026-10-23-moss-computer-window-persistence.md). Fresh entry passed; the
retained archive/config/seven layers were verified and exact image restored once. Corrected private
harness regressions and amended committed packet passed independent prelaunch review.

The single [r7 run](../../evidence/moss-computer/2026-10-23-persistence-r7.md) stopped at the first
protected owner WebSocket assertion:502, expected101. Initial sampled isolation passed, but actual
viewer/Firefox/window/sandbox testing, clean flush, persistence controls and replacement were not
reached. A startup-readiness timing gap is only a hypothesis; absent gateway upstream diagnostics
leave the cause UNKNOWN. No retry or relaxed assertion occurred. Real-window corrections remain
unqualified by runtime. One prelaunch watchdog sample does not establish continuous host headroom.

Active cleanup and closure checks found no owned runtime/listener/reservation/ephemeral identities;
homes/archive remain and Moss is healthy. The next proposal is one separately reviewed bounded
startup-readiness qualification with actual current UI/RFB and gateway/backend failure diagnostics,
retaining all protection/resource/error-stop gates. No second run, product/sleep implementation,
owner integration, merge or issue close is dispatched. Sections14/16 retain their historical failures;
adopted-image active sandbox and replacement persistence remain unqualified.

## 18. Startup readiness r8: pre-load resource rejection

After #3587, #3588 and #3595 merged, Ben dispatched the bounded
[startup-readiness assignment](../handoffs/2026-10-23-moss-computer-startup-readiness.md).
Initial fresh entry passed and the absent image's actual archive/config/seven layer payloads
were independently verified. Restoration acceptance was conditional on fresh resource floors.
The required pre-load sample then recorded available RAM8,490,229,760 bytes, below8GiB by
99,704,832 bytes. The [r8 result](../../evidence/moss-computer/2026-10-23-startup-readiness-r8.md)
is BLOCKED_BEFORE_LAUNCH: no image load, runtime or startup/access/frame/input proof occurred.

The failed gate was not retried; no reclamation or infrastructure investigation followed.
The newly reserved port was released, no owned runtime/keys remained, homes/archive were retained
and Moss stayed healthy. Startup readiness and all previously missing qualification gates remain
unqualified. One next proposal is a separately dispatched attempt after host capacity is available,
with fresh identity/floors and exact independent packet review. No automatic rerun, product/sleep
implementation, owner integration, merge or issue close is dispatched by this rejection.

## 19. Startup readiness r9: initial resource rejection

After #3596 merged, Ben dispatched one fresh attempt through the
[r9 handoff](../handoffs/2026-10-23-moss-computer-startup-readiness-r9.md). The initial fresh sample
recorded available RAM6,813,106,176 bytes, below8GiB by1,776,828,416 bytes; root/data floors passed.
The [r9 result](../../evidence/moss-computer/2026-10-23-startup-readiness-r9.md) is
BLOCKED_BEFORE_LAUNCH. No runtime preparation, archive validation/load, launch packet, port
reservation or startup/access/frame/input proof occurred. The resource gate was not retried.

No owned runtime was started; exact-label/reservation readback was empty, prior homes/archive
remained present and Moss stayed healthy. Startup readiness and all previously missing gates
remain unqualified. One next proposal is the same bounded qualification after a separate dispatch
when host capacity is available, with new identity, fresh floors and independent exact packet review.
No automatic rerun, product/sleep implementation, owner integration, merge or issue close follows.

## 20. Startup readiness r10: restored backend refusal

Ben explicitly resumed after RAM recovered, authorising one fresh bounded attempt while retaining
r9's entry rejection. Fresh entry and pre-load/pre-launch gates passed. The actual retained archive,
config and seven layers were independently verified; one exact load and post-load identity/layer
inspection passed. The committed [r10 packet](../plans/2026-10-23-moss-computer-startup-readiness-r10.md)
and exact private artifacts received independent prelaunch acceptance.

The single [r10 run](../../evidence/moss-computer/2026-10-23-startup-readiness-r10.md) passed positive
guest/socket/gateway RFB probes, initial sampled isolation, protected access and both intended red
controls. After byte-exact gateway configuration restoration, the driver exited0 but its owner
payload contained RFB003.003 and “Too many security failures”, failing the required RFB003.008
signal. Wrapper/runner1 reject the proof; UI/frame/input were NOT_RUN. Live diagnostics establish
loopback backend blacklisting/refusal, with gateway upstream reset, but not its trigger. Probe
side effects are a hypothesis; r7's502 cause remains UNKNOWN.

Watchdog/cleanup/port release and operator closure exited0; independent closure found no owned
runtime or ephemeral identities, retained homes/archive and healthy Moss. Two samples establish
no sustained resource-fit claim. One next proposal is separately dispatched bounded RFB probe/
blacklist diagnosis with unchanged image/security/assertions and exact review before another proof.
No automatic retry, security weakening, product/sleep implementation, owner integration, merge or
issue close follows. Startup/UI/input and previously missing sandbox/replacement gates remain
unqualified; r8/r9 and all earlier rejection evidence remains unchanged.

## 21. Integrated app/browser access, watching and takeover

Ben clarified that accessing Moss's Computer must be possible inside the Moss app and through a
web browser, so the owner can watch Moss work or take over. Both surfaces expose the same
persistent desktop/session and files; a separate computer for each viewer would not meet this
requirement. Watching should not take input control away from Moss.

Taking over gives mouse/keyboard input to the owner and pauses Moss's computer input until control
is explicitly returned. The integrated design must show who has control, prevent simultaneous
conflicting owner/agent input, and preserve owner authentication/authorisation on viewing, input,
reconnect and control transitions. Exact UI, handoff/resume and multi-viewer/disconnect behavior
need their bounded design before product implementation; no new app surface is implemented here.

Integrated acceptance must exercise both the Moss app and browser through the real owner path:
watch visible work, take over and verify Moss stops issuing input, then explicitly return control
and verify a safe resumption on the same desktop. Cover unauthorised access, stale agent input,
reconnect and active-work sleep inhibition. Keep the app map truthful when those product surfaces
ship. The isolated startup/probe fix continues as groundwork and grants none of this integrated,
manual-device or platform acceptance.

## 22. Bounded startup and fresh-input qualification: r11

Ben's “yea fix it” authorised the bounded probe correction after r10, preserving its rejection.
R10's greeting-only probes definitely stopped before initialization; complete bounded RFB3.8
negotiation now precedes successful closure on guestTCP, UnixWS, gatewayWS and accessWS. Separate
protocol-contract regressions caught the old false-positive behavior and passed the correction.
They do not establish TigerVNC's blacklist trigger; r7's prior502 cause remains UNKNOWN.

The single exact-reviewed r11 run passed actual complete readiness, unchanged protected access and
mTLS/Origin removal/restoration controls0/1/1/0, current connected UI/RFB, attached visible1280x800
canvas with345 sampled colours and exact fresh viewer-written file readback, plus initial/final
sampled isolation. Runner/watchdog/cleanup/port release/operator closure all0; independent closure
accepted absent owned runtime/keys, retained homes/archive/marker and healthy Moss. Two short monitor
samples grant no sustained-fit claim. Synthetic identities grant no Moss owner-authentication proof.

See the [r11 report](../../evidence/moss-computer/2026-10-23-startup-readiness-r11.md),
[JSON](../../evidence/moss-computer/2026-10-23-startup-readiness-r11.json) and
[packet](../plans/2026-10-23-moss-computer-startup-readiness-r11.md). The image's present-to-absent
preparation observation remains unexplained; one freshly archive-verified/reviewed restore0 matched
actual identity/platform/all seven layers before this run. No earlier acceptance transferred.

This qualifies bounded startup/protected viewer/fresh input only. Active Firefox sandbox, clean
profile flush, replacement persistence, idle sleep/wake and §21 app/browser owner watch/takeover
remain separately bounded work. Propose the next bounded Firefox/sandbox/clean-shutdown/replacement
qualification; no automatic rerun, merge, task3578/parent3577 closure or product implementation.

## 23. Implementation dispatch and r12 prerequisite rejection

Ben dispatched implementation in a fresh isolated worktree under the
[implementation handoff](../handoffs/2026-10-23-moss-computer-implementation.md), superseding
historical integration exclusions without waiving review, UI design, runtime safety or live proof.
New child #3605 tracks the owner-control foundation; it depends on unmerged draft #3598.
Neither parent #3577 nor qualification task #3578 is complete.

The single reviewed [r12 attempt](../../evidence/moss-computer/2026-10-23-persistence-r12.md)
passed complete backend/access controls, then failed the current UI/RFB connected predicate after 20 seconds.
Frame/input/Firefox/flush/replacement were not reached. No runtime retry; independent closure
confirmed resources/ephemeral keys absent, retained homes/archive and healthy Moss. Cause UNKNOWN.
Accepted r11 evidence remains bounded historical acceptance, not owner integration or persistence.

The committed [owner-control plan](../plans/2026-10-23-moss-computer-owner-control.md) permits
independent internal session-bound/generation-fenced input policy implementation while dependent
desktop qualification is blocked. It adds no usable Computer route, viewer, lifecycle or egress
and must not be advertised as delivered desktop integration. Proposed
[screen mockups](2026-10-23-moss-computer-screens.html) await Ben's approval before product UI;
a self-contained preview was delivered to his Samsung phone for review, not approved by delivery.

## 24. Chat-integrated design revision (supersedes the separate-page proposal)

Ben rejected the separate-destination mockup and clarified that Computer belongs in the chat
drawer. In full-screen chat, show a recent screen thumbnail; it need not render live. This changes
the primary interaction design, not owner/session safety, persistent storage or runtime gates.
The previous `/computer`-first proposal in the owner-control plan is superseded. No separate module
or navigation entry is intended. Browser access uses the same owner-authenticated Moss chat.

[Revised interactive mockups](2026-10-23-moss-computer-chat-mockups.html) show five views: full-screen
chat with a timestamped still, viewer beside the conversation, owner takeover, compact drawer and
phone. Opening watches without taking over; Return to Moss or intentionally closing the
controlling viewer resumes Moss input (approved revision below). Sleeping/waking/paused/
disconnected/off variants retain honest capture-age/status labels. All sample screen content is
illustrative; no live desktop runs here.
Production uses shared Button/Badge/BrandMark/Thread and PeekPanel lifecycle, with truthful chat
feature metadata when wired. Ben approved this layout with the revision below. Exact screenshot
refresh policy remains an implementation detail. The internal policy and failed-r12 limits remain.

## 25. Approved chat layout and intentional-close handoff

Ben approved the chat-integrated mockups, requesting concise copy and that closing the viewer
returns control to Moss. Keep capture age, status and control labels; omit explanatory tutorials.
This supersedes earlier close-leaves-paused and explicit-return-only UI requirements, including
§21. Return to Moss remains available while viewing.

Intentional close by the controlling owner uses the same authenticated, generation-fenced return
action before closing its connection. It invalidates old owner/agent input; only a fresh agent
lease can proceed. Unexpected disconnect, logout/revocation or a failed return still fails closed;
a disconnect alone cannot grant input authority. Closing a watcher must not steal another viewer’s
control. The current internal policy already separates returnToMoss from disconnect; actual
transport wiring and receiving-side fencing remain unimplemented. Design approval does not waive
persistence, lifecycle, egress, owner transport or live acceptance gates.
