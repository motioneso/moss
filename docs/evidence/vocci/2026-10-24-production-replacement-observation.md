# Vocci production replacement observation — 2026-10-24

Task #3565; #3584 remains open. Plan
`docs/superpowers/plans/2026-10-24-vocci-production-dispatch-observation.md`
was committed as `6af2606bd175407dd4f5f95c518e23f24e10c206` before proof changes.
Baseline: merged observer correction #3626,
`02e579a9b18a3a56f121c7d3cc5e49a018f49db9`.

## Actual result

**Automatic production package-replacement recovery failed.** One signed in-place
update from release `20261025` to `20261026` succeeded. The corrected parser found
one newly emitted exact replacement record whose exact
`ai.moss.vocci.DeliveryRecovery` receiver was **SKIPPED**, with reason
`mBroadcastConsumerSkip`. No delivery service resumed during the bounded
35-second observation window (15 observations). No post-update activity, UI,
manual Start, synthetic broadcast, force-stop or instrumentation preceded that
capture. The original observer exited **1**, `exact_new_receiver_delivered`.

The receipt and raw broadcast/service dumps were saved before assertions and
remain unchanged. A read-only replay minimized the retained dump to the exact
record/Intent/receiver state, preserving the same SKIPPED verdict and exit 1.
That replay is not another device execution. Earlier #3625 dispatch and
product-fix kill-gate claims remain withdrawn.

## Release and retained state

The retained candidate was freshly rechecked before installation:

- APK SHA-256:
  `48827ff532cedbd77438f9306399fdb74cc2337357dc3145776ec1f0173e2a4c`.
- Its verified signing certificate matched the actual installed companion;
  all 34 packaged production Java digests matched reviewed merged source.
- Actual release manifest retained the recovery receiver/actions and service,
  disabled debugging/cleartext/backup, and omitted instrumentation.
- The authorized physical phone identity was checked privately; it reports
  Android API 37. Version increased and the package UID was preserved.
- After Ben unlocked the phone, actual pre-update native diagnostics opened the
  saved setup/account, enabled delivery, separately disabled hold/cleanup and
  three visible queue entries. Post-update native diagnostics matched the saved
  identity hash, choices and all three visible entries exactly.

This release is not debuggable. No direct private-file/Keystore hash-equality
claim follows from the visible native checks. No uninstall, clear-data, binding
change, recording deletion, firmware operation, completed-source replay, summary
retry, server deployment or reboot ran.

Only after saving the failed dispatch receipt and native comparison, the real
**Start delivery** button restored daily delivery. A foreground service and its
matching live process were observed. This is separate manual recovery evidence;
it does not change the failed automatic-recovery verdict. The original two-minute
timeout and intentional official-app Nearby devices permission handoff were
retained. No new recording was requested or created for this observation.

## Diagnosis and review boundary

Before further probes, hypotheses were ranked: ordinary stopped/suspended/disabled
package state; missing or disabled receiver/filter; then API 37/vendor broadcast
consumer policy. The retained before/after package dumps show user 0 installed,
not hidden/suspended/stopped, default enabled state, granted Nearby devices and
both registered recovery actions. These weaken the first two explanations.
`mBroadcastConsumerSkip` alone does **not** identify a cause or justify a product
change. Older AOSP source cannot establish this phone's implementation.

An initial independent Standards review found a private observer weakness:
foreground ServiceRecord text without a running process could satisfy service
acceptance. The corrected observer requires a nonempty parsed PID matching actual
`pidof`, including in its observation loop. Offline stale/live/mismatched-process
controls passed; independent re-review reported zero remaining findings. The
original production run had **no service**, so this correction neither changes
its failure nor establishes a new successful device run. The original observer
and receipt digests are retained privately. Initial Spec review reported zero
findings; final immutable-head reviews and CI belong on the PR.

## Checks and remaining work

- `apps/vocci-delivery/test.sh`: exit 0, existing host suites, seven parser
  regressions and development APK build.
- Focused parser command: seven tests passed, exit 0.
- Production observer: exit 1, expected exact delivery criterion failed.
- Minimized retained-record replay: exit 1, same exact SKIPPED criterion.
- Native before/after UI checks and post-failure manual recovery: exit 0.
- Scoped formatting and diff checks, independent final Standards/Spec review and
  required green CI are merge gates recorded on the PR.

No automatic replacement, interrupted-chunk/byte-offset, reboot/unlock,
offline/out-of-range, ASR, production hold or endurance acceptance follows.
No product recovery Java, manifest or app-map behavior changed. Private operational
scripts, original failed receipts and bounded diagnosis notes remain outside git.
Continue through
`docs/superpowers/handoffs/2026-10-24-vocci-production-skip-continuation.md`.
