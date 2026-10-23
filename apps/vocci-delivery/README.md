# Android ring companion

This repo-owned Android client retrieves finished legacy Vocci recordings and
uploads them to Moss's existing Meetings receiver. It is a developer-installed
foreground service with guided setup for already-owned rings. No ownership, pairing, recording
control, ring deletion or destructive sync acknowledgement commands exist. Normal
recordings become Meetings evidence; newly opted-in hold recordings go to Main chat.

From `~/Jarv1s`, run `apps/vocci-delivery/test.sh` (exit 0 expected). Requires JDK
21, Android SDK platform/build-tools 35.0.0; override `JAVA_HOME` and
`ANDROID_SDK_ROOT` if needed. The build script uses SDK tools directly without a
Gradle/network dependency. Generated development signing material and APKs stay
in ignored `build/`. The default APK is debuggable and development-only; use the
separate release mode below for distribution packaging. Target API 35, minimum
API 33; tested devices/results belong on the PR.

## Set up an already-owned ring

Fresh installs open **Set up your ring**. Configured installs open **Hardware**,
with **Vocci ring** settings, and keep their current ring, account, pending audio
and hold choice.
The new wizard is implemented; its complete setup-to-recording live acceptance is
still pending in #3565. Use a development build for this pre-release flow.

1. Enter your Moss server address and choose **Connect Moss in browser**. Sign into
   Moss, review the Android permissions and approve. Return and **Check approval**.
2. Enter the email for the existing Vocci account that owns the ring. Choose
   **Send code** and enter the email code directly in the app. If requested, enter
   your authenticator code. Resend is explicit and shows a cooldown. Unsupported
   sign-in methods stop with an explanation; this does not create an account.
3. Choose a ring from **Rings on your Vocci account**, then **Select ring**. Allow
   Nearby devices, turn Bluetooth on and keep the ring close. If Vocci is installed,
   open its app settings → Permissions and remove Nearby devices access. Return
   and choose **Verify ring**. Cloud lookup alone does not complete verification.
4. After setup is saved, review Bluetooth, notifications and background battery
   settings in **Ready to connect**, then explicitly **Start delivery**. Enable
   **Hold-to-talk in Main chat** only when you want it. Enrollment waits for two
   stable ring inventories; review each new hold transcript in Moss and press
   **Send** for a text reply. Setup itself starts neither delivery nor hold input.
   **Continue to companion** opens recent deliveries; **Ring setup and delivery
   options** reopens the saved setup summary without changing the current choices.

Cancel setup confirms remote cleanup when online. If offline, reconnect and retry;
unconfirmed cleanup remains pending. Reopening resumes staged Moss/ring selection.
An interrupted unverified email attempt needs sign-in cleanup before another code;
a verified saved attempt offers **Finish ring lookup**. No background email sends.
Keep the original Moss origin/owner/ring for recovery. Corrupt configuration or
orphaned queued audio blocks adoption of another setup. A new factory-fresh ring,
ownership transfer, firmware and ring-audio deletion are outside this flow.

## Developer bootstrap and checks

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

To include the real Android HTTP regression, claim a port with `devports claim
vocci-http-check`, pass it as `-e httpPort <claimed-port>` to instrumentation, then
release it with `devports release <claimed-port>`. Require `httpContract=json_null_post`.
This verifies that finalization sends explicit JSON `null`: Android otherwise adds
a form content type to an empty POST, which the receiver rejects with HTTP 415.

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

The guided flow above retrieves an existing owner binding. Developer bootstrap
remains available for diagnostics. Reuse an already-retained valid binding; do not
ask its owner to sign in again unless it is actually unavailable. Refreshing
Moss credentials preserves the same origin/owner/ring and requires an explicit
restart. Session cookies are general account credentials; browser linking below
replaces the initial developer cookie with an Android device credential.

