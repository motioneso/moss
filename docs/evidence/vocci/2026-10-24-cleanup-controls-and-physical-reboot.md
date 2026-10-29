# Vocci disposable cleanup controls and physical reboot

Task #3565; #3584 remains open. Baseline #3631 merged as
`b225e2189bf3acca671089a99f8e49c9f5405f2f`. Plans `d3a8cc043` and
`704bc6376` preceded their respective disposable and arranged physical checks.
No product source or manifest changed.

## Result

One actual, user-arranged reboot recovered automatic delivery on the installed
production companion `20261026`. After unlock, the exact `DeliveryRecovery`
BOOT_COMPLETED target transitioned from PENDING to DELIVERED and its foreground
service had a matching live process. This was captured before any companion
activity, manual Start or instrumentation after reboot. Native setup, choices and
three visible queue entries compared equal before and after.

The original automatic package-replacement SKIPPED/no-service failure remains
failed. Minimal disposable replacements delivered successfully, including with a
preexisting foreground service; they did not reproduce production's late cleanup.
No recovery mitigation was implemented or tested. The bounded diagnosis stops
here; the next independent product correction is the setup/companion appearance
Ben requested, matching the selected Moss settings mockups.

## Disposable comparisons

Private source, generated APK hashes, exact broadcast dumps, entry markers,
service dumps, live PIDs, receipts and runner logs remain under
`~/.local/state/moss/vocci-recovery/cleanup-repro/`. The newly owned package was
`ai.moss.vocci.cleanuprepro`; initialization used a generated local activity,
without instrumentation, production credentials, ring access or production data.
Its minimal receiver/service differ from production, so successful controls do not
prove production recovery. Every owned install was removed and absence confirmed.

| Receipt directory     | Controlled case                           | Exact target            | Matching live FGS | Exit        |
| --------------------- | ----------------------------------------- | ----------------------- | ----------------- | ----------- |
| `run-ordinary-1`      | Minimal ordinary replacement              | DELIVERED, entry marker | Yes               | 0           |
| `run-missing-action`  | Replacement omits receiver action         | Absent, no marker       | No                | 1, expected |
| `run-fgs-control`     | v4 to v5, no baseline service             | DELIVERED, entry marker | Yes               | 0           |
| `run-baseline-fgs`    | Same v4 to v5 inputs, baseline FGS        | DELIVERED, entry marker | Yes, new process  | 0           |
| `run-service-failure` | Deliberately crashing replacement service | DELIVERED, entry marker | No                | 1, expected |

Commands used `python3 <private-root>/run_probe.py --case ordinary --out
<private-root>/run-ordinary-1` and `--case missing-action --out
<private-root>/run-missing-action`; `run_fgs_probe.py --case ordinary --out
<private-root>/run-fgs-control` and `--case baseline-fgs --out
<private-root>/run-baseline-fgs`; and `run_service_failure.py --case
service-failure --out <private-root>/run-service-failure`. All are diagnostic fixture runs, not installed
production-source acceptance. Nine observer controls (`run_fgs_probe.py --controls`)
passed, including rejection of unrelated/stale service evidence. The deliberately
broken service distinguishes receiver dispatch from service success.

Two `pkg removed` stops also occurred in passing comparisons, both before target
enqueue: ordinary −192/−165 ms, FGS control −99/−56 ms and baseline FGS −90/−32 ms.
Production's retained later stop was +18 ms after enqueue, followed by SKIPPED at
+31 ms. Presence/count of cleanup alone does not explain the failure; ordering is
the unresolved variable.

## Shipped producer inspection and kill gate

Inspection used the same shipped `services.jar` SHA-256
`2be617c9b104ca9b063ab99774567e36b4df2f1d587a5f1785f643c1b51ccf57`.
`PackageManagerService.handlePackagePostInstall` invokes a removal sender and
posts subsequent replacement broadcasts. `BroadcastHelper.sendPackageRemovedBroadcasts`
can post installer-targeted/public PACKAGE_REMOVED and an internal action.
`sendPackageBroadcastAndNotify` posts a handler Runnable; it sends the broadcast
and notifies the monitor only for a null target package. Focused Java/smali and
`removal-references.txt` are retained privately. Java reconstruction of the PMS
method failed; raw container smali supplied that part. REA was closed afterward.

These are possible producer paths, not a captured dynamic late-removal caller or
an explanation of its delay. No live skip reproduction or useful tested mitigation
emerged. The precise missing probe is dynamic attribution/order of the late
same-package removal operation around receiver enqueue on the shipped platform.
A supported fix still needs a falsifiable behavioral regression, negative controls,
review and installed proof. Do not blindly reinstall production or rewrite its
receiver/service from these controls. Do not pass unchanged platform diagnosis to
the next session as its primary task.

## Physical reboot and bounded adapter attempt

Private receipts are in `cleanup-repro/physical-recovery/`:

- `native_snapshot.py before` and `after`: exit 0; identity hash, enabled choice,
  hold off, seven-day cleanup off and three visible entries equal.
- `reboot_phone.py`: exit 0, exactly one reboot guarded by `reboot-issued.json`.
- `observe_boot.py`: exit 0; changed kernel boot identity, completed boot and
  unlocked user. Six observations of the exact new target progressed PENDING to
  DELIVERED with a matching live foreground-service PID. `boot-receipt.json`
  preserves the sequence. `observe_boot_late.py` independently observed the same
  successful state afterward; it was not a retry of a failed reboot.
- Only after automatic proof succeeded was companion UI opened for the native
  comparison. No manual Start occurred in this reboot check.
- First adapter preflight exited 1 before any setting change: its state regex
  missed leading indentation. The original script is preserved separately.
- Corrected `adapter_probe.py` made one reversible disable/enable attempt. It
  exited 1 on an unrecognized post-disable adapter state before observing a
  retry/reconnection transition. Its `finally` restored ON; the receipt records
  restoration. No retry loop or second outage followed. This is incomplete
  adapter acceptance, not physical out-of-range or offline-upload proof.
- `native_snapshot.py final`: exit 0. Final read-only assertions in
  `final-invariants.json` passed: native facts equal the original, Bluetooth ON,
  matching live foreground service, version `20261026`, timeout `120000`, and
  official `com.gygeslabs.odinclient` CONNECT/SCAN grants false. UI reports waiting
  for completed recordings. A first read-only preflight queried a wrong official
  package and failed before reboot; its corrected check and failed receipt remain.

No new recording, pending upload, interruption/resume, production replacement,
hold opt-in, source deletion/replay, binding reset or firmware operation occurred.
Reboot success covers enabled daily delivery with no pending transfer. Physical
out-of-range/offline, interrupted upload and hold acceptance remain separate.

## Other checks and continuation

The retained original-failure replay still exits 1, exact SKIPPED/no service.
`skip-diagnosis/verify_findings.py` exits 0: 50 retained-evidence assertions,
including 41 unchanged original digests. Seven existing exact-record parser tests
pass. These checks do not establish a new recovery fix.

Independent Standards/Spec review, scoped formatting/diff checks and required CI
are recorded on this PR before merge. This docs-only slice introduces no app-map
behavior. Keep #3565/#3584 open. Defer virtual Android setup per Ben; continue with
`docs/superpowers/handoffs/2026-10-24-vocci-setup-style-continuation.md` after the
reviewed merge and verified exclusive runtime transfer.
