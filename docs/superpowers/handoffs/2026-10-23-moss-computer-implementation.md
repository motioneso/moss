# Begin Moss Computer implementation, completing prerequisites first

Ben explicitly requested a NEW session to begin implementation and authorised completing necessary
prerequisites first. This is a new implementation dispatch, superseding the closed readiness task's
integration exclusion. Preserve all historical evidence and its limits. Work toward an owner-only
persistent Computer accessible inside Moss AND through a browser, so the owner can watch Moss work,
take over mouse/keyboard input, and explicitly return control. This is implementation authority;
repository design, review, resource, security and live-proof gates remain binding.

## Start

1. Stay in the fresh isolated worktree/branch assigned at launch. Its base includes draft PR #3598,
   the accepted r11 evidence and this committed handoff; do not assume those commits are merged into
   main. Read `AGENTS.md`, `CLAUDE.md`, `docs/DEVELOPMENT_STANDARDS.md` and the persistent-desktop spec
   below in full. Use Hindsight for decisions, the codebase graph for code discovery, and the repo's
   `.claude/skills/plan-build/SKILL.md` for implementation planning. Read design-system before UI,
   shared-checkout before commits and verify-gate before any DB-touching/foundation command. Inspect
   installed dependencies before a scoped frozen install; do not begin with a broad installation.
2. Establish a short prerequisite ledger from current evidence and actual code: what is already
   qualified, what blocks the first integrated slice, and what is a later release/platform case.
   Reuse accepted r11 startup/access/input evidence without claiming it proves owner integration.
   Read the r11 report/JSON/packet and review ledger, plus the original persistence/window references
   below for the still-missing active Firefox sandbox, clean profile flush and replacement checks.
   Keep a small private live-state file outside the repository. Begin useful work immediately.
3. Complete genuine blockers before dependent implementation or live acceptance. If a fresh isolated
   Firefox/profile replacement proof is needed, this dispatch authorises ONE fresh bounded attempt
   after fresh admission, a committed exact packet and independent read-only acceptance. Use a new
   unused identity/root/home/socket/keys/port; preserve every earlier artifact. Retain r11's complete
   RFB handshakes and synchronous current-frame/input checks. A failed admission or hard assertion
   ends that runtime attempt without retry; capture/review evidence and close all owned resources.
   Continue independent design/code work only where it does not depend on the failed gate. Avoid
   turning prerequisite work into an indefinite sequence of evidence-only runs.
4. Inspect current integration seams before planning: owner/session auth and revocation, HTTPS/WSS
   upgrades, storage, trusted lifecycle operations, input producers, navigation and app map. Cite
   actual `file:line` evidence; historical spec citations are starting points, not current proof.
   Reuse existing mechanisms and mature viewer/protocol libraries. Read live #3577/#3578; they remain
   open and their older bodies are not a current qualification ledger. Create/link a focused GitHub
   `task` child of #3577 for the first integration slice before product code. Record the dependency
   on #3598 and stack the new PR on its branch while it remains unmerged; do not merge it yourself.
5. Design the smallest useful vertical slice and commit its plan before code. The full direction is
   already authorised; do not ask Ben again whether implementation should start. Resolve routine
   engineering choices autonomously. Cover app/browser viewing, owner-only transport and lifecycle,
   watch/takeover/return transitions and idle sleep/wake in the design, while keeping later slices
   outlined. Follow the existing spec and authored Moss design system. If a new module needs mockup
   approval under repository rules, produce the concrete screens/states for review first and ask
   only for that missing design decision; continue safe prerequisite/backend work meanwhile.
6. Begin implementation once the applicable prerequisites/design gates pass. Ship a bounded,
   reviewable first slice and evaluate it before detailing the next. The destination is the real
   Moss app/browser experience, not a standalone synthetic-certificate demo. Carry unmet watch,
   takeover, agent-input and lifecycle work explicitly forward; do not label the overall feature
   complete after a viewer-only slice. Keep app-map navigation/settings/features/errors/remediation
   truthful in every product PR, and include affected dev/prod configuration when adding requirements.
7. Run meaningful scoped verification and the required isolated dev/live gates. Use the actual owner
   HTTPS/WSS path, independent endpoint access checks and real visible rendering/input. Preserve
   observed negative controls for security claims. Obtain independent review of exact candidates
   and evidence; reviewers do not author fixes. Commit/push scoped work and draft PR(s), retain an
   accurate prerequisite/backlog ledger, and finish with a clean tree and no owned runtime/ports.
   No production deployment, automatic merge or premature issue closure is authorised here.

## Required product behavior and security

- Both app and browser open the SAME persistent Computer/session/files. Watching does not seize
  input. Owner takeover pauses Moss input until explicit return. Show who controls the computer;
  enforce ownership at the input boundary, including stale/queued agent input, multiple viewers,
  disconnect, reconnect and restart. UI-only toggles do not establish control exclusion.
