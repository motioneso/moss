# Vocci production replacement dispatch observation

Task #3565; related #3584 remains open. Approved scope comes from the initial
ring setup, automatic delivery and Android Hardware specifications, and the
two 2026-10-24 recovery continuation handoffs. Baseline: merged #3626,
`02e579a9b18a3a56f121c7d3cc5e49a018f49db9`. Exclusive runtime ownership was
explicitly transferred to `vocci-production-proof` before this plan.

## Bounded outcome

Install one reviewed signed production release containing the merged exclusion
correction and observe the actual new package-replacement receiver and service
before any post-update activity, Start command or UI traversal. Reopen native
diagnostics afterwards to verify saved identity, enabled delivery, separately
disabled hold/cleanup and visible queue preservation. No recording is needed.

No product change is presumed. Earlier #3625 dispatch and kill-gate claims are
withdrawn: exact PENDING/SKIPPED never establishes delivery, even beside a real
service. Keep original receipts unchanged and save every new failure before
assertions. An update without pending work is not interrupted-upload proof.

## Verified seams

- `apps/vocci-delivery/AndroidManifest.xml:20`: connected-device foreground
  service; lines 21–25 declare the actual replacement/boot receiver.
- `apps/vocci-delivery/src/ai/moss/vocci/DeliveryRecovery.java:9`: saved enabled
  choice, Nearby devices permission and encrypted setup gate service recovery.
- `apps/vocci-delivery/upgrade-proof/replacement_broadcasts.py:5`: exact record
  header/Intent package/action selection, excluding historical summaries.
- `apps/vocci-delivery/upgrade-proof/replacement_broadcasts.py:21`: exact named
  receiver/package delivery state; `receiver_delivered` at line 34.
- `apps/vocci-delivery/upgrade-proof/recovery.py:97`: baseline record identities,
  real replacement, bounded observation and retained failed receipt. Its fixture,
  private-file reads and uninstall lifecycle cannot target production.
- `apps/vocci-delivery/build.sh:13`: existing release signing/version interface;
  lines 37–48 strip debugging, cleartext and instrumentation. The README's Release
  packaging section requires original signing identity and prohibits uninstall.
- Retained private native observer reads actual DeliveryActivity controls and
  hashes the displayed setup identity; inspect before reuse. It can observe UI,
  not assert inaccessible release private-file or Keystore hashes.

## Execution and checks

1. Recheck authorized physical identity, availability/unlock, installed API/version,
   UID, service state, permission handoff and original timeout privately. Establish
   saved setup/choices/queue through actual native diagnostics before replacement.
   If unlock is unavailable, record the exact prerequisite and continue independent
   build/observer preparation without installing.
2. Run `apps/vocci-delivery/test.sh` (expected exit 0). Recheck the retained candidate
   APK hash, signed certificate against the actual installed APK, release manifest,
   strictly increasing version and every packaged production Java digest against
   reviewed merged main. Reuse the retained release only if all checks pass;
   otherwise build using inspected original signing procedures. Never copy secrets
   into arguments, public logs or git.
3. Commit this plan before creating proof changes. A private observer uses only the
   explicit authorized ADB target. Capture baseline broadcasts/services, install
   in place once, then save bounded new-record dumps and service observations.
   Assert exact receiver delivery and a real foreground service separately. No
   force-stop, synthetic broadcast, instrumentation or UI action in this interval.
4. Save immutable dispatch verdict before UI. Reopen actual diagnostics and compare
   identity/choices/queue; inspect installed version/UID and signing identity.
   Preserve the original timeout, intentional official-app permission handoff,
   Keystore, evidence, exclusions and originals. No completed-source replay,
   summary retry, reboot, server deployment, deletion or binding operation.
5. If recovery fails, minimize the captured symptom and publish 3–5 ranked
   falsifiable hypotheses before testing a product change. This slice may deliver
   an accurately bounded diagnosis rather than an unverified fix. Keep failures
   failed; uncertainty is not successful dispatch.
6. Record bounded public evidence. Run scoped Prettier and `git diff --check`
   (expected exit 0), independent code-review Standards and Spec on immutable
   commits, resolve/re-review actionable findings, then require green CI before
   the authorized merge. Keep #3565/#3584 open. Push explicit paths, remove owned
   build scratch and pass the remaining actionable queue to a verified fresh
   isolated session with explicit ownership transfer.

Verification commands run unpiped with actual exit codes. No DB command is
needed. Private receipts live outside git under
`~/.local/state/moss/vocci-recovery/production-proof/`.

## Decision and completion boundary

Prefer observation of the existing recovery path because the earlier observer
was unsound. A receiver/service change might be justified by a reproduced failure,
but applying one before observing the corrected production path would lose the
baseline. The executing owner ends this diagnostic with narrow acceptance only
if exact dispatch, service and retained native state all pass; otherwise it records
the specific failed/unknown criterion and investigates it.

All feedback comes from actual OS/native records. No UI or model behavior changes
are planned; there is no model job or app-map behavior change in this proof slice.
