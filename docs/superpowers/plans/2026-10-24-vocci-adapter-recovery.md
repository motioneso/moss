# Vocci adapter observer and bounded recovery

Task #3565; #3584 remains open. Authority: the merged adapter-recovery
handoff and explicit exclusive runtime transfer to `vocci-adapter-recovery`.
Base `7535cfb10f95a61c0df7bb8b7b5f65d11fa4ff60`. Apply the approved initial
setup, automatic delivery and Android Hardware specifications.

## Decisions and seams

- `apps/vocci-delivery/upgrade-proof/replacement_broadcasts.py:6` establishes
  the pure Python observer seam; `test.sh:15` runs its offline regression suite.
  Add `device_observations.py` and `test_device_observations.py` beside it and
  include both observer suites in that existing host check.
- `src/ai/moss/vocci/RingConnection.java:45` rejects a disabled adapter;
  `DeliveryService.java:125` records retry pending after a connection exception.
  `DeliveryService.java:136` waits according to the existing retry policy.
  These are existing product behaviors to observe, not proposed replacements.
- Retained API 37 Bluetooth output has an indented current ON header and
  historical BLE_ON events. The old private observer accepts ON/OFF only.
  Its failed receipt says unknown state, but its post-disable raw dump was
  not retained. Do not claim that BLE_ON caused that specific failure.
- Read only the current Bluetooth Status header. Recognize public/LE stable
  and transitional states explicitly; missing, duplicate or unknown states
  fail closed. ON alone means enabled. OFF/BLE_ON mean public adapter disabled;
  BLE_ON does not mean every Bluetooth radio is off.
- Foreground evidence must belong to the exact service component, its own
  ProcessRecord and a matching current PID. Reject stale, unrelated and
  cross-record foreground flags. Keep raw observations private.
- Prefer this small observer correction over product recovery changes: no
  falsifiable product failure has yet been established. A private-only patch
  would leave the observer regression outside normal host checks.

## Ordered execution and kill gates

1. Commit this plan before implementation or device writes. Create offline
   fixtures derived from retained structure, with private values replaced;
   label altered states as synthetic controls. Observe the old state matcher
   reject BLE_ON, then demonstrate regression failures before the fix.
2. Implement the pure observers and controls: indentation, historical state
   contamination, transitional/unknown states, exact service component,
   live/stale PID, missing process, unrelated flags and conflicting records.
   Replay against retained actual ON/service output separately.
3. Independently review the immutable source head on Standards and Spec axes
   before device use. Resolve and re-review actionable findings.
4. Fresh private preflight: use only the explicitly authorized ADB endpoint
   with `adb -s`; verify physical identity, availability, unlock, installed
   20261027, current ON/live service, original timeout 120000, official-app
   CONNECT/SCAN revocation and native identity/choices/queue equality.
   Preserve enabled=true, hold=false and cleanup=false. No reinstall.
5. Only if controls and preflight pass, issue one public-adapter disable.
   Retain every raw state before interpreting it. Bound observation of a
   disabled state and actual service/UI retry; restore the observed original
   adapter state unconditionally in finally. Then observe service/UI return
   to waiting and a fresh ring connection observation. No manual Start may
   satisfy automatic reconnection. No second outage after any failure.
6. Recheck native equality and all preserved system choices. Record results,
   original failed receipt digests and limitations in public evidence, with
   no private identities, filenames, transcript, endpoints or credentials.
   Independently review the final evidence/head, pass required CI, merge
   under standing authorization, then verify a fresh isolated successor.

Owner of the kill gates is this session: stop before outage on unreliable or
unknown observations, changed native state, unavailable/locked phone or failed
controls. Stop the outage immediately on an unexpected state and restore ON.
If recovery fails, preserve that result; product changes require a separately
falsifiable minimal supported fix. No unchanged generic platform diagnosis.

## Verification and determinism

`python3 -m unittest discover -s apps/vocci-delivery/upgrade-proof -p 'test_*.py'`
must exit 0 after the correction. `apps/vocci-delivery/test.sh` must exit 0,
including existing host suites and APK build. Scoped Prettier, file-size and
`git diff --check` must exit 0; required CI must pass. Run commands unpiped and
retain their own exit codes. No DB-touching command is needed.

The private single-outage runner must exit 0 only with explicit disabled,
retry, restored ON, fresh reconnection and preserved-state observations.
Failure is retained as failure. This is installed existing-product verification,
not a new product/UI release; no app-map behavior changes are planned.
All feedback derives from records, current UI and OS observations. No model
participates in the device path or supplies success values.

No pending work or new recording is authorized. Even a passing check proves
neither interrupted upload nor physical out-of-range recovery. Preserve the
original replacement failure, successful prior reboot and incomplete earlier
adapter attempt as separate receipts. Keep the entire remaining queue in
`2026-10-24-vocci-recovery-continuation.md`; virtual Android stays deferred.