Before starting, relinquish the official Vocci app's Nearby devices permissions
through Android's app settings. Its reconnect services make force-stop alone
insufficient. The client refuses while the installed official app has Bluetooth
connect permission. Do not disable the package or remove pairing/ownership as a
consumer flow. A developer physical-proof harness may save prior connect/scan
grants, revoke them, stop the official process, and restore the exact grants and
Bluetooth state in `finally` after stopping Moss. Test this handoff on the device;
the companion's Open Vocci app settings action supports this handoff without
changing the binding.

Start `ai.moss.vocci/.DeliveryActivity` from the launcher or ADB. Grant Bluetooth
and notifications. The ongoing notification reports record-derived progress and
opens the status screen, with Start/Stop, permissions, account/ring identity,
voice opt-in and recent queue entries. To stop explicitly, launch the activity with action `stop`; physical
proof cleanup also force-stops this developer package before restoring Vocci.
The service polls every 30 seconds and retains a partial wake lock only during
bounded work. Sticky service restart handles OS reclamation. An explicit Start also enables
recovery after boot/unlock and app update; Stop disables recovery. Android can
refuse a background start, which leaves an Open app/Start delivery reminder.
Only **Start delivery** enables recovery. While stopped, voice changes, manual cleanup
and transcription retries ask you to Start first; maintenance actions never enable
restart recovery. Force-stop still requires a manual launch. Permissions and background settings opens App settings
for battery/permission recovery and Vocci settings for Nearby devices handoff.
Choose Unrestricted battery use and remove Moss from Samsung Sleeping apps for
daily use. Device-specific endurance remains a live validation requirement.

HTTP is accepted only at loopback for isolated development using an owned ADB
reverse on a claimed devport. Remote delivery requires HTTPS; redirects are
rejected. Never reuse/remove another session's forward or server.

## Native Hardware settings

The launcher opens **Hardware → Vocci ring** using the selected flat Park Press
settings list. The app is named **Moss** (development packages say **Moss (dev)**).
Opening it starts neither delivery nor hold enrollment. Automatic delivery is the
existing explicit Start/Stop choice; hold enrollment remains separately opted in.
Delivery details keeps the previous status, account recovery and recent delivery UI.
This does not add an embedded Moss web shell or a new web Hardware route.

Battery, recording state, ring capacity and firmware are optional saved observations,
with per-field times. A stale read never claims a current connection. Queries run on
the service's serialized GATT connection after file retrieval, with at most nine
seconds per cycle; telemetry failure cannot fail a recording. The standard ring-info
query also aligns the ring clock with the phone, matching the official protocol.
Storage and recording queries do not control recording. Malformed data retains its
previous observation time. No destructive command is added. Snapshot polling preserves
native controls,
focus and scroll; system dark mode and font scale apply. Archivo is bundled under
`assets/fonts/` with its OFL license.

Ring storage and Phone audio stay separate. Completed phone-copy cleanup confirms
its scope; optional seven-day cleanup keeps pending/failed/interrupted audio. Neither
removes ring sources or Moss copies. Connection & permissions has Android permission,
battery and official-app handoff guidance. How to use your ring explains double-click
recording, bookmarks, hold review/send and offline behavior. About this ring shows
saved identity and observed versions.

An opt-in **Remind me after an hour** notification follows repeated observations
of the same active recording. It requires delivery and notifications, sends once per
observed recording and never stops capture. Unknown/missing status, observation gaps
over two minutes, and service restart reset the timer. A missing source name cannot
start a timer. This is observed time, not a measurement of the recording duration.

Individual ring recording management and firmware updating are explicitly unavailable
in this build; tracked in #3584.

## Durable behavior and limits

The service stores source identity and delivery entries in
`no_backup/delivery/state.json`. Complete exact packet and sidecar files are
published before decoding; an immutable version-3 `upload.json` manifest is published before upload. Existing frozen version-1/2 `bundle.json` files keep their original receiver and bytes.
No private bytes are sent to Android logs. A lost reserve response replays the same manifest. HTTP progress is saved after responses; restart queries the server and sends only missing chunks. Accepted status retains import/meeting IDs and is polled to completion.
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
an already-frozen manifest or legacy bundle is reused byte-for-byte. Platform Opus decoding validates
packet continuity. Audio retrieval writes into an atomic file sink, and the codec reads
one packet at a time into a file-backed WAV. PCM conversion uses an 8 KiB buffer,
carrying partial samples and resampling groups across output buffers. New uploads stream hashes and read at most 1 MiB per HTTP chunk. Legacy frozen JSON bundles still load their bounded base64 payload in memory.
If the decoder outputs 48 kHz, a three-sample box filter precedes
16 kHz decimation; derived WAV is not claimed bit-identical to libopus's direct
16 kHz decoder. Original evidence remains unchanged.

