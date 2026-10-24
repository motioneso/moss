# Vocci enabled package replacement: bounded diagnosis

Task: #3565. Approved scope: initial-ring setup, automatic Android delivery and
Android Hardware settings specifications. Ben authorized this bounded diagnostic
and transferred exclusive runtime ownership after #3622 merged. Starting main:
`fa6e5ed51b8eb4bec5ed011fde83e761f3c69547`; worktree integration:
`b01a1f732d4366a4dfc65c3fbe3e6079c61a2b8a`.

## Question and current evidence

Does an actual signed package replacement dispatch the enabled recovery receiver
and start the real connected-device foreground service on the authorized phone?
The retained production trace resolved the enabled receiver but marked it skipped
with `mBroadcastConsumerSkip`; the service was absent. The pending source survived
and later completed after manual Start. That generic token does not identify a
root cause. The phone currently reports Android API 37; older AOSP source is
reference material, not a description of this device's implementation.

## Existing seams

- `apps/vocci-delivery/AndroidManifest.xml:21`: non-exported recovery receiver for
  boot completion and package replacement; connected-device service at line 20.
- `apps/vocci-delivery/src/ai/moss/vocci/DeliveryRecovery.java:9`: action, saved
  enabled choice, Nearby devices and encrypted configuration gates before recovery.
- `apps/vocci-delivery/src/ai/moss/vocci/DeliveryPreferences.java:12`: only Start
  and Stop change the enabled choice; recovery preserves it.
- `apps/vocci-delivery/src/ai/moss/vocci/DeliveryService.java:70`: sticky enabled
  service. Its work loop at line 99 checks the configured owner before delivery or
  ring access. A closed HTTPS loopback origin fails before those consumers.
- `apps/vocci-delivery/src/ai/moss/vocci/RecoveryChecks.java:10`: direct Java
  receiver calls with a captured service port; these bypass OS broadcast dispatch.
- `apps/vocci-delivery/upgrade-proof/build.py:27`: unchanged Java sources built
  under a guarded disposable identity, same key and increasing version codes.
- `apps/vocci-delivery/upgrade-proof/UpgradeFixture.java:30`: generated encrypted
  configuration, pending/frozen entries, retained evidence and source identity.
- `apps/vocci-delivery/upgrade-proof/run.py:156`: the existing replacement test
  force-stops a disabled install. Its claims explicitly exclude enabled recovery.

## One diagnostic deliverable

1. Extend the existing fixture with an explicit enabled initialization parameter,
   keeping its default disabled behavior. Add a separate bounded replacement
   runner using the existing builder and guarded disposable package only.
2. Refuse an existing proof installation. Validate both APK identities, input
   hashes and increasing versions before device mutations. Use an explicitly
   supplied authorized serial on every ADB command and private receipt directory.
3. Use only generated data and a claimed, observed closed loopback port, with no
   listener or ADB reverse. Grant Nearby devices only to the disposable package
   when the selected case requires it. No real account/ring or production file
   injection, production APK replacement, Bluetooth/official-app setting changes
   or phone timeout changes.
4. Initialize the disposable baseline, finish instrumentation, then replace it
   without force-stop or post-install instrumentation. Observe real OS dispatch,
   service presence, saved choice and stored outcome within a bounded deadline.
   Compare encrypted configuration and retained evidence digests plus exact queue,
   voice and source identity. Observe the actual network-failure service outcome
   for enabled delivery; this does not prove physical uploads.
5. Execute enabled, disabled and missing-permission cases. Disabled must remain
   stopped; missing permission must retain the choice, avoid a service start and
   save the actual recovery advice. Always remove only the owned disposable app
   and confirm absence. Preserve failed receipts as failed.
6. Remove only the replacement action from a private candidate manifest and run
   the same enabled command. It must fail the dispatch/start assertion. This
   demonstrates that the observer can detect the missing recovery path.

## Feedback loop, decisions and kill gate

The agent-runnable loop is `python3 apps/vocci-delivery/upgrade-proof/recovery.py`
with the documented private APK, serial, port and output arguments. Expected
exit: 0 for supported cases; 1 for the missing-action negative control or any
unexpected dispatch/start/persistence/cleanup failure. The historical trace check
already fails, but is retrospective evidence rather than a fresh reproduction.

If unchanged production recovery passes, stop the product-fix line: commit the
diagnostic tooling and exact observed scope, leave the historical failure's cause
unresolved, and retain #3565's other acceptance gaps. If it fails, first minimize
the installed failure, then present ranked falsifiable hypotheses before changing
one variable. The session owner makes this evidence-based kill-gate decision.
No parallel recovery mechanism or receiver export change is preselected.

All feedback is deterministic from Android and saved records; the model has no
runtime job. This slice adds no product screen or behavior. A later product fix
requires a separate committed plan update, truthful app-map/guide changes and
real-path acceptance before merge.

## Verification and closeout

- Both disposable APK builds: exit 0; compare unchanged production source hashes.
- Three installed replacement cases: exit 0, with the negative control exit 1.
- `apps/vocci-delivery/test.sh`: exit 0 for host checks and development APK build.
- Python syntax compilation without retained workspace cache; scoped formatting
  and repository-required CI checks, all exit 0.
- Independent `code-review` Standards and Spec agents against immutable base/head;
  resolve findings and obtain independent re-review. Record separate reports.
- Public evidence contains only bounded assertions and hashes; private receipts
  stay outside git. No physical restart, interrupted-chunk, ASR or production
  update claim follows from generated-data replacement proof.
- Push explicit paths, open a PR against #3565, await green required CI and merge.
  Then pass the remaining recovery queue to a verified fresh isolated session
  under the committed continuation mandate. Preserve production release 20261025;
  the exclusion correction is merged but not installed there.

## Recorded decision

The unchanged receiver passed the installed enabled replacement diagnostic, along
with disabled and missing-permission controls. Removing the replacement action
from a private candidate made the same observer fail its dispatch assertion.
The product-fix kill gate therefore fired: this slice ships diagnostic tooling
and bounded evidence, with no production recovery implementation change. See
`docs/evidence/vocci/2026-10-24-enabled-replacement-proof.md` for inputs and limits.
