# Continue Moss Computer: one recovery proof

Ben requested a fresh session to continue after candidate reconstruction. Full autonomous
planning/implementation authority persists; provider agnostic, repository guidelines and bounded
independent review apply. This dispatches the next recovery assignment, including amending and
reviewing its packet before runtime. Do not ask again for routine implementation permission.

## Start

1. Stay in your new isolated worktree/branch `fix/moss-computer-recovery`. Parent work is
   `docs/moss-computer-qualification`, draft [PR3579](https://github.com/motioneso/moss/pull/3579),
   reconstruction result commit `b65c0835010887228915f1f13664a2781e6be5ef` plus this handoff.
   Existing [task3578](https://github.com/motioneso/moss/issues/3578) and
   [parent3577](https://github.com/motioneso/moss/issues/3577) remain open. Do not restart MC0.
2. Read `AGENTS.md`, `CLAUDE.md` and relevant `docs/DEVELOPMENT_STANDARDS.md` rules. Use the
   diagnosing-bugs skill for diagnosis and shared-checkout skill before commits. Search Hindsight
   for relevant decisions, but the committed evidence supersedes stale memory. Prefer the graph
   for code discovery. No DB/foundation command without the verify-gate skill.
3. Read the five references below, not entire histories. Check the selected server, exact image
   and private artifact locations read-only. No substitute host or silent rebuild.
4. Amend/commit the recovery packet for the adopted image, new run and active finish operator.
   Get independent review of exact runtime configuration/supervisor/instrumentation before launch.
   You may delegate bounded investigation and independent review; the reviewer must not author fixes.
5. Prepare a fresh bounded run, qualify baseline/affected controls, diagnose recovered rendering
   and fresh input. Finish actively, independently review exact evidence, commit/push and stop.

## References, in order

- `docs/evidence/moss-computer/2026-10-23-candidate-reconstruction.md` and `.json`:
  reconstructed candidate, package/config/archive comparison and next proposal.
- `docs/evidence/moss-computer/2026-10-23-independent-review.md`: exact independent verdicts.
- `docs/superpowers/plans/2026-10-23-moss-computer-recovery-qualification.md`: original recovery
  packet; its missing-original-image preflight is historical, not a launch packet for the rebuild.
- `docs/superpowers/specs/2026-10-23-moss-computer-persistent-desktop.md`: destination and boundaries.
- `docs/evidence/moss-computer/2026-10-23-runtime-receipt.json` and related isolated qualification
  report: earlier successes and retained failures, tied to a different exact image.

## Accepted candidate, not accepted runtime

New Linux/amd64 image:
`sha256:c84e2db2add5f4c3c5073c7f021f6a2b4a04866948f7a5c4c47437c0d5d9ffbf`.
Tag: `moss-computer-qualification:reconstruct-20261023-r2-candidate`.
Independent verdict: **PASS — ADOPT_FOR_LATER_RECOVERY_TRIAL** only.

Private artifact roots are siblings of this worktree root, not under the canonical `~/Jarv1s`:

- `../moss-computer-reconstruct-r2/`: retained `candidate-image.tar`, checksum, `STATE.md`, raw
  `receipts/` (comparison, inventories, prior config, build/probe logs, reviewed supervisor/recipes).
- `../moss-computer-proof-r1/`: earlier scripts/receipts, retained synthetic home/profile.
  Relevant scripts: `recovery-final.mjs`, `recovery-check.mjs`, `manual-recovery-check.mjs`,
  `reload-recovery-check.mjs`, `supervise.py`, successful viewer/access/replacement scripts.

Archive: 1,026,041,856 bytes, SHA-256
`48cdd56f8d026af02c873513d36c86ab48b3b9e0b169cefe7a4f2ab7a1ceb4f9`.
Its config hash equals the new image ID; author verified every layer digest and tar contents;
independent reviewer checked archive checksum/config/layer-list identity. If image is missing,
verify the retained archive before bounded loading. Do not silently reconstruct another candidate.

All400 Debian package records match final prior `packages-r2.txt` byte for byte; earlier
`packages.txt` has396 records and is the wrong final baseline. Websockify0.13.0 unchanged.
NoVNC1.3, TigerVNC1.12, Xfce4.18, Firefox ESR153.5.1. Image source bytes match tracked source;
derived recipe adds only a run label. Config changes: run label and ArgsEscaped true→absent with
legacy builder; same Linux user/JSON command/entrypoint/environment. Matching inventories do not
establish filesystem/runtime equivalence. Apt inputs remain mutable.

Original image `5516b804...` disappeared; cause UNKNOWN. Its historical evidence is preserved,
not transferred. No desktop/viewer/runtime trial ran on the rebuilt image. Reconstruction build
clients/supervisors/inspection containers were closed, no port/keys/listener created, prior home
preserved and Moss healthy. Fresh headroom still needs inspection; snapshots are not benchmarks.

## Exact remaining symptom

Earlier crash transport reconnect PASSED. In `recovery-final.mjs`, the UI.connected assertion
passed after restart; the subsequent qualifying-canvas assertion timed out. Fresh recovered input
was not reached. Backend logs showed real RFB handshakes/updates. Root cause UNKNOWN.

Do not repeat a bare timeout or claim the socket failed. Capture the failed page while still open:
UI/RFB state, attached/hidden/detached canvas count/dimensions/target container, actual framebuffer
update/colour metadata, bounded console errors and relevant WebSocket/backend-close events.
The old exact1280×800 assumption was removed, yet a nonzero canvas check still failed. An invisible
Connect-button selector was a harness failure, not proof manual recovery is impossible.

Build a red-capable real-path loop, minimise, present3–5 ranked falsifiable hypotheses before
testing and change one variable at a time. No screenshots, response mocks or stubbed success.
Two identical failures require a design/scope decision. Compare a minimal correction with a pinned
maintained viewer update only if source/runtime evidence warrants it; no blind upgrades.

## Runtime and acceptance boundaries

- Same server runs the companion; MacBook Air or server is Ben's viewing device. This proof is
  server-local automated mechanics, not Ben manual/MacBook acceptance. No AI/provider calls.
- Current design: offline UID1000 desktop, no network, read-only root, no capabilities/devices or
  host Docker socket; Websockify Unix socket; separate trusted Nginx serves packaged noVNC.
  Synthetic mTLS plus exact WS Origin on a reserved loopback listener, not Moss owner authentication.
- Desktop2CPU/4GiB/512PIDs; gateway0.5CPU/128MiB/32PIDs. Default seccomp/AppArmor and browser
  sandbox stay enabled. Prior Firefox diagnostics: effective sandbox6/seccomp, user namespaces
  unavailable; no Internet/full namespace isolation claim.
- New unique runtime directories/labels, fresh ephemeral proof identities, `devports claim`, no
  production network/volumes or old-home reuse/deletion. Old ephemeral keys were removed; do not
  relaunch old Compose blindly. Inspect exact resolved config before launch.
- Independent fail-closed watchdog: deadline, lost heartbeat, measurement failure, low memory/disk,
  sampled10GiB writable home/socket threshold (not quota), bounded tmpfs/logs. Adapt old supervisor's
  hardcoded proof-r1 fallback label to the new run; stopping/verification must precede receipts.
- Name this fresh Codex session as active automated finish operator. Maximum60 minutes, finish
  comfortably earlier; no timer-only completion. No human timed proof without Ben's attendance.
- Establish substantive baseline frame/input and affected access/isolation checks on this image.
  Crash guest, observe disconnect, check Moss healthy, restart through fixed host operation and
  prove a substantive recovered frame plus a fresh keyboard-written synthetic file marker.
  Record whether action is automatic, reload, fresh page or button. Host launch/window activation
  may prepare a terminal; marker creation must actually use viewer input.
- Record exact image/source/config hashes, run/container IDs, finite exits, resource phases,
  failed/not-run cases and review. Close RFB/browser, guest/gateway/watchdog/network; remove only
  owned labelled runtime, release port, remove ephemeral keys, retain designated home and archive.
  Verify production health and no owned runtime/process remains before final acceptance.

## Product destination and stop

Always-on owner-only persistent desktop inside Moss, manual desktop/browser/terminal first.
Designated files/profile survive actual replacement; no process/package persistence or permanent
website-session promise. New installs default-on with opt-out/resources; existing installs add-on;
disable preserves data, deletion separate. Agents/watch/stop/takeover/jobs and release work later.
Do not replace this with a browser selector, widen Sports or build reusable proof infrastructure.

Own only Computer spike/spec/plan/evidence files. One coordinated owner for later shared boundaries;
no production/shared auth/AppShell/installer changes here. No platform, Internet, Moss owner/session,
download or replacement-persistence acceptance follows from recovery alone. Existing guide mappings
and release gates remain intact; News and Direct On stay independent.

Use a concise coordinator ledger and bounded reference-based reports. Aim for one context without
guaranteeing it; stop/split before capacity or report-round limits, not a relay chain. Preserve
material failures. Stop with independently reviewed recovery PASS or evidence-backed rejection,
one next proposal, clean committed/pushed work and no active runtime. Do not merge or close3578/3577.

Use a recovery branch and, if needed, a draft child PR based on `docs/moss-computer-qualification`;
link PR3579 and task3578. Parent session is parked and must not be co-edited. No force push or
automatic parent adoption. Repo docs use relative paths/`~/Jarv1s`; keep private runtime paths out.
Node dependencies already exist in canonical `~/Jarv1s`; targeted proof scripts may resolve
Playwright/ws from that package.json after expanding home. No automatic broad install/test run.
