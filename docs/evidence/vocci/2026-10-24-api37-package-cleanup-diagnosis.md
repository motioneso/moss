# Vocci API 37 package-cleanup diagnosis — 2026-10-24

Task #3565; #3584 remains open. Plan `3d1c4c01f159e2a266dc56f0348e3f9c5ad3fe76`
was committed before probes. Baseline: #3630,
`5262ab2d5bf7ee12b8905e013f15f8f8b52c21e0`.

## Result

The captured production manifest-receiver skip is narrowed to **package-receiver
cleanup in the shipped API 37 framework**. Its exact queue reason is not a
receiver exception or a specific battery-policy diagnosis. Read-only retained
logs also show a same-package `pkg removed` force-stop after the replacement
broadcast was enqueued and before its target was marked SKIPPED. This supports
overlapping package cleanup as the mechanism to investigate next.

The exact dynamic caller, reason for the later removal stop and a safe product
mitigation remain unproved. No product recovery source or manifest changed; no
new update or recovery test ran. The original automatic-recovery failure remains
failed, and the predecessor's later manual Start remains separate.

## Shipped implementation

The authorized phone was reidentified privately before read-only access. It
reports Android 17/API 37, installed companion release `20261026`. Current package
state is installed, not stopped, hidden, suspended or quarantined, with default
enabled state and Nearby devices granted. The registered replacement action and
foreground service with matching live PID remain present. These current readings
do not establish package state at an earlier instant.

Read-only retrieval of `/system/framework/services.jar` produced SHA-256:
`2be617c9b104ca9b063ab99774567e36b4df2f1d587a5f1785f643c1b51ccf57`.
REA `open_binary` independently reported that digest and ZIP identity. REA's
Android provider rejected the JAR because it requires a standalone APK; existing
JADX 1.5.6 was used for focused class extraction instead. No tool installation,
APK repackaging, framework modification or execution occurred.

Recovered paths in that exact artifact:

1. `BroadcastQueueImpl` initializes `mBroadcastConsumerSkip` as synthetic consumer
   21, class ID 1. Its `accept` sets delivery state 2 and exact reason
   `mBroadcastConsumerSkip`.
2. Within that queue class, its two direct field readers are
   `cleanupDisabledPackageReceiversLocked` and `onApplicationCleanupLocked`.
3. Process cleanup passes synthetic predicate 13, class ID 0, which selects
   `BroadcastFilter` runtime registrations. The retained target is explicitly a
   **manifest** receiver; this predicate does not select it.
4. Package-receiver cleanup selects the relevant package/UID/components and
   applies the skip consumer. It does not require a currently disabled package
   before being called; the method name alone is not a package-state diagnosis.
5. `ActivityManagerService.forceStopPackageInternalLocked` calls that cleanup.
   `BroadcastController`'s `PACKAGE_REMOVED` handling calls the Samsung
   `ActivityManagerServiceExt.forceStopPackageLocked` wrapper unless DONT_KILL_APP
   is set. REPLACING affects a different argument; it does not bypass the call.
   The wrapper supplies reason `pkg removed` and enters the internal force-stop.

Queue/consumer/predicate instructions and the internal force-stop cleanup call
were cross-checked in extracted smali, rather than relying solely on reconstructed
Java. Decompiled Java has errors elsewhere, including dump/process-start/user
methods and inferred types in the large ActivityManagerService; it is not a
complete or compilable platform source reconstruction. The extension/controller
path is static evidence, not a captured runtime call stack or a complete global
reference audit. Reflection and other unresolved paths remain outside this check.

## Retained event ordering

Read-only system/event ring buffers still contained the original update. Public
times below are relative to the exact target's enqueue clock, correlated with the
retained target state's epoch timestamp; no unrelated DELIVERED record is used.

| Relative time | Observed event                                         |
| ------------- | ------------------------------------------------------ |
| −408 ms       | Package-update force-stop starts                       |
| −405 ms       | Old companion process killed for package update        |
| −339 ms       | PackageManager logs installation completion            |
| −332 ms       | An earlier `pkg removed` force-stop                    |
| 0 ms          | Exact replacement broadcast enqueued                   |
| +18 ms        | Another same-package `pkg removed` force-stop          |
| +31 ms        | Exact manifest target SKIPPED/`mBroadcastConsumerSkip` |
| +69 ms        | Process-start result rejected as invalid/killed by AMS |

The later force-stop overlaps the pending replacement record. Combined with the
shipped skip-consumer path and manifest/runtime predicate distinction, this is
stronger evidence than the generic token alone. It does not identify the producer
of the later removal operation or prove that any proposed workaround succeeds.
An intermediate log mentions an activity intent; the existing failed observer
still captured no resumed service before its UI phase. This investigation makes
no new claim about the origin or handling of that incidental intent.

## Checks and next boundary

- Inspected original minimized replay: exit 1, exact SKIPPED, delivery false,
  service absent. Its result is unchanged.
- Offline findings verifier: exit 0; 50 assertions including 41 original-file
  digest comparisons, relevant smali relationships and the +18/+31 ms ordering.
  These are retained-evidence checks, not 50 independent recovery tests.
- Existing seven exact-record parser regressions: exit 0.
- All 41 original scripts/receipts/raw-dump digests still match. New platform
  artifacts, logs, extraction errors and the verifier remain private outside git.

Next bounded work should isolate the late package-removal/cleanup path and assess
supported recovery options using a newly owned disposable app identity. First
inspect the shipped producer/call paths and retain exact receiver/service evidence;
do not repeat a production install merely to collect the same skip. A product
mitigation needs a falsifiable regression, negative controls, app-map changes and
installed real-path proof. The original production failure is not itself a passing
regression seam for a hypothetical fix.

No phone setting, permission, app choice, setup, queue, recording, production server
or firmware changed. No new unlock/sample request, reboot, synthetic broadcast,
force-stop, app launch or replacement was performed by this session. Independent
Standards/Spec review and required CI are merge gates recorded on the PR. No
automatic update, reboot/offline, interrupted-upload or hold acceptance follows.
