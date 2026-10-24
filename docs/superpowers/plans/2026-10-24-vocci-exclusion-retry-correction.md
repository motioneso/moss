# Vocci excluded-source retry correction

Approved scope: #3584 and
`docs/superpowers/specs/2026-10-23-android-hardware-settings.md`, correcting the
recording-management exclusion contract. Source finding:
`~/.local/state/moss/vocci-meeting-preferences/final-code-review/native-spec.md`.

## Seams and decision

- `DeliveryService.consumeCommands` owns the queued `retry-transcription` command
  (`apps/vocci-delivery/src/ai/moss/vocci/DeliveryService.java:250-277`).
- `DeliveryStore.excluded(String)` reads the identity-bound durable ledger
  (`apps/vocci-delivery/src/ai/moss/vocci/DeliveryStore.java:17-20`), which
  `RingRecordings` persists by source ID (`RingRecordings.java:47-63`).
- `DeliveryActivity.render` owns the existing retry control
  (`DeliveryActivity.java:175-225`) and reads snapshots only; it must not create
  `DeliveryStore` because that writes state.
- `RecordingChecks.run` exercises generated local Android journal/ledger state in
  the disposable instrumentation package (`RecordingChecks.java:10-132`).

Use one package-private retry command operation with a narrow retry-port argument.
`consumeCommands` calls it with `MossClient.retryVoice`; instrumentation supplies a
counting local port. This tests the actual service command decision without network
or production state. The shared eligibility predicate receives the entry and the
current durable-exclusion result. The activity obtains that result from the
identity-validated read-only ledger snapshot using its already loaded configuration
and recorded source-device ID.

The rejected alternative is trusting the hidden button alone. A queued intent can
run after an exclusion commits, so the service remains authoritative.

## Bounded work and checks

1. In `DeliveryService`, deny retry when the source is excluded before calling the
   retry port or mutating accepted status. Keep the existing failed/retryable/voice
   status conditions. Expose the same pure eligibility condition to the activity.
2. In `DeliveryActivity`, read the matching ledger snapshot and show Retry
   transcription only when the common condition permits it. A missing or
   identity-mismatched snapshot is not an exclusion and leaves existing retry
   behavior available; the service still rechecks immediately before the request.
3. In `RecordingChecks`, build a failed hold entry through the production store and
   ledger APIs. Assert an exclusion saved after command queueing produces no retry
   call and no entry mutation; assert a non-excluded equivalent performs one retry
   and saves the returned status. Assert the shared UI condition hides/shows the
   control for those same states. Add the case name to `DeviceChecks` results.
4. Update `packages/shared/src/app-map-core.ts` to say an excluded source cannot
   retry transcription. Run `cd apps/vocci-delivery && ./test.sh` (expected exit
   0), build the disposable development APK (expected exit 0), then run its
   `DeviceChecks` instrumentation against an isolated development package (expected
   `result=PASS`, instrumentation code `-1`). Run the relevant app-map static test
   (expected exit 0). No database command is part of this change.

All text is deterministic from persisted local state; no model job or chat turn is
added. The kill gate is a retry that reaches the retry-port after a persisted
exclusion; if observed, stop this correction and retain the source/ledger evidence.
The implementing agent owns that decision.

## Rulings ledger

- 2026-10-24: a retry command is a later status operation for the excluded source,
  so the no-later-operation exclusion contract applies even though ordinary upload
  paths already call `DeliveryStore.checkDelivery`.
