# Continue Computer with real owner viewing and input control

Ben requested independent review, resolution of findings, merge of the completed Computer stack,
then a new session for the next part. This dispatch continues the approved implementation after
bounded offline persistence passed. The destination remains the same persistent Computer inside
Moss chat and its ordinary browser experience, with watching, intentional takeover and return.

## Start

1. Stay in the isolated worktree/branch assigned at launch. Read `AGENTS.md`, `CLAUDE.md`,
   `docs/DEVELOPMENT_STANDARDS.md`, the [implementation handoff](2026-10-23-moss-computer-implementation.md),
   [owner-control plan](../plans/2026-10-23-moss-computer-owner-control.md), and current
   [persistent desktop spec](../specs/2026-10-23-moss-computer-persistent-desktop.md), especially
   sections 24–27. Search Hindsight for prior decisions; use the codebase graph for code discovery.
   Read repository plan-build before a committed plan, shared-checkout before commits,
   design-system before product UI, and verify-gate before any DB/foundation command. Inspect
   installed dependencies before choosing a scoped frozen install. Keep short private live state.
2. Verify the actual base contains the reviewed input-control foundation and accepted r21 evidence;
   check live PR #3598/#3607/#3612 status and current main rather than relying on earlier draft
   descriptions. Read the [r21 report](../../evidence/moss-computer/2026-10-23-persistence-r21.md),
   [JSON](../../evidence/moss-computer/2026-10-23-persistence-r21.json) and
   [review ledger](../../evidence/moss-computer/2026-10-23-independent-review.md). Reuse their bounded
   acceptance; another standalone persistence run is not this assignment's objective. Original r12
   connection and r18 initial clipboard causes remain unknown; no causal noVNC patch was claimed.
3. Inspect current auth/session-revocation, HTTP/WebSocket upgrade, trusted viewer assets, chat
   drawer, app-map, fixed desktop lifecycle/storage and actual input receiving seams. Cite actual
   file:line evidence in the plan. Read live #3577/#3578/#3605. Create/link a focused task under
   #3577 for the next integrated slice, recording reused foundation and remaining blockers rather
   than closing the parent. Resolve routine engineering choices autonomously; implementation and
   the approved chat design already have Ben's authorization.
4. Commit a bounded plan for the smallest real owner-authenticated viewer/control slice before
   code. Reuse `ComputerInputControl` and mature noVNC/RFB libraries. Cover one configured persistent
   Computer, ordinary Moss owner login, trusted exact Origin, fresh session checks and active
   expiry/logout/revocation, real visible watching, intentional takeover/return/controlling-viewer
   close, and a sole receiving input writer that fences stale queued input and releases pressed
   keys/buttons. State the trusted fixed-operation lifecycle/storage prerequisite and honest
   unavailable states. Outline later idle sleep/wake and confined egress without inventing a
   generic runtime/job platform. Obtain independent read-only security/spec review of the exact
   plan; reviewers do not author fixes. Split a genuinely oversized slice into explicit dependencies.
5. Implement the reviewed slice and wire its real caller; an unused policy or synthetic-certificate
   demo does not complete this phase. Keep chat-first design and app-map behavior/errors/remediations
   truthful in the same PR. Add affected dev/prod configuration alongside new requirements. Watching
   preserves authority; intentional controlling close returns through fresh authorization and
   generation checks; unexpected loss or failed return stays fail-closed. No credential/ticket in
   URLs or logs. Trace receiving/vendor paths before asserting security properties.
6. Before live work, commit the exact isolated runtime/auth/storage/network contract and obtain
   independent acceptance. Apply the resource/isolation/cleanup protections below with fresh actual
   admission. Keep offline fixture content unless a separately reviewed confined egress contract is
   implemented; network-none cannot be silently replaced with unrestricted bridge networking.
   Use scoped non-DB checks first. A DB/foundation command requires verify-gate and an isolated target.
   Prove real owner UI/HTTPS/WSS and input behavior with executable DOM/network assertions, foreign/
   unauthenticated/expired/revoked and stale-input controls observed failing at the intended seam,
   then independently verify closure. Never stub responses to obtain live acceptance.
