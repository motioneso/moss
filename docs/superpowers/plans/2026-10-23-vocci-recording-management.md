# Vocci recording management — group 3

Approved scope: `docs/superpowers/specs/2026-10-23-android-hardware-settings.md`.
Task: #3584 (open). Stack on `feat/vocci-hardware-settings` / draft #3586;
#3576 and guided setup remain prerequisites. Work stays in
`~/Jarv1s/.claude/worktrees/vocci-recording-management`.

## Existing seams and decisions

- `DeliveryService.java:19` owns one worker; `:151` publishes hardware observations.
  Reuse that worker for explicit refresh/exclusion commands, including while stopped.
  Opening Hardware never starts a connection, delivery, or voice enrollment.
- `RingConnection.java:150` enumerates at most 1024 entries and authenticates saved
  identity (`:67`). Inspection uses this connection and inventory parser.
- `DeliveryStore.java:65` controls retrieval admission; `DeliveryService.java:171`
  controls delivery. Exclusion gates both, including retained ready uploads.
- `SecretStore.java:64` enforces saved origin/owner/ring identity. The new atomic
  recording snapshot/exclusion ledger binds those non-secret identity fields plus
  the journal's `sourceDeviceId`. A mismatch blocks use instead of adopting data.
- `HardwareActivity.java:65` preserves native views and focus across polling;
  `NativeTheme.java:13` supplies the approved light/dark roles. Extend these flat
  rows with 25-item pages and a selected-source inspection screen.
- `ResumableUpload.java:44` resumes immutable chunks. Commands apply between worker
  operations: a command waiting behind a transfer is pending, not saved. Once the
  exclusion commits, no later admission/upload/status operation for that source runs.
  Already sent bytes, accepted imports and completed Meetings cannot be retracted.
  Pending/failed/interrupted files, destinations and consent are preserved.

A separate Activity-owned preferences flag would acknowledge changes before the
worker sees them and create competing persistence. The worker-owned ledger adds a
small durable boundary and makes acknowledgement truthful. No re-include action is
part of this slice; exclusions survive reinventory and restart without deleting evidence.

## Bounded implementation and verification

1. Add an atomic identity-bound inventory/exclusion ledger and read-only UI snapshot.
   Persist inventory time and advertised audio/sidecar bytes. Completion/duration
   come only from retained sidecar evidence, otherwise show unknown. Keep delivery,
   phone copies and ring presence distinct. Keep exclusions when inventory is empty.
2. Wire explicit maintenance commands onto the existing service worker without
   enabling recovery/delivery. Drain exclusions before discovery and before each
   delivery operation; acknowledge only after durable save. Report failed/stale
   commands honestly. Keep optional telemetry failures isolated.
3. Extend Ring storage with refresh, actual sources, pagination, inspection and
   accessible exact-source exclusion confirmation. Reuse native theme, back/focus
   behavior and system font scaling. Update Meetings' Android app-map declarations.
4. Run `apps/vocci-delivery/test.sh` (expected 0), installed `DeviceChecks` (PASS and
   instrumentation code -1), and native UI assertions on the authorized phone.
   Regression cases: persistence/reinventory, all scope fields, unknown metadata,
   missing sidecar, stale selection, admission and queued transfer boundaries,
   completed/failed/interrupted preservation, stopped refresh, hold destination.
   Run `pnpm verify:static` (expected 0) and focused app-map unit coverage (expected 0).
   Commands run unpiped. Any DB checks use `verify-gate` exclusively.

Native acceptance replaces Playwright for these Android-only screens: traverse the
installed Hardware → Vocci ring → Ring storage path using executable UI assertions,
including back, cancellation, dark mode/font scaling and preserved configuration.
Use real inventory; do not fabricate UI data. Ben supplied and authorized exclusion
of one short disposable normal recording during this run. It may be excluded and
must remain on the ring; no deletion was authorized.

## Legacy deletion audit and kill gate