- Use actual Moss owner authentication/authorisation for creation, status, view, input, reconnect,
  lifecycle and any downloads. Cover foreign owner, unauthenticated requests, expiry/logout/revocation
  and active WebSockets. Synthetic trial certificates are not a product identity mechanism.
- Dedicated Computer files and actual browser profile survive replacement. Disable retains data;
  deletion stays an explicit separate action. Running processes/packages/site sessions are not
  promised to persist. Idle sleep releases resources and wake resumes availability; active owner/
  agent work inhibits sleep. Design races and interruption behavior before claiming acceptance.
- Trusted viewer assets may share the Moss origin; guest-controlled pages/downloads must not gain
  Moss-origin privileges. Keep guest access away from host/LAN/metadata/Moss services and credentials.
  Useful Internet access requires a reviewed confined egress design; do not substitute unrestricted
  bridge networking. Add download confinement only with its reviewed owner/path/attachment contract.
- Keep the provider-agnostic agent boundary. A Computer slice does not authorise a new job platform,
  remote protocol, generic Docker-exec tunnel, native-shell rewrite or unrelated module changes.

## Live prerequisite protections

For a fresh isolated prerequisite run, inherit the original persistence/startup runtime protections:
RAM/root each at least8GiB and data at least30GiB at entry and immediately before image load/launch;
healthy Moss. No waiting/retry/reclamation/prune/restart/host substitution after a failed resource gate.
Exact adopted image only, with fresh retained-archive/config/all-seven-layer verification and
independent restoration-readiness acceptance if absent, then at most one bounded exact load.

Guest UID1000/network none/Unix socket,2CPU/4GiB/512PIDs; separate trusted gateway0.5CPU/128MiB/32PIDs;
read-only roots, dropped caps, no-new-privileges/default seccomp/AppArmor, bounded tmpfs/logs. No Docker
socket/devices/production mounts or browser-sandbox weakening. Claim devports5180–5299; never1533/5173.
Independent alive watchdog before launch: exact new label, at most1800s deadline,90s heartbeat,
nominal5s samples, fail closed on measurement/log failure, floors or home+socket reaching10GiB.
Monitoring is not quota. Preserve stop intent/lock/dead-zombie rejection/emergency exact-label kill,
recorded PID/start/group/timeout descendant cleanup, healthy Moss and independent closure. Actively
supervise and finish well before60min. Preserve every home/archive/receipt; publish sanitised evidence.
Integrated candidates need their own reviewed safety/egress/auth contract before runtime; the offline
prerequisite envelope is not an implicit product networking design.

## Accepted checkpoint and references

- [Persistent desktop spec](../specs/2026-10-23-moss-computer-persistent-desktop.md), especially§21–22.
- [r11 report](../../evidence/moss-computer/2026-10-23-startup-readiness-r11.md),
  [JSON](../../evidence/moss-computer/2026-10-23-startup-readiness-r11.json),
  [exact packet](../plans/2026-10-23-moss-computer-startup-readiness-r11.md), and
  [review ledger](../../evidence/moss-computer/2026-10-23-independent-review.md).
- [Window/persistence handoff](2026-10-23-moss-computer-window-persistence.md) and
  [original persistence handoff](2026-10-23-moss-computer-persistence.md): prerequisite acceptance
  cases and inherited protections, not a demand to repeat accepted startup/recovery cases.
- [Original startup handoff](2026-10-23-moss-computer-startup-readiness.md): access controls,
  exact-image archive gate and supervision/closure reference. Its old integration exclusion applied
  to that closed assignment, not this new dispatch.

Accepted r11 packet `be5359b437b4f3b2df5a74028797aa29c82d60a1`; final evidence commit
`d0f2cfaea5ccece7c521e7a5c90adb4b797edf1d`, draft PR #3598. Independent launch/closure/exact-final
reviews accepted bounded startup/protected-viewer/fresh-input PASS. Drivers0/1/1/0, real connected
UI/RFB, attached visible1280x800 canvas/345 sampled colours and exact fresh viewer-keyboard file
readback passed. Runner/watchdog/cleanup/port release/operator closure0; no owned runtime/keys remain.
Two short monitor samples grant no sustained-fit claim. Active Firefox sandbox/clean profile flush/
replacement persistence, idle lifecycle and owner integration are still unqualified.

Private sibling `../moss-computer-readiness-r11/` retains scripts, receipts, home and marker; its
credentials were deleted. Earlier roots are read-only evidence; the exact archive is
`../moss-computer-reconstruct-r2/candidate-image.tar`. Adopted image:
`sha256:c84e2db2add5f4c3c5073c7f021f6a2b4a04866948f7a5c4c47437c0d5d9ffbf`.
Its entry-present/later-absent observation is unexplained; r11 performed one reviewed exact restore.
Complete RFB handshakes corrected a definite probe defect. The r10 blacklist trigger remains a
supported hypothesis without an actual-backend differential; r7's earlier502 cause remains UNKNOWN.
