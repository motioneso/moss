# Android completed-recording delivery (developer slice)

This repo-owned Android client retrieves finished legacy Vocci recordings and
uploads them to Moss's existing Meetings receiver. It is a developer-installed
foreground service, not consumer ring setup. No ownership, pairing, recording
control, ring deletion or destructive sync acknowledgement commands exist. Normal
recordings become Meetings evidence; newly opted-in hold recordings go to Main chat.

From `~/Jarv1s`, run `apps/vocci-delivery/test.sh` (exit 0 expected). Requires JDK
21, Android SDK platform/build-tools 35.0.0; override `JAVA_HOME` and
`ANDROID_SDK_ROOT` if needed. The build script uses SDK tools directly without a
Gradle/network dependency. Generated development signing material and APKs stay
in ignored `build/`. The APK is debuggable and development-only. Do not distribute
it as a production client. Target API 35, minimum API 33; tested devices/results
belong on the PR.

## Provision and start

Use the authorized Android device explicitly with `adb -s <serial>` for every
command; do not operate on another attached device. Install
`apps/vocci-delivery/build/moss-vocci-dev.apk` with `install -r`. Instrumentation:

```bash
adb -s <serial> shell am instrument -w ai.moss.vocci/.DeviceChecks
```

Require `INSTRUMENTATION_RESULT: result=PASS` and code `-1`; ADB can exit zero even
when instrumentation reports failure. Assertions cover encrypted retention,
tamper rejection, actual platform decoding, completed-sidecar admission, frozen
bundle restart, stable UUID, bounded retries, owner-switch rejection, immutable
voice snapshot recovery, uncertain capture, destination preservation and cleanup
tombstones. The voice journal assertions require installed instrumentation.

Create the app-private `files/` directory with `run-as` on a fresh install.
A developer provisions a one-use app-private `files/bootstrap.json` over stdin
with `run-as ai.moss.vocci sh -c 'cat > files/bootstrap.json'`. Supply JSON fields:
`address`, `sn`, `deviceId`, `bindKey` (existing owner binding), `origin` (plain
HTTPS origin, no trailing slash), and `cookie` (normal signed-in Moss cookie).
Read credentials from private owner-only files or the authorized diagnostic app's
private storage; never command arguments, logs, public documents or git. The client
checks the live session owner, consumes/removes the bootstrap, then retains config
with Android Keystore AES-GCM in `no_backup/config.enc`. An authorized debugging
host can inspect a debug process; Keystore does not remove that trust boundary.

There is no Vocci account sign-in/key recovery UI. Reuse an already-retained valid
binding; do not ask its owner to sign in again unless it is actually unavailable.
A new owner still needs legitimate Vocci account/backend key recovery. Refreshing
Moss credentials requires the same origin/owner/ring and an explicit restart.
Session cookies are general account credentials, not scoped ring capabilities.

Before starting, relinquish the official Vocci app's Nearby devices permissions
through Android's app settings. Its reconnect services make force-stop alone
insufficient. The client refuses while the installed official app has Bluetooth
connect permission. Do not disable the package or remove pairing/ownership as a
consumer flow. A developer physical-proof harness may save prior connect/scan
grants, revoke them, stop the official process, and restore the exact grants and
Bluetooth state in `finally` after stopping Moss. Test this handoff on the device;
consumer-guided handoff needs separate design.

Start `ai.moss.vocci/.DeliveryActivity` from the launcher or ADB. Grant Bluetooth
and notifications. The ongoing notification reports record-derived progress and
opens the status screen, with Start/Stop, permissions, account/ring identity,
voice opt-in and recent queue entries. To stop explicitly, launch the activity with action `stop`; physical
proof cleanup also force-stops this developer package before restoring Vocci.
The service polls every 30 seconds and retains a partial wake lock only during
bounded work. Sticky service restart handles OS reclamation; force-stop, permission
revocation and battery restrictions can require manual restart. No boot delivery
or indefinite background reliability is promised.

HTTP is accepted only at loopback for isolated development using an owned ADB
reverse on a claimed devport. Remote delivery requires HTTPS; redirects are
rejected. Never reuse/remove another session's forward or server.

## Durable behavior and limits

The service stores source identity and delivery entries in
`no_backup/delivery/state.json`. Complete exact packet and sidecar files are
published before decoding; an immutable `bundle.json` is published before upload.
No private bytes are sent to Android logs. A lost acceptance response replays the
same bundle. Accepted status retains import/meeting IDs and is polled to completion.
Server conflicts and terminal failures stay visible, including HTTP status; source identity never changes
to get around a failure. Authentication failure preserves pending work for session
refresh. Receiver processing failures are not reset by replay.

Unsupported inventory filenames are ignored. Invalid sidecar JSON and packet gaps
fail only that recording; retained evidence and other recordings remain available.
Framing failures restart from zero with per-source backoff and an eight-attempt
limit. New/healthy sources precede previously failing sources on each session,
so one repeated framing fault cannot monopolize retrieval. Ended sidecars with
missing, nonpositive or nonfinite duration fail with their evidence retained.
Oversized advertised files and completed durations fail visibly.
Discovered entries survive interrupted retrieval, and prerequisite failures expose
a blocked service outcome. Stop records stopped without reposting a notification.

