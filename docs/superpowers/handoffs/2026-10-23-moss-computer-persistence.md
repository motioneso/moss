# Continue Moss Computer: adopted-image sandbox and replacement persistence

Ben requested a new agent for the next best section after merging the isolated prototype and
reviewed recovery checkpoint. This dispatches one bounded, actively supervised qualification of
Firefox's active sandbox and actual file/profile survival across container replacement. Existing
autonomous preparation/implementation authority persists; routine permission is already given.

## Start

1. Work only in your fresh isolated branch `qualify/moss-computer-persistence`, based on the
   committed handoff branch `docs/moss-computer-persistence-handoff`, itself based on merged main
   checkpoint `65fc78250fbca425b56e9a9bc9cc2325ce17a804` (PR #3579). PRs #3582 and #3581 were
   consolidated into #3579 and all three are merged. Task #3578 and parent #3577 remain open.
   Parent sessions are parked; own only Computer spike/spec/plan/evidence/handoff files.
2. Read `AGENTS.md`, `CLAUDE.md`, relevant `docs/DEVELOPMENT_STANDARDS.md` sections and the
   references below. Use Hindsight for decisions, graph for code discovery, diagnosing-bugs for
   diagnosis and shared-checkout before commits. No DB/foundation command without verify-gate.
   Targeted Node scripts can resolve Playwright/ws from `~/Jarv1s/package.json`; a broad dependency
   install is unnecessary for the existing proof path. Keep a small private state ledger.
3. Spend at most ten minutes on fresh read-only host/image/resource entry checks. Prior image
   disappearance and reported unexpected Herdr restart causes remain UNKNOWN. Inspect current
   health; do not restart services, prune, repair or expand into infrastructure investigation.
   Stop on failed entry gates, rather than treating unknown historical causes as a current failure.
4. Write and COMMIT a new packet before launch. Name this fresh session as active finish operator,
   exact image/config/run, replacement sequence, browser diagnostics, persistence assertions,
   supervisor/instrumentation and measurable acceptance. Get independent review of exact artifacts
   before launch. You may delegate bounded investigation and independent read-only review;
   reviewers never author fixes. Inspect prior scripts by reference; do not reuse old run identities.
5. Run one fresh supervised proof, preserve material failures, finish and clean up, independently
   review exact final evidence, commit/push and open a draft PR. Return a narrow PASS or an
   evidence-backed rejection plus one next proposal. No automatic merge, issue close or further run.

## Read these references

- `docs/superpowers/specs/2026-10-23-moss-computer-persistent-desktop.md`: destination, scope and
  latest recovery checkpoint. Owner-only persistent desktop remains the product destination.
- `spikes/moss-computer/README.md`, `compose.yaml`, `entrypoint.sh` and `Dockerfile`: current
  offline candidate, actual home/profile paths and launch/security constraints.
- `docs/evidence/moss-computer/2026-10-23-recovery-r4.md` and `.json`, and the final r4 section of
  `2026-10-23-independent-review.md`: exact adopted-image recovery evidence and retained limits.
- `docs/superpowers/plans/2026-10-23-moss-computer-delayed-recovery.md`: safeguards and previous
  exact reviewed launch artifacts, not a ready-to-run command for the new run.
- `docs/evidence/moss-computer/2026-10-23-isolated-qualification.md` and runtime receipt: earlier
  image's sandbox/profile/replacement proof. Acceptance does not transfer to the reconstructed image.
- Read `2026-10-23-candidate-reconstruction.md`/`.json` only if the adopted image needs loading.

Private retained directories are siblings of the worktrees: `../moss-computer-recovery-r4/`
contains `STATE.md`, corrected recovery/access/isolation scripts, supervisor, receipts and synthetic
home. `../moss-computer-recovery-r3/` retains the preceding proof. Reconstruction archive and
receipts are in `../moss-computer-reconstruct-r2/`; original proof references in
`../moss-computer-proof-r1/`. Leave all prior homes, scripts, receipts and archive intact. Store new
runtime data outside the repository; commit only sanitised evidence and private references.

## Exact candidate and known-good scope

Adopted Linux/amd64 image:
`sha256:c84e2db2add5f4c3c5073c7f021f6a2b4a04866948f7a5c4c47437c0d5d9ffbf`.
Tag `moss-computer-qualification:reconstruct-20261023-r2-candidate`.
noVNC 1.3 / Websockify 0.13 / TigerVNC 1.12 / Xfce 4.18 / Firefox ESR 153.5.1.
If absent, verify retained archive checksum/config/all seven layer digests before a bounded exact
load. Archive size 1,026,041,856 bytes, SHA-256
`48cdd56f8d026af02c873513d36c86ab48b3b9e0b169cefe7a4f2ab7a1ceb4f9`.
No silent rebuild, viewer upgrade, substitute image/host or security weakening.

r4 qualified one approximately 13.4-second guest outage followed by one explicit browser reload,
new UI/RFB connection, substantive visible frame and fresh viewer-keyboard file. It observed failed
automatic retry and a real stopped-guest 12-second frame assertion failure. It did not qualify
active rebuilt-image Firefox sandbox or profile/replacement persistence. Prior runtime was closed,
port 5189 released, ephemeral keys removed, retained data preserved and Moss healthy; inspect fresh.

Installed Playwright 1.60.0 returned immediately for an async false wait predicate. Preserve the
corrected synchronous polling of actual noVNC UI/current RFB state. A socket or detached/stale
canvas is insufficient: require attached visible canvas with positive viewport intersection,
at least 100 by 100 pixels and at least ten sampled colours, plus fresh real viewer input.

## One real-path acceptance loop

Use fresh synthetic data and a unique run/home/socket/labels/identities. Prepare ranked falsifiable
hypotheses before fixes; change one variable at a time. Two identical failures require scope stop.

1. Establish real desktop viewing and fresh keyboard input; check current-image access/isolation
   and resource controls. Host actions may prepare/activate terminal windows, but marker commands
   must traverse actual viewer input. Use the actual Firefox binary and dedicated persistent
   profile with the offline packaged fixture; record process arguments, relevant environment and
   actual active sandbox diagnostics/content-process evidence. Follow the full receiving path
   before claiming a security property. Distinguish browser sandbox from container isolation.
2. Through real desktop/browser input create a unique designated file and unique bookmark or
   equivalent persistent browser state. Record the actual profile path and durable bytes/state;
   prove the values were absent before creation. Close Firefox cleanly and verify flushed state.
   Construct red-capable checks for the claimed persistence, with safe disposable negative controls
   reviewed in the packet. Retain the real proof home unchanged during controls.
3. Remove and recreate the guest container from the exact same adopted image, reusing only its
   designated home. Record full before/after container IDs, image ID, resolved mounts, operation
   exits and timestamps. A restart alone does not qualify replacement. Start a fresh Firefox
   process against the same profile and prove the exact file and browser state through real UI
   and readback, plus fresh viewer input. Host-written bookmarks or synthetic success do not qualify.
4. Verify active sandbox evidence again after replacement and ensure no sandbox-disable flags,
   environment overrides or container-profile relaxation were introduced. Preserve uncertainty;
   inability to substantiate the active sandbox is a rejection, not permission to weaken it.
5. Close browser, guest, gateway and watchdog; remove only owned labelled containers/network,
   listener/reservation and ephemeral keys. Retain the new synthetic home plus all prior data.
   Verify no owned runtime/process/listener remains and Moss is healthy before final acceptance.

## Runtime bounds and finish

Use `devports claim` for a fresh reserved loopback port. Retain offline UID 1000 guest network none
and Unix socket; separate trusted Nginx bridge gateway, synthetic mTLS plus exact Origin. These are
proof identities, not Moss owner authentication. Desktop at most 2 CPU / 4 GiB / 512 PIDs; gateway
0.5 CPU / 128 MiB / 32 PIDs. Read-only roots, dropped capabilities, no-new-privileges, default
seccomp/AppArmor, browser sandbox, bounded tmpfs/logs; no devices, Docker socket or production mounts.

Independent fail-closed watchdog must have the exact fresh fallback label, alive/healthy sample
before launch, deadline at most 30 minutes, heartbeat 90 seconds, nominal five-second sampling.
Stop on measurement/log failure, available RAM or root free below 8 GiB, data free below 30 GiB,
or sampled home/socket size reaching 10 GiB. Monitoring is not a quota; host browser/daemon work is
outside guest caps. Finish actively well before the 60-minute outer limit. No unattended runtime
or Ben manual session is dispatched. Record full IDs and supervisor numeric exit this time.

Open a draft child PR based on `docs/moss-computer-persistence-handoff` while its handoff PR is
pending; if that base has merged, use main and remove duplicate history appropriately. Link #3578,
#3577 and merged #3579. Keep historical causes and uncovered cases explicit. Preserve News/Direct On
and guide gates independently. No owner/session/UI/download/Internet/installer/platform work or
reusable proof-tool expansion; no production changes. Product changes, if separately authorised
later, require truthful app-map metadata in the same PR.

## What Ben can test on Main

PR #3579 preserved the isolated spike and evidence. Building the normal Moss image does not enable
Computer or add a Computer screen. There is no new Main-app desktop acceptance test yet; ordinary
Moss login/chat/navigation checks only confirm normal app health. Actual desktop manual acceptance
needs a separately prepared private viewer and confirmed attendance. Return the next proposal
after this qualification; do not silently turn this assignment into owner integration or a manual run.
