# Automatic completed-recording delivery — Android developer slice

Authority: Ben's 2026-10-20 boot brief and automatic-delivery handoff authorize the
completed-recording MVP and routine implementation choices. This spec records that
scope; it does not claim approval of consumer onboarding or new screens/modules.
Task: [#3550](https://github.com/motioneso/moss/issues/3550), following #3547.
Receiver PR #3548 merged as `3d70e348b`; independent review and merge verified.

## Outcome

An installed Android client authenticates the existing owned legacy ring, retrieves
completed normal and hold recordings, decodes audio on Android, and uploads through
the existing authenticated Meetings receiver. Configured transcription and existing
Meetings history remain the destination. Source packets/sidecars, original IDs,
hashes, bookmark offsets and voice-request classification survive. Requests never
execute. Limits remain 120 seconds, 1 MiB packets, 64 KiB sidecar, 8 MiB request.

## Android and authorization seam

Add a self-contained Java Android application under `apps/vocci-delivery`, using
Android SDK APIs and a reproducible SDK build script. This is a developer-installed
client, not consumer onboarding. A minimal launch activity starts/stops a
connected-device foreground service; the system notification reports deterministic
stored delivery counts/status and offers Stop. No new Moss screen or module.

Developer provisioning supplies the already-retained binding config and a normal
Moss session cookie over an authorized ADB stdin path, never arguments or logs. A
one-use private bootstrap file is consumed and removed, then credentials are saved
using AES-GCM with an Android Keystore key. Backup is disabled. The debug build is
explicitly development-only; an authorized debugging host can access its data.
No claim of confinement against the developer/OS is made. Configure HTTPS origins,
with loopback HTTP solely for isolated development via ADB reverse. Disable redirects
and bound requests/responses. Check the session owner with the existing auth session
endpoint and pin owner, origin and physical ring in local configuration. Refreshing
the same owner's cookie preserves source identity; replacing owner/origin/ring is
rejected to prevent pending recordings crossing accounts. No macOS device identity,
companion credential, or new backend auth bypass is introduced. Session expiry
blocks delivery until the developer refreshes that same owner's session.

## Retrieval, identity and recovery

Use the validated existing-binding 0x80/0x82 handshake, verified ring proof and
canonical connection MAC. Verify expected serial/device ID before starting auth.
Serialize GATT operations, negotiate MTU and subscribe to AUTH/UART/file data.
Only identity/auth, list 0x11 and read-file 0x12 commands exist. Never pair, bind,
record, delete or acknowledge destructive sync completion.

Poll inventories, pair only allowlisted opus/json names, require stable advertised
sizes across inventories and a completed sidecar before retrieving audio. Enforce
advertised sizes and transfer start/end frames; unexpected data aborts the session.
An interrupted read is restarted from zero; an incomplete file is never published.
Persist exact complete source files before decoding. Android's Opus decoder produces
PCM; canonicalize to 16 kHz mono signed 16-bit WAV, reject gaps and duration overflow.
A frozen bundle is atomically published before any HTTP request. Retries use those
same bytes, hashes and source UUID, including after an ambiguous HTTP timeout.

One serial service executor owns durable atomic state. A source UUID persists for
this physical ring. Local entries move from discovered → retrieved → ready →
accepted → complete, with explicit blocked/failed outcomes. Store IDs/status before
next work; recovering after process death replays the same frozen ready bundle or
polls its accepted import. Server 409, invalid input, oversized duration and terminal
processing failure remain visible and do not mutate identity. Network/5xx/429 use
bounded exponential backoff and a finite automatic attempt limit; no tight loops.
Disk exhaustion stops publication. Local evidence stays private and is not deleted
following successful upload. Bound retained storage and stop retrieving at capacity;
manual retention management is a later decision.

A user-started connected-device foreground service polls while the screen is off,
reconnects with backoff and resumes durable work after OS process reclamation.
Stop disconnects and leaves pending evidence. Force-stop/permission revocation/OS
battery restrictions may require explicit restart; no boot or indefinite-background
guarantee is made. Ring reboot resilience must be tested or reported unverified.

## Official-app handoff

Do not compete with Vocci's reconnect services. The developer must relinquish its
Nearby devices access through Android permissions before starting this client;
the client refuses while the installed official app retains Bluetooth connect
access. This is an explicit reversible OS-permission handoff, not package disabling
or account unbinding. The physical proof saves prior permission/Bluetooth state,
revokes conflicting connect/scan grants, stops the official process, verifies the
handoff, then restores prior grants and Bluetooth in a finally block after stopping
Moss. Consumer-guided permission handoff/account key recovery needs separate design.
If the official app still interferes, stop and report it rather than silently
falling back to package disabling as a product flow.

## Verification and limits

Test framing/authentication, strict completed-file parsing, interruption recovery,
immutable frozen retries and attempt/backoff state. On-device assertions exercise
Keystore tamper rejection, codec output, service status and restart. Required
security assertions must fail with their protection removed, restoring exact files.
Run repository lint/format/file-size/type checks and scoped tests. Database/live
proof runs only through `scripts/run-gate.sh` under verify-gate instructions.

Installed-path proof: real owner signup → Voice Settings → Meetings settings →
Android retrieves real ring normal/hold files → authenticated acceptance → configured
local transcription → open nonempty transcript articles from history. Assert raw
source hashes against prior known captures, normal bookmark 13,000 ms, hold mode,
replay IDs, screen-off operation and interrupted/restarted delivery. Preserve only
bounded redacted assertions publicly; private audio, cookies, MACs, keys and text
stay outside git. Keep app map and release note accurate about developer scope.

Consumer sign-in/key recovery, new setup screens, live streaming, fresh ownership,
long/resumable transfers, iOS and automatic request execution are outside scope.
No production deployment. No completion/merge claim without real installed proof.
