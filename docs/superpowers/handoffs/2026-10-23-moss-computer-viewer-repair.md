# Repair the Computer viewer and finish the bounded persistence proof

Ben requested a fresh session to fix the viewer connection failure discussed after the explanation
of persistence qualification. This is a new diagnosis/fix dispatch. Preserve the approved chat
design and existing implementation; investigate the r12 failure, fix a supported cause, and finish
the missing persistence checks within the inherited protections. Implementation remains authorised
under the [implementation handoff](2026-10-23-moss-computer-implementation.md).

## Start

1. Stay in the isolated worktree/branch assigned at launch. Read `AGENTS.md`, `CLAUDE.md`,
   `docs/DEVELOPMENT_STANDARDS.md`, the implementation handoff, and the references below. Search
   Hindsight for decisions and use the codebase graph for code discovery. Use the repository's
   diagnosing/plan-build guidance for diagnosis and committed implementation plans, shared-checkout
   before commits, design-system before UI, and verify-gate before any DB/foundation command.
   Inspect installed dependencies before a scoped frozen install; avoid a broad install by default.
   Keep a small private live-state file outside the repository.
2. Read the r12 report, JSON, exact packet and retained private scripts/logs before making changes.
   Compare the actual r11 and r12 UI/transport/probe paths, including timing, current noVNC state,
   initialization and diagnostics. Finish this step with a documented hypothesis tied to evidence
   and a discriminating static/offline check. Cause is UNKNOWN; the observed `/package.json` 404
   also occurred in passing r11 and is not causal proof. Preserve all old artifacts read-only.
3. Implement the smallest supported repair in this branch and test the real affected call site.
   Commit the diagnosis, repair and a new exact launch packet before runtime. Preserve current
   connected UI/RFB, visible-frame and fresh-input assertions; improving diagnostics is welcome.
   A passing synthetic probe alone cannot qualify the desktop. Obtain independent read-only review
   of the exact candidate, actual artifacts and launch readiness; reviewers do not author fixes.
4. This dispatch permits at most ONE new bounded offline runtime attempt after a supported repair,
   fresh admission, committed exact packet and independent acceptance. Use a fresh unused identity,
   private root/home/socket/keys and claimed port. Recheck admission immediately before launch.
   A failed admission or hard assertion ends that attempt: retain evidence and close resources;
   no waiting, resampling, retries, increased deadlines, reclamation, restarts or host substitution.
   If offline evidence cannot support a repair, record the unresolved cause instead of blindly
   replaying r12. Do not consume the attempt merely to repeat its known timeout.
5. On that attempt, require complete guest TCP/Unix WebSocket/gateway RFB initialization and access
   controls, then real current UI/RFB connection, visible nonblank frame and fresh viewer input.
   Complete active Firefox sandbox checks, clean browser shutdown/profile flush, file/bookmark
   negative controls, desktop replacement on the same designated home, unchanged durable hashes,
   and fresh browser UI/input readback. Follow the r12 packet's precise acceptance sequence.
   Record PASS only for observed predicates; use NOT_RUN for unreached checks.
6. Independently verify exact-label/process/listener/port/key closure and healthy Moss, then review
   exact final evidence. Commit/push scoped work and a draft PR stacked on the actual unmerged
   dependency. Update the qualification ledger with honest limits. Leave the tree clean. Continue
   independent implementation under the original handoff where prerequisites permit, with a
   committed bounded plan before code. No production deployment, merge or premature issue closure.

## Current checkpoint

