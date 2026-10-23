# Moss Android Hardware settings

Status: direction approved by Ben on 2026-10-23 (simple settings concept A and the
official Vocci feature audit). Implementation and live verification are separate.

## Experience

Keep the existing Moss mobile experience. Hardware is the extensible settings
category; Vocci ring is one hardware type. Use the selected flat list, paper/forest
roles, Archivo headings, hairlines, accessible controls and system light/dark mode.
Do not introduce a second chat, another dashboard or a delivery tracking homepage.

The ring detail list contains:

- A compact status: last connection, battery, recording state. Unknown/stale reads
  must never look like a currently connected or idle ring.
- **Automatic delivery**: the existing explicit Start/Stop choice. Once started,
  completed normal recordings are retrieved and uploaded automatically, with retries
  and restart recovery. They become Meetings; hold input remains separately opted in
  and requires transcript review and Send in Main.
- **Hold-to-talk**: preserve existing enrollment and durable destination rules.
- **Ring storage**: capacity and saved recording inventory, separately from phone
  audio. A missing response means unavailable, never zero free space.
- **Phone audio**: existing completed-local cleanup and optional seven-day cleanup.
- **Connection & permissions**: Nearby devices, notifications, battery restrictions,
  competing official app access, reconnection and account recovery.
- **How to use your ring**: double-click start/finish, single-click bookmark during
  recording, hold-to-talk, offline behavior and feedback meanings.
- **About this ring**: saved identity and observed hardware/firmware version.

The existing delivery detail view remains available for troubleshooting. This work
does not imply that an embedded browser shell or factory-fresh onboarding has shipped.

## Feature coverage and build order

1. Surface existing automatic delivery honestly; implement the selected native
   settings list, read-only telemetry, storage/device details and usage guidance.
   Preserve configured accounts, journals, enrollment and source recordings.
2. Add opt-in long-recording reminders driven by observed recording state. A reminder
   never stops recording. No auto-stop setting is claimed without hardware evidence.
3. Build individual ring recording management: list, inspect, explicitly exclude from
   delivery, and delete a selected recording only with a validated legacy command,
   exact-source confirmation and post-command inventory verification. Never substitute
   erase-all, factory reset or ownership unbinding for individual deletion.
4. Check shared Meeting preferences for transcript language, custom vocabulary and
   automatic transcription/summary behavior; add missing supported capabilities there.
   Audio enhancement belongs with Meeting audio tools, with original preservation
   defined before it runs. AI stays provider agnostic.
5. Firmware updating requires a separate compatibility/recovery proof on the supported
   ring. Expose installed version without inventing an available update or treating
   V3/debug commands in the official APK as supported by a legacy ring.

Automatic delivery, resumable upload, retries, deduplication, reboot recovery and
automatic Meeting processing already exist in the current source. These must be
verified and surfaced, not rebuilt as parallel mechanisms. Previously saved notes
claiming developer-only upload are historical, not the current source contract.

## Telemetry boundary

Read on the existing serialized service GATT connection. Do not open another competing
ring connection from the activity. Read-only info/status/storage requests are separate
from recording controls. Telemetry failure must not prevent completed-file delivery.
Publish bounded snapshots with observation timestamps; UI reads never construct the
write-owning delivery store. Do not log private ring identifiers or filenames.

No destructive commands are part of the status/settings slice. Official Vocci's
Reset ring handler calls clearAllFiles and sends RING_CMD_CLEAR_ALL_FILES; it is not
a reconnect or restart action. Future destructive UI must use explicit labels.

## Verification

- Host protocol checks cover real packet layouts, short/malformed input and unknown
  values; valid status/storage values are preserved without fabricated defaults.
- Existing Android host tests and APK build pass. Existing voice and queue checks stay
  intact; the settings UI cannot enroll hold input or start delivery on opening.
- Real-device UI traversal checks the list, toggles, child screens, back behavior,
  system dark mode/font scale and retained settings. Read-only ring observation checks
  actual battery/storage/status with no recording, deletion or firmware command.
- Update the app map in the same product PR. Record real-device evidence before merge;
  without it report code-complete, unverified.

## Dependencies

This branch starts from the current companion design checkout, which includes pending
guided setup and provider-summary changes. Keep those prerequisite PRs explicit; do
not merge this work ahead of them or claim they are already released.