Official 1.1.24/build333 bundle hash:
`50fb21f9f92c0b63ab093c714628ed3487cb7ec91842cba5eb492cd2d948ebf3`.
Existing shell/Hermes disassembly shows #47651 deletes a local DB row, not ring
audio. The follow-up shell/Hermes audit resolves #67760's environment slot 22 to
#67765 `buildDeleteFilePayload`, and #67785 calls that closure before handing its
result to `sendRingUartCommand` with `RING_CMD_DELETE_FILE` (logs mention 0x17).
The builder removes a MAC prefix, UTF-8 encodes the filename and prefixes bytes
`2, filenameLength`. #67790 examines the first response status byte. These are
static shipped-app observations, not physical legacy validation or proof that the
entire audio/sidecar bundle can be removed atomically. The false inference that
every `deleteRingFile` means a BLE delete is specifically rejected. Retained audit
remains private; no delete opcode will be sent by this slice.

Owner: implementing agent. Kill deletion for this PR unless the actual legacy
payload/response chain, complete audio/sidecar bundle and safe disposable-sample
hardware verification are all established. Ship inspection/exclusion independently;
show deletion unavailable and keep #3584 open. Never use reset, erase-all or unbind.

## Determinism and closeout

All UI feedback comes from snapshots/command receipts. This slice has no model jobs,
prompt guidance or inserted chat turns. Preserve existing Main review/Send behavior.
Commit/push explicit paths after shared-checkout review; open a separate stacked
draft PR, record actual evidence/limitations, preserve account and queue, restore
device settings/official-app grants, stop owned processes and leave a clean tree.

## Recorded verification — 2026-10-23

- `pnpm install`: exit 0. `apps/vocci-delivery/test.sh`: exit 0, including
  protocol/crypto, telemetry, reminder, generated two-hour PCM and development APK.
- `pnpm verify:static`: exit 0. Focused Meeting manifest, app-map integrity and
  app-map contract suites: 27 tests / 3 files passed. The inherited web-only
  settings-path assertion now validates native package/activity declarations against
  the Android manifest. The base PR's latest unit failure was that same assertion.
- Installed final APK `DeviceChecks`: `result=PASS`, instrumentation code `-1`.
  The new cases cover all scope fields, stale selection, restart/reinventory,
  discovery admission, chunk interruption, queued restart, retained evidence,
  unknown metadata, inventory bounds and stopped preferences. Existing upload,
  long-audio, retention, recovery and hold checks still pass.
- Negative control: removing the ledger constructor identity guard made the
  installed assertions fail. Restoring it, rebuilding and reinstalling made them
  pass. The protected implementation is restored.
- Real native empty-inventory traversal: 20 assertions passed, including stopped
  refresh, back navigation, cleanup cancellation, dark mode and 1.5 font scale.
- Ben's authorized disposable recording: 16 native assertions passed through
  inspection, exclusion cancellation, confirmation and saved receipt. A subsequent
  real inventory still contained the source; force-stop/reopen retained the
  exclusion. No deletion command was sent and no substitute inventory was injected.
- During the later final-build check, one refresh failed with `ring_unavailable`;
  the next succeeded and reported zero audio sources. The exclusion remained saved.
  This later observation does not establish why the sample was no longer listed.
  Original official-app permissions had been restored between proof runs. The
  original sample-present proof and the later empty inventory are distinct results.
- Final APK native traversal: 10 assertions passed for real stopped refresh, the
  current empty inventory and the saved exclusion surviving process restart.
- Closeout checks passed: original delivery/reminder/cleanup choices, screen timeout,
  stay-awake, font scale, appearance and official-app Nearby devices grants restored.
  Encrypted configuration hash is unchanged; both completed queue entries remain.
- Final review restored live-owner validation before existing non-recording service
  commands while leaving stopped recording maintenance independent of network
  availability. Product deletion copy uses plain language; protocol details remain
  in developer documentation.

Private runtime evidence is retained outside the public checkout. No screenshots,
private source identifiers, credentials or personal ring identifiers are committed.
The final closeout result and PR proof record the restored device choices/settings,
configuration hash comparison and retained queue count. Journal activity timestamps
may change; byte-for-byte journal preservation is not claimed.