- Base before this handoff: `588f47612c8e56b862912f26c09099c8a3fb25f3`, branch
  `feat/moss-computer-owner-access`, draft [PR #3607](https://github.com/motioneso/moss/pull/3607),
  stacked on unmerged draft #3598 (`qualify/moss-computer-startup-readiness-r9`). Recheck live status
  before choosing the next PR base; preserve the unmerged stack. Task #3605 / parent #3577 and
  qualification #3578 remain open.
- Internal `apps/api/src/computer/input-control.ts` is implemented, independently reviewed at
  `f7a26e6f3802160c018ec45030ce8fe2c4e809b5`. It is not wired to the real desktop, UI or transport.
  Session-bound, generation-fenced watch/takeover/return and `closeViewer` pass 28 unit tests;
  root TypeScript, scoped lint, file-size, formatting and whitespace checks passed. Removing only
  the close generation guard produced two failures; restoring it returned 28 passes.
- `closeViewer` freshly authorises and generation-checks return from the controlling viewer, then
  disconnects even if return fails. Watcher close preserves existing authority. Unexpected
  disconnect remains fail-closed. Reuse this policy when wiring the actual receiving input path.
- r12 packet `6006873f4` exhausted the previous dispatch's single runtime attempt. Complete backend
  readiness and protected access passed; current noVNC UI/RFB connection timed out after 20 seconds.
  Frame/input/Firefox sandbox/clean flush/replacement were NOT_RUN. Independent closure passed.
  This establishes neither data loss nor a persistence failure.
- Accepted r11 final evidence `d0f2cfaea5ccece7c521e7a5c90adb4b797edf1d` proves bounded startup,
  protected viewing and fresh input: complete initialization, drivers 0/1/1/0, current connected
  UI/RFB, visible 1280x800 canvas with 345 sampled colours and exact viewer-keyboard file readback.
  It proves neither active Firefox sandbox nor replacement persistence or product ownership.

## Approved product behavior

Computer belongs in the chat drawer. Full-screen chat has a recent still thumbnail; an expanded
viewer sits beside the conversation, with a compact entry for narrow drawers/phones. Watching does
not take over. Intentional close by the controlling viewer returns control to Moss, as does Return
to Moss. Unexpected disconnect or a failed return retains the fail-closed policy. Keep copy concise
and remove visible “screenshot” labels and explanatory tutorials. The revised layout is approved;
no further mockup delivery or Taildrop is requested.

Real Moss owner HTTPS/WSS and active-session revocation, a sole receiving input writer with stale
queue exclusion/key release, actual UI wiring, installed storage/lifecycle/idle behavior and confined
Internet egress remain open. The internal controller and prototype checks do not establish them.
Keep app-map declarations truthful with any product change and update affected dev/prod configuration
when adding requirements. The offline proof's synthetic certificates are not product authentication.

## Runtime envelope

Inherit the original implementation handoff and r12 packet's complete protections. Floors are
RAM/root each at least 8 GiB, data at least 30 GiB, and healthy Moss at entry and prelaunch.
Adopted image only:
`sha256:c84e2db2add5f4c3c5073c7f021f6a2b4a04866948f7a5c4c47437c0d5d9ffbf`.
If absent, verify retained archive/config/all seven layers afresh and obtain independent
restoration-readiness acceptance before at most one bounded exact load; no substitution.

Guest UID 1000/network none/Unix socket, 2 CPU/4 GiB/512 PIDs; separate trusted gateway
0.5 CPU/128 MiB/32 PIDs. Read-only roots, dropped capabilities, no-new-privileges, default
seccomp/AppArmor and bounded tmpfs/logs. No Docker socket, devices, production mounts or browser
sandbox weakening. Claim a devports port from 5180–5299; never 5173 or 1533.

Independent alive watchdog before launch: exact fresh label, at most 1800 seconds, 90-second
heartbeat, nominal 5-second samples, fail closed on measurement/log failure, floor breach or
home+socket reaching 10 GiB. Monitoring is not quota. Retain stop intent/lifecycle lock,
dead/zombie rejection, emergency exact-label kill and recorded PID/start/group descendant cleanup.
Actively supervise and finish well before 60 minutes. Independently close browser/watchdog/
guest/gateway/network/listener/reservation and delete ephemeral keys. Preserve homes, archive,
scripts and receipts. Publish sanitised evidence only. Real visible DOM/network/input acceptance
cannot be replaced by captures, stubs or interception. Useful Internet access needs its own reviewed
confined egress contract; this dispatch uses the inherited offline envelope.

## Evidence and private artifacts

- [r12 report](../../evidence/moss-computer/2026-10-23-persistence-r12.md),
  [JSON](../../evidence/moss-computer/2026-10-23-persistence-r12.json),
  [packet](../plans/2026-10-23-moss-computer-persistence-r12.md).
- [r11 report](../../evidence/moss-computer/2026-10-23-startup-readiness-r11.md),
  [JSON](../../evidence/moss-computer/2026-10-23-startup-readiness-r11.json),
  [packet](../plans/2026-10-23-moss-computer-startup-readiness-r11.md).
- [Independent review ledger](../../evidence/moss-computer/2026-10-23-independent-review.md),
  [owner-control plan](../plans/2026-10-23-moss-computer-owner-control.md),
  [foundation report](../../evidence/moss-computer/2026-10-23-owner-control-foundation.md).
- [Persistent desktop spec](../specs/2026-10-23-moss-computer-persistent-desktop.md),
  [approved mockups](../specs/2026-10-23-moss-computer-chat-mockups.html), and the implementation
  handoff's window/persistence references for inherited acceptance details.

The worktree is placed beside the old one so private sibling roots remain usable:
`../moss-computer-persistence-r12/` contains retained failed-run scripts/logs/home/receipts;
`../moss-computer-readiness-r11/` contains accepted scripts/receipts/home;
`../moss-computer-reconstruct-r2/candidate-image.tar` is the retained archive;
`../moss-computer-implementation-private/` contains controller verification receipts and prior state.
Earlier credentials were deleted. Resolve these from the assigned worktree, never edit historical
roots, and create a distinct private root for new artifacts. If a reference is absent, report that
specific missing prerequisite; do not rebuild or rewrite history to fill the gap.