7. Obtain independent exact-candidate/evidence review, resolve findings, commit/push and open a
   focused draft PR. Record which real predicates passed and which remain open. Preserve useful
   homes/scripts/receipts privately, close owned processes/containers/listeners/ports/credentials,
   and leave a clean tree. This next slice carries no automatic merge, production deployment or
   parent/qualification issue closure authority; Ben's preceding merge request covers the reviewed
   completed stack. If live acceptance is incomplete, report that accurately and continue useful
   independent work within this slice.

## Accepted checkpoint and product boundaries

- The internal input controller has 28 boundary tests, session-bound generation fencing, watcher
  isolation, fresh agent leases and authenticated intentional close-to-return. Its production
  transport caller and sole receiving writer were absent at the reviewed checkpoint. Reconfirm
  current source; the internal policy cannot retract bytes already sent to a desktop.
- R21 exact packet `fd34c7ba78b95b3b7ad690ae8211a275f1cbcef7`, evidence `776a85cc8` and
  ledger `cfdd5529c` passed independent readiness, 39 runtime/closure checks and exact final review.
  Real viewer/frame/input, active sandbox level 6 with added tab filters, clean flush twice,
  data-negative controls, same-home/image replacement, unchanged hashes before reopening and exact
  persisted bookmark/file readback passed. Six short watchdog samples do not prove sustained fit.
- [Approved chat mockups](../specs/2026-10-23-moss-computer-chat-mockups.html) place a recent still in
  full-screen chat, expanded viewing beside conversation, and a compact drawer/phone entry. Keep
  copy concise, without explanatory tutorials or visible screenshot labels. Intentional close by
  the controlling viewer returns control to Moss; watching never takes over. Further delivery or
  approval of the same mockup is unnecessary. Prototype acceptance is not live product acceptance.
- Actual owner transport/revocation, receiving-side input queue/key fencing, chat/browser wiring,
  installed storage/lifecycle/idle sleep-wake, confined Internet egress and release/platform cases
  remain open. Useful Internet access and automatic sleep require their own reviewed contracts.
  Disable retains dedicated data; deletion is a separate explicit operation. No running-process,
  installed-package or arbitrary site-session persistence promise follows from file/bookmark proof.

## Runtime protections and retained private artifacts

Inherit the implementation handoff's full protections. Fresh floors: RAM/root each at least 8 GiB,
data at least 30 GiB, healthy Moss. Exact adopted image only:
`sha256:c84e2db2add5f4c3c5073c7f021f6a2b4a04866948f7a5c4c47437c0d5d9ffbf`.
If absent, fresh archive/config/all-seven-layer verification and independent restoration review
precede one bounded exact load. No substitution, reclamation or production restart to meet floors.

Guest UID 1000, 2 CPU/4 GiB/512 PIDs; separate trusted gateway 0.5 CPU/128 MiB/32 PIDs; read-only
roots, dropped capabilities, no-new-privileges and default seccomp/AppArmor, bounded tmpfs/logs.
Keep API away from Docker socket/devices/production mounts and generic exec. Claim devports
5180–5299; never 5173 or 1533. Independent alive watchdog before launch: exact fresh label,
at most 1800 seconds, 90-second heartbeat, nominal five-second samples, fail closed on measurement/
log/floor failure or home+socket reaching 10 GiB. Preserve lifecycle lock/stop intent, first complete
healthy sample, zombie rejection, emergency exact-label kill and recorded PID/start/group cleanup.
Supervise actively, end hard failures, inspect actual watchdog reason and every sample, then
independently close exact resources and verify healthy Moss. Monitoring is not quota.

Create this session's own private root. Historical sibling homes/scripts/receipts are read-only:
`../moss-computer-viewer-r21/`, r13–r20 siblings and `../moss-computer-viewer-repair-private/`.
The retained exact archive is `../moss-computer-reconstruct-r2/candidate-image.tar`.
Earlier ephemeral credentials were deleted. Resolve paths relative to the assigned worktree;
report a specific missing prerequisite rather than rebuilding historical evidence.