Eight automatic upload attempts use exponential backoff (30 seconds to 30 minutes).
Connection failures continue reconnecting automatically with backoff capped at
30 minutes, so returning to range after an outage resumes retrieval. The queue stops retrieving
at 100 retained entries, 2 GiB including reserved retrieval/decode budgets, or less than 150 MiB free. The status screen separates queued, failed and completed bytes and shows acknowledged upload percentage. Sources/bundles are
retained after success until Clear completed local audio is selected. That action
keeps identity tombstones to prevent redownload, and never clears queued, failed or
interrupted evidence. At 1024 retained identities, enrollment/discovery stops.
The optional Clear delivered audio after 7 days switch is off by default. While
delivery is active it clears only completed local copies after seven days, including
atomic sidecars, keeping source identity tombstones. Older completed entries get a
full grace period when retention first runs. Queued, failed, ready-to-send and
interrupted evidence is preserved. Moss copies and ring recordings are unchanged.

New version-3 Meeting uploads accept two hours, 32 MiB packets, 256 KiB sidecar,
and 256 MiB canonical WAV. Explicit voice requests remain limited to 120 seconds.
Legacy v1/v2 envelopes retain their original short limits. Per-recording local
budgets include atomic WAV replacement space. BLE reads restart at zero; HTTP
uploads resume independently for 24 hours. Expired uploads retain their identity
and local sources; they cannot be reopened by changing IDs or destinations.

A host regression writes generated two-hour PCM under a 32 MiB Java heap. Installed
instrumentation decodes a generated 130-second Opus silence fixture through the
platform codec and confirms short voice limits still apply. Generated fixtures
are not real ring capture or speech-recognition evidence. Two-hour binary HTTP
and 240 checkpoint windows are integration-tested with generated PCM and stub ASR.
No two-hour hardware recording or real two-hour ASR proof is claimed.

The October 21 developer proof additionally decoded 360,000 generated 20 ms Opus
silence frames through the installed Android codec, producing an exact two-hour
16 kHz mono PCM WAV (230,400,044 bytes) in about 94 seconds. This isolated proof
used the repository's decoder unchanged and removed its generated local files
afterward. It is codec/size evidence, separate from the generated server-window
test and the real 226-second ring recording. Ben accepted simulated upper-bound
validation for this slice; physical two-hour endurance is not a completion gate.

No iOS, fresh ownership or live streaming support. Ring reboot and background
reliability beyond the actual PR proof remain unverified.

## Link your Moss account

After setup is saved, open the companion and choose **Connect
Moss in browser**. This stops delivery while you change its account connection.
Sign into the original Moss account, review the Android permissions, and approve.
Return to the companion; it shows **Account connected · device approval**. Press
**Start delivery** when ready. Browser approval does not start ring delivery.
The native app replaces the developer session cookie with a `vr1_` device
credential. It uses recording receivers, individual voice-request status, and
its own session/logout endpoints; ordinary account APIs and Mac focus endpoints
retain their existing authentication. The pending verifier is retained in a
separate Android Keystore-encrypted file until approval or cancellation.

**Reopen browser approval** resumes a pending request. **Cancel connection
request** retires it. Requests expire after ten minutes. If approval was already
redeemed but its acknowledgement was lost, cancel and start a fresh request;
never replace the local recording IDs. A different-account approval is rejected
without moving the existing ring queue. The rejected device is cancelled too.

