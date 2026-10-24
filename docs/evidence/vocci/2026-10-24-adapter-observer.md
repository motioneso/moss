# Vocci adapter observer and recovery preflight

Task #3565; #3584 remains open. Plan `d3f625b2e` preceded implementation and
device access. Observer source head
`09add4825f6e151065d2a9c4b10eb7f54fed6703`; predecessor #3635 merged as
`7535cfb10f95a61c0df7bb8b7b5f65d11fa4ff60` with clear independent final
reviews and required CI. Its installed production version is already 20261027.

## Observer correction

The former private observer accepted only ON/OFF and could combine a process
from one service record with a foreground flag from another. New pure Python
observers beside the existing replacement parser read only the current Bluetooth
Status header and the exact user-0 service record. They retain recognized
transitional/LE states, reject unknown or ambiguous input and require that
record's foreground flag and process PID to match the live PID observation.
The existing Android host check now runs both observer suites.

OFF and BLE_ON indicate that the public adapter is disabled; BLE_ON does not
prove that all Bluetooth radios are off. Transitional values are observations,
never successful ON/OFF conclusions. Historical state-machine entries cannot
supply a missing current state.

The original failed adapter attempt is preserved: `unknown_adapter_state`,
Bluetooth restored, no observed retry/reconnection. Its post-disable raw state
was not saved, so that state's exact value and cause remain unknown. Retained
API 37 output contains a current indented ON header and historical BLE_ON events;
the synthetic BLE_ON-header control demonstrates a limitation of the old parser,
not a reconstruction of the lost post-disable state.

## Execution

- Old observer logic at the new test seam: exit 1, nine tests with twelve failed
  assertions/subtests, including supported states and cross-record service
  contamination. The failed log is retained unchanged.
- Corrected offline suite: exit 0, sixteen tests including seven unchanged
  replacement-broadcast tests. Cases cover stale/missing PIDs, wrong service or
  package, missing/conflicting states, historical contamination and transitions.
- Retained actual API 37 output replay: four assertions passed. Current ON and
  retained service structure parse; a different PID is rejected; the old failed
  adapter receipt still reports its original failure. Historical PID replay is
  an offline structural check, not evidence that that PID is currently live.
- `apps/vocci-delivery/test.sh`: exit 0, existing protocol/auth/telemetry/reminder/
  PCM checks, sixteen observer tests and development APK build.
- Scoped Prettier, file-size and `git diff --check`: exit 0.
- Independent initial source review at the full observer SHA above: Standards
  zero documented violations/zero actionable smells; Spec zero findings.
  Final evidence review and required CI are recorded on the PR before merge.

Private raw inputs, original digests, failed/passing logs and preflight are under
`~/.local/state/moss/vocci-recovery/adapter-recovery/`. No screenshot was used.
Generated identities in offline fixtures and altered states are synthetic
controls. No product Java/manifest, app behavior or app-map declaration changed.

## Installed preflight and physical limit

Fresh explicit-endpoint reads reidentified only the authorized physical phone.
Nine of ten checks passed: online, physical identity, API 37, version 20261027,
Bluetooth ON, exact live foreground service with matching PID, timeout 120000
and official-app CONNECT/SCAN revocation. The phone was locked. Preflight exited
1 and stopped before native UI traversal or any adapter setting change.

The lock-screen prerequisite is recorded on #3565 and in `AWAITING-BEN`; a
`needs-ben` notification requests an unlock without a new recording. A private
single-outage runner is prepared separately and must pass independent review
and a fresh unlocked/native-state preflight before use. No outage is proved by
this record. No production install, manual Start, recording, replay, hold opt-in,
source deletion, reset/rebind, reboot, firmware or server deployment occurred.

The predecessor's manual Start recovery, successful earlier physical reboot,
original failed automatic package replacement and incomplete adapter attempt
remain distinct. Physical out-of-range, interrupted upload and production hold
acceptance remain open. This internal tooling correction can be evaluated
independently; it does not close any physical recovery criterion.
