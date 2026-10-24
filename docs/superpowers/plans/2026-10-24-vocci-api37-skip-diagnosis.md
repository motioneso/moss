# Vocci: actual API 37 replacement skip diagnosis

Task #3565; #3584 remains open. Approved scope: existing-ring setup,
automatic delivery and Android Hardware specifications dated 2026-10-21,
2026-10-20 and 2026-10-23. Baseline: merged #3630,
`5262ab2d5bf7ee12b8905e013f15f8f8b52c21e0`.

## Bounded outcome

Determine which installed-platform policy can produce the retained production
`DeliveryRecovery` SKIPPED/`mBroadcastConsumerSkip` observation. This slice begins
with read-only package/platform evidence, preserving daily delivery and original
failure receipts. It does not schedule another unmodified replacement.

The inspected private `production-proof/replay_exact_failure.py` ran from
`~/Jarv1s/.claude/worktrees/vocci-skip-diagnosis`: exit 1, exact state SKIPPED,
receiverDelivered false, service absent, minimized record matches original.
This deterministic replay establishes the captured symptom; it cannot prove a
future platform fix or new dispatch. A supported product fix requires a separate
plan amendment and installed real-path proof.

## Existing seams and constraints

- `apps/vocci-delivery/src/ai/moss/vocci/DeliveryRecovery.java:10` accepts boot
  and package replacement, then checks saved enabled choice and permission before
  loading setup and starting the existing service. A pre-dispatch skip does not
  implicate those receiver branches.
- `apps/vocci-delivery/AndroidManifest.xml:21` declares the non-exported receiver
  and both actions; line 20 declares the connected-device service. Compare with
  actual installed metadata, not only this development manifest.
- `apps/vocci-delivery/upgrade-proof/replacement_broadcasts.py:34` requires
  delivery for the exact receiver. Retained PENDING/SKIPPED is never acceptance.
- `docs/evidence/vocci/2026-10-24-production-replacement-observation.md:11`
  records failed automatic recovery before UI and separate later manual Start.
- Actual API 37/vendor skip implementation and historical policy state remain
  unproved. Owner: this diagnostic session. Obtain readable shipped artifacts
  and relevant non-mutating system-service queries; do not assume older AOSP.

## Ranked falsifiable hypotheses

1. Ordinary package state: stopped, suspended, disabled or unavailable package
   causes rejection. Prediction: retained or current package metadata identifies
   such state. Retained metadata already weakens this explanation.
2. Receiver registration/eligibility: actual installed filter, component state
   or platform receiver rule rejects the target. Prediction: installed metadata
   or the matching shipped implementation identifies that predicate.
3. API 37/vendor broadcast-consumer policy rejects an otherwise eligible target.
   Prediction: shipped code maps the exact token to a consumer/policy branch;
   focused retained logs or read-only policy queries corroborate its predicate.

## Execution and kill gate

1. Preserve hashes of original scripts, exact record, receipt and raw dumps.
   Inspect helpers before reuse. Confirm authorized phone identity and current
   version/service with explicit serial on every ADB call; save private receipts.
2. Query bounded package/platform state, retrieve readable shipped framework
   artifacts and inspect only relevant skip/consumer call paths using REA.
   Preserve artifact digests and distinguish static inference from observed
   execution. Keep identifiers, logs and binaries outside this public repository.
3. Record the smallest substantiated conclusion and counterevidence. No blanket
   package dump or log contents in public evidence. No receiver/service rewrite
   without a supported causal mechanism and falsifiable behavioral regression.
4. Kill gate, decided by this session after independent review: if policy or
   artifact access cannot distinguish causes, publish the exact evidence limit
   and named next probe; do not claim root cause or repeat a blind install. If
   external user/hardware action is required, record it in the live tracker and
   applicable AWAITING-BEN/needs-ben flow, then select independent actionable work.

No UI/model behavior changes in this diagnostic slice; no new model jobs or
app-map declarations. Product changes would require truthful app-map updates.
No clear-data, uninstall, force-stop, rebind, new recording, reboot, permission
change, synthetic broadcast, source replay, summary retry or server deployment.
Any later signed update must exceed the actual installed version and freshly
verify source, certificate, availability and saved native choices.

## Verification and completion

- Retained-failure replay: expected exit 1, exact SKIPPED/service-absent verdict.
- `python3 -m unittest discover -s apps/vocci-delivery/upgrade-proof -p 'test_replacement_broadcasts.py'`:
  expected exit 0. This validates parsing, not successful platform recovery.
- `pnpm exec prettier --check <explicit changed Markdown paths>`: expected exit 0.
- `git diff --check`: expected exit 0. All checks run unpiped.
- Independent code-review Standards/Spec agents inspect immutable base/head,
  supporting private evidence and inference limits. Resolve and independently
  re-review findings; required CI must pass before the authorized merge.
- Commit/push explicit paths, keep #3565/#3584 open, stop owned tools and leave
  this worktree clean. Commit a next handoff that advances the actionable queue;
  verify a fresh isolated successor's execution/session ID before transferring
  exclusive runtime ownership. Never relay an unchanged external blocker.
