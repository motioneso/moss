# Vocci: one physical adapter recovery check

Part of #3565; #3565 and #3584 remain open. This follows committed adapter plan
`d3f625b2e` and its merged recovery/vocabulary handoffs. Ben reported the phone
unlocked in the current owning session. This is existing installed-product
verification, with no product source, installation or server deployment change.

## Preconditions and execution

The owning `vocci-copy-rollout` session reidentified the authorized physical phone
through the private explicit ADB endpoint. Fresh reads found it online/unlocked,
production companion 20261027, Bluetooth ON and the exact live foreground service.
Original timeout 120000 and official-app CONNECT/SCAN revocation matched.

Before execution, the prepared runner's SHA-256 matched the independently cleared
`9ccb4f10ff57fce544c13b6aae5e340ee253c6c70bc9877e7f336b6c3fbb2c21`.
Its imported observer source matched reviewed `09add4825f6e151065d2a9c4b10eb7f54fed6703`.
Both prior runner reviews had cleared the fresh-ON finding. Neither an outage
marker nor an output directory existed; the earlier locked preflight issued no
outage. The runner was executed once, without source changes.

Actual native UI traversal matched the transferred setup baseline exactly:
identity, enabled delivery, hold off, cleanup off and three retained queue entries.
Every entry was complete or failed; no pending work was used. A fresh waiting
status, matching foreground service, ON state and unlocked observation immediately
preceded the exclusive outage marker.

The one guarded public-adapter disable/enable check exited 0, with 56 checks:

- Current public-disabled state was **BLE_ON**, retained before interpretation.
  This means the public adapter was disabled; it does not establish radio silence.
- Actual UI changed to **retry pending**, with the exact live foreground service,
  16.877 seconds after the disable request.
- The runner restored Bluetooth ON in `finally`.
- Actual UI returned automatically to **waiting for completed recordings**, with
  the exact live foreground service, 30.210 seconds after ON restoration. No manual
  Start or second outage was issued.
- Complete native before/after snapshots compare equal. Final runner checks
  confirm original ON, timeout, installed version and official-app permissions.

In the existing service, the waiting report follows `retrieve`, including its
ring inventory path (`DeliveryService.java:143–191`); the observed return to that
state is the bounded reconnection evidence. It is not an audio-transfer test.

A separate fresh read-only final check passed eight invariants: physical identity,
timeout, installed 20261027, ON, matching live foreground service, official-app
CONNECT/SCAN revocation, native equality and all four original failure-artifact
digests unchanged. No screenshot, response interception or synthetic device state
was used as physical acceptance.

## Evidence and limits

Private raw states, UI dumps, service/PID observations, the exclusive attempt
marker and runner receipt remain under
`~/.local/state/moss/vocci-recovery/adapter-recovery/`. Supplementary preflight,
independent equality/timing checks, final invariants and review-input digests are
in `copy-rollout/physical-followup/` beneath the same private root. Both failed
historical attempts and the successful new receipt are preserved separately.

The observed one-shot adapter recovery passes its bounded criterion. It does not
prove physical out-of-range, offline server or interrupted-upload recovery: no
pending work or new recording was authorized. Original automatic package
replacement remains failed/unresolved. Prior physical reboot success and manual
Start recoveries retain their separate meanings.

No reinstall, manual Start, recording/replay, hold enrollment, reset/rebind,
source deletion, reboot, firmware or server deployment was performed. The runner
removed its temporary device XML files. No server, browser, devport or disposable
package was started for this check. Existing queues, exclusions, retained originals,
completed imports and identity boundaries remain authoritative.

## Next bounded work

The unlock prerequisite is resolved for this completed check. Ben also selected
the [best-effort vocabulary alternative](../../superpowers/specs/2026-10-24-meeting-vocabulary-decision.md).
That is actionable software work, not another pending design approval. It does not
authorize further physical outages. Continue independent review, required CI and
authorized merge before a verified fresh successor for vocabulary implementation.
Carry the whole recovery queue and keep both tracking issues open; virtual Android
remains deferred.
