# Vocci: isolate replacement package cleanup

Task #3565; #3584 remains open. Approved setup, automatic-delivery and Android
Hardware specifications remain the scope. Baseline: merged #3631,
`b225e2189bf3acca671089a99f8e49c9f5405f2f`.

## Bounded outcome

Inspect the actual shipped late-removal producer and obtain a red-capable
disposable replacement reproduction that distinguishes framework package cleanup
from receiver/service failure. Preserve production delivery and original receipts.
No product recovery rewrite or production replacement belongs to this phase.

## Existing seams and unknowns

- `apps/vocci-delivery/src/ai/moss/vocci/DeliveryRecovery.java:10` checks the
  replacement action, saved enabled choice and permission before loading setup
  and starting the service. A framework pre-dispatch skip bypasses these branches.
- `apps/vocci-delivery/AndroidManifest.xml:21` declares the manifest receiver;
  the service is declared at line 20.
- `apps/vocci-delivery/upgrade-proof/replacement_broadcasts.py:34` tests delivery
  for the exact receiver. PENDING, SKIPPED and unrelated records cannot pass.
- `apps/vocci-delivery/upgrade-proof/UpgradeFixture.java:25` creates generated
  local configuration and queue data. Its initialization and any instrumentation
  lifecycle may confound dispatch; inspect that path before reusing the fixture.
- `apps/vocci-delivery/upgrade-proof/recovery.py:126` observes replacement, but
  its service text check is weaker than the private production observer's matching
  live-PID requirement. Do not inherit that acceptance shortcut.
- `docs/evidence/vocci/2026-10-24-api37-package-cleanup-diagnosis.md:38` narrows
  the shipped skip to package cleanup. The exact late-removal producer, ordering
  and reproducibility remain open questions owned by this session.

The retained exact-failure replay exits 1 with SKIPPED/service absent. It is a
stable symptom check, not a test of a new mitigation. This diagnostic phase may
inspect shipped call paths to construct a new live reproduction; it cannot claim
a fix from the replay or static evidence alone.

## Phase 1 and kill gate

1. Preserve original digests. Inspect helpers before reuse. Reidentify the
   authorized phone privately, with an explicit serial on every ADB call. Recheck
   actual production version and matching foreground-service PID using read-only
   queries; do not open production UI or change choices.
2. Inspect shipped package-removal producer/call paths, retaining artifact digests,
   focused Java/smali locations and extraction limitations. Distinguish static
   relationships from captured runtime calls.
3. Build only a newly owned disposable app/fixture, refusing any existing install.
   Use generated closed-loopback data and no real credentials or ring access.
   Capture exact new receiver records and corresponding service/live PID before
   UI/manual intervention. A minimal receiver marker may distinguish entry from
   service behavior; disclose fixture differences and retain source/APK hashes.
4. Compare one controlled variable at a time. Preserve every failed run; require
   exact target delivery for positive acceptance. Bound experiments rather than
   repeatedly installing production. Remove only the owned disposable package and
   confirm absence; release claimed devports and stop owned processes.
5. Kill gate, owned by this session after independent review: if unprivileged
   evidence cannot distinguish the producer/order or provide a useful live seam,
   record the exact missing probe and limits. Advance independent actionable work
   from the approved queue instead of handing on an unchanged blocker.

A supported product mitigation needs a separately committed amendment, behavioral
regression and negative controls, truthful app-map metadata and installed proof.
This phase changes no user-facing surface or model work; no new app-map behavior.

## Verification and finish

- `python3 ~/.local/state/moss/vocci-recovery/production-proof/replay_exact_failure.py`:
  expected exit 1; unchanged retained failure, run from this worktree.
- `python3 ~/.local/state/moss/vocci-recovery/skip-diagnosis/verify_findings.py`:
  expected exit 0; original digests and retained static/log assertions only.
- New private disposable runner: record its exact command, expected/actual exit,
  source/APK digests, exact receiver states, live-PID result and cleanup per case.
  Missing receiver/action and unrelated/stale service evidence must fail acceptance.
- `python3 -m unittest discover -s apps/vocci-delivery/upgrade-proof -p test_replacement_broadcasts.py`:
  expected exit 0. Parser checks do not prove recovery.
- `pnpm exec prettier --check <explicit changed Markdown paths>` and
  `git diff --check`: expected exit 0; all commands unpiped.
- Independent Standards/Spec review pins immutable base/head and private evidence.
  Resolve and independently re-review findings, require green CI, then perform
  the authorized merge. Keep tasks open for their remaining acceptance.
- Commit/push explicit paths and leave the worktree clean. A verified fresh
  isolated successor receives actionable remaining work and explicit exclusive
  ownership only after actual execution and immutable session ID acknowledgment.

No reboot, new recording, unlock request, permission/timeout/production-choice
change, completed-source replay, deletion, rebind, firmware or server deployment.
No production uninstall/clear-data or blind reinstall. Any future release must
freshly verify provenance/signing/availability/choices and exceed actual version.