Listing requires two stable snapshots, matching audio/sidecar names, completed
sidecar end/duration and exact transfer sizes/end frames. Partial reads restart
at zero after reconnect. Interrupted codec work recovers from the retained sources;
an already-frozen bundle is reused byte-for-byte. Platform Opus decoding validates
packet continuity. If the decoder outputs 48 kHz, a three-sample box filter precedes
16 kHz decimation; derived WAV is not claimed bit-identical to libopus's direct
16 kHz decoder. Original evidence remains unchanged.

Eight automatic upload attempts use exponential backoff (30 seconds to 30 minutes).
Connection failures continue reconnecting automatically with backoff capped at
30 minutes, so returning to range after an outage resumes retrieval. The queue stops retrieving
at 100 retained entries, 100 MiB, or less than 150 MiB free. Sources/bundles are
retained after success until Clear completed local audio is selected. That action
keeps identity tombstones to prevent redownload, and never clears queued, failed or
interrupted evidence. At 1024 retained identities, enrollment/discovery stops.
Automatic retention management is not implemented.

Receiver limits remain 120 seconds, 1 MiB packets, 64 KiB sidecar and 8 MiB upload.
Larger advertised files remain on the ring; over-duration decodes fail locally.
No large/resumable upload transport, iOS, fresh ownership or live streaming. Ring reboot and background reliability
beyond the actual PR proof remain unverified unless explicitly evidenced there.

## Version-2 voice receiver (developer API)

The companion hold-to-talk switch requests a stable complete inventory twice, then
saves an immutable request key/inventory before enabling voice delivery. A lost
response or restart reuses that exact snapshot. Disabling while its result is
unknown resolves and disables the same epoch. Existing queue entries and baseline
recordings remain version-1 meeting evidence forever. New `amsg_` recordings get a
frozen version-2 destination; disabling never rewrites an existing bundle.
The short version-2 envelope retains the same 120-second and file-size bounds; it
is separate from the planned resumable long-file transport.

1. After reading the complete ring inventory, POST `/api/meetings/voice-enablement`
   with `{ version: 2, sourceDeviceId, requestKey, recordingIds }`. Keep the request
   key and response ID durably before attempting voice delivery. Retrying the same
   key returns the same snapshot and enablement time; changed inventory conflicts.
2. Existing inventory members remain meeting imports across later enablements.
   For a new hold file only, POST `/api/meetings/voice-recordings` with
   `{ version: 2, intent: "voice-request", enablementId, capturedAt, recording }`.
   `recording` is the original version-1 bundle, including exact source evidence.
   Use a real phone-observed capture time in canonical ISO form, or `null` when it
   was not observed. Do not substitute a ring file timestamp for that observation.
3. Poll `/api/meetings/voice-recordings/:id`. The receiver retains the audio without
   creating a meeting. Its transcription and Chat-owned admission commit together;
   the completed receipt includes `voiceRequestId`. Review that request through
   `/api/chat/voice-requests/:id`. Uncertain or stale captures require explicit
   `POST /api/chat/voice-requests/:id/send` in Moss, without a replacement body.
4. `POST /api/meetings/voice-recordings/:id/retry`, without a body, retries failed
   transcription. It preserves the source and returns an already-completed receipt
   unchanged. It never resubmits a chat turn.
5. `POST /api/meetings/voice-enablement/:id/disable`, without a body, prevents new
   intakes. Previously accepted requests keep their existing admission state.
   Replaying that enablement's original key does not reactivate it; a new enablement
   needs a fresh full inventory and request key.

The current Android client always supplies `capturedAt: null`: polling a file list
is not observing a capture. Open Review in Moss, expand Ring voice requests in
Main, and press Send to Main after checking the transcript. Replies appear as normal
text messages; Open reply selects the existing Main thread. Private, module and
other chat selections hide the review list. Voice links resolve owned receipts and
never auto-send. Retry transcription only applies to failed receiver processing,
not interrupted Chat turns.

The server checks the phone-supplied capture time against enablement, receipt and
sidecar timing; missing or inconsistent timing requires Send. These are supplied
recording evidence, not hardware attestation. Main chat applies its age rule again
before dispatch and retains its normal action confirmations. These endpoints reject
delegated model access. A real hold recording reaching a persisted Main reply and
installed companion screens remain required live-path work.

## Installed proof

Use `verify-gate` and `scripts/run-gate.sh` for the isolated `test:recording-live`
gate. `VOCCI_LIVE_BROWSER_SCRIPT` points to a private executable Playwright driver.
It must create the owner and configure Voice through the real UI, provision and
start this installed client, retrieve the actual ring's normal and hold files,
compare source hashes with independent fresh authenticated re-downloads, assert
exact sidecar-derived bookmarks/mode and replay IDs, exercise screen
off/restart, and open nonempty transcripts from real Meetings history. Use actual
configured transcription. No network interception or substituted packet uploads.
Keep recordings, private drivers, cookies, endpoint details and transcript text
outside git. Record bounded assertion receipts on the PR. Restore phone state and
release only owned resources even when a check fails.
