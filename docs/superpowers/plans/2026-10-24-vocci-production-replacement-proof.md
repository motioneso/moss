# Vocci production signed-replacement proof

Task: #3565; related remaining Hardware work: #3584. This is the bounded next
slice authorized by the two 2026-10-24 continuation handoffs, after merged #3625
(`6960c0c6af7c357eaac6f5d521d01d767ce6bd4e`). Existing approved specifications:
`2026-10-21-vocci-initial-ring-setup.md`, `2026-10-20-vocci-automatic-delivery.md`
and `2026-10-23-android-hardware-settings.md` in `docs/superpowers/specs/`.

## Outcome and boundaries

Observe actual OS package-replacement dispatch and automatic foreground-service
recovery on the configured production companion, using a reviewed signed release
containing the merged exclusion correction. Observe dispatch/service before any
post-update activity launch, Start command or UI traversal. No new recording is
needed. An update without a pending source proves neither interrupted upload nor
byte-offset continuation.

Preserve package UID, signing identity, Keystore, saved setup, enabled delivery,
separate hold choice, exclusions, queue and retained originals. Do not uninstall,
clear data, rebind, reset, delete sources, change firmware, replay completed imports,
retry old summaries or restore obsolete official-app permissions. No server
deployment or reboot belongs to this slice. Private device/account/signing and
recording evidence remains outside git under `~/.local/state/moss/vocci-recovery/`.

## Existing seams

- `apps/vocci-delivery/AndroidManifest.xml:25`: production receiver handles actual
  `MY_PACKAGE_REPLACED` and `BOOT_COMPLETED`; service is a connected-device FGS.
- `apps/vocci-delivery/src/ai/moss/vocci/DeliveryRecovery.java:9`: enabled choice,
  Nearby devices and encrypted setup gate the real service's `recover` action.
- `apps/vocci-delivery/src/ai/moss/vocci/DeliveryPreferences.java:10`: `recover`
  preserves enabled choice; only explicit Start/Stop changes it.
- `apps/vocci-delivery/src/ai/moss/vocci/DeliveryService.java:70`: recovery enters
  the existing sticky worker; no parallel recovery mechanism is needed.
- `apps/vocci-delivery/src/ai/moss/vocci/DeliveryActivity.java:133`: actual native
  diagnostics expose decrypted identity, enabled choice, hold/cleanup and queue
  state without constructing the write-owning delivery store.
- `apps/vocci-delivery/build.sh:9`: existing release mode takes private signing
  files and an increasing version; strips checks/debugging/cleartext and verifies
  signatures. Reuse this procedure and inspect the resulting actual APK.
- `apps/vocci-delivery/upgrade-proof/recovery.py:97`: the reviewed disposable
  observer distinguishes newly delivered replacement broadcasts from history.
  Its generated fixture and uninstall lifecycle must never target production.

## Phase 1 — preflight, release and one replacement

1. Verify live PR merge/CI, fetch and merge current main while clean, and commit
   this plan before proof changes. Recheck private ownership transfer and phone
   physical identity. Capture actual API/version/UID, package/service state,
   permission handoff and original timeout privately.
2. Obtain actual phone availability/unlock before native preflight. Read current
   saved identity, enabled choice, hold/cleanup and queue through the real UI.
   If locked, record the prerequisite and continue independent build preparation.
3. Run existing host/APK checks. Build release from reviewed merged production
   sources with the inspected original signing material and a version strictly
   above the actual installed version. Verify installed/candidate certificates,
   APK hash, package/version, release manifest and source digests. Stop on mismatch.
4. Capture pre-update broadcast identities, service and UI snapshot. Install in
   place once. Capture newly emitted replacement dispatch and real service state
   in a bounded observation window before any activity launch/manual Start.
   Save the receipt before assertions so a failure remains failed evidence.
5. Then traverse actual native diagnostics and compare saved setup, choice and
   visible queue. Report release/UI behavior separately from the earlier dispatch
   result. Do not claim direct private-file hash equality for a non-debuggable
   release when that data cannot be read. Preserve original timeout and grants.

**Kill gate:** this session ends the product-fix line if actual production dispatch
and service recovery pass. Record only that narrow acceptance. If either fails,
retain the same broadcast/service failure before UI, minimize the actual symptom
and publish 3–5 ranked falsifiable hypotheses before testing a product change.
The executing recovery owner makes this call; uncertain observations stay uncertain.

## Verification and closeout

- `apps/vocci-delivery/test.sh`: expected exit 0, existing host suites and dev APK.
- `apps/vocci-delivery/build.sh release`: expected exit 0 with private environment;
  verify actual signing certificate and release manifest independently.
- One private production observer: expected exit 0 only when new dispatch,
  foreground service and post-update retained native state all pass. Retain an
  exit-1 receipt without rewriting it if the recovery path fails.
- Scoped `pnpm exec prettier --check` on changed Markdown and `git diff --check`:
  expected exit 0. Run verification unpiped; preserve the actual exit codes.
- Independent `code-review` Standards and Spec against immutable base/head, resolve
  actionable findings and obtain independent re-review. Record real installed
  evidence, wait for required green CI, then use the authorized merge.
- Keep #3565/#3584 open. Commit/push explicit paths; remove owned build scratch,
  stop owned tools and leave a clean worktree. Pass the remaining queue through
  a verified fresh isolated session, transferring runtime ownership explicitly.

No new product UI or model behavior is planned. All feedback and acceptance derive
from actual stored/native/OS observations; the model has no runtime job here.