In Moss, **Settings → Account & preferences → Active sessions** lists the phone
as **Moss ring companion**. Sign it out there to revoke its connection. The
companion stops at the next rejected owner or upload request and asks you to
reconnect. Credentials expire after 90 inactive days, with a one-year ceiling;
normal owner checks refresh the inactivity window. **Disconnect Moss account**
revokes the device before removing its local credential. Ring binding, owner pin,
queue, and pending audio stay on the phone. Reconnect with the original account
and press Start to resume. Replacing an existing account link retires its previous
device credential after the new connection is verified. Already-owned rings use the guided setup above. Factory-fresh ownership must first
be established in Vocci; Moss reconnection does not repeat key lookup or bind a ring.

## Release packaging

Run `apps/vocci-delivery/build.sh release` with these environment variables:

```text
VOCCI_RELEASE_KEYSTORE=<existing private signing keystore>
VOCCI_RELEASE_STORE_PASSWORD_FILE=<private file containing store password>
VOCCI_RELEASE_KEY_PASSWORD_FILE=<private file containing key password>
VOCCI_RELEASE_KEY_ALIAS=<existing signing alias>
VOCCI_RELEASE_VERSION_CODE=<positive monotonically increasing integer>
VOCCI_RELEASE_VERSION_NAME=<release version>
```

Keep passwords out of command arguments and git. Use the same password-file path
when the key and store passwords match. Release mode requires supplied signing
material; it does not generate a release identity. The result is
`build/moss-vocci-release.apk`, with debugging, cleartext HTTP, instrumentation,
and check classes removed. APK signature verification runs before success.
Retain the original signing certificate for updates. Never uninstall a configured
companion or substitute another key to work around an update-signature error:
that loses its private binding/queue. A release APK cannot use the development
loopback HTTP exception; use a working HTTPS Moss origin. Release packaging
verification with a temporary test key is not a production distribution or an
update-compatibility proof for a person's installed signing identity.

## Version-3 resumable receiver

1. POST `/api/meetings/recording-uploads` with version 3, immutable source device and
   recording IDs, destination, and each file's exact byte length and SHA256. The
   server commits source identity and expiry before allocating Vault chunk files.
2. Save the returned upload ID, fingerprint, expiry and progress. GET
   `/api/meetings/recording-uploads/:id` after restart. PUT missing binary chunks to
   `/:id/:kind/:index` using `application/octet-stream`; kinds are `packets`,
   `sidecar`, `wav`, indices start at zero, and each chunk is at most 1 MiB.
   Exact replay repairs a lost response; changed bytes or destination conflict.
3. POST `/:id/finalize` with no body or JSON `null` after complete coverage. The server validates
   complete hashes, framing, WAV and sidecar before marking the source ready.
4. Poll existing import/voice status routes. Transcription commits one 30-second
   window and next-job checkpoint together; final Meeting analysis runs once after
   the last window. Voice enters Chat through its existing public admission API.
5. Abandoned allocations expire after 24 hours. Cleanup deletes files and chunk
   progress while retaining immutable source identity. Account export includes
   individually verified source chunks; the enclosing JSON archive still accumulates
   in memory. Account deletion cascades rows and removes the owner's Vault.

## Version-2 voice receiver (developer API)

The companion hold-to-talk switch requests a stable complete inventory twice, then
saves an immutable request key/inventory before enabling voice delivery. A lost
response or restart reuses that exact snapshot. Disabling while its result is
unknown resolves and disables the same epoch. Existing queue entries and baseline
recordings keep their Meeting destination. New `amsg_` recordings get a frozen
explicit voice destination; disabling never rewrites existing evidence.
The short version-2 envelope retains the same 120-second and file-size bounds; it
remains supported alongside version 3. Version 2 denotes short explicit voice intent; version 3 denotes the resumable transport.

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

For explicit, non-uploading telemetry checks with delivery stopped, run DeviceChecks
with `-e hardware true`. It authenticates the configured ring, reads inventory and
status, and publishes a real Hardware snapshot without retrieving or uploading audio.
It reports only field-availability booleans. Keep the official app from competing
for Bluetooth and restore any temporary permission changes after the check.
