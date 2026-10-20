# Vocci Android companion: meetings and text conversations

Status: proposed for Ben's approval. This document extends the merged developer
delivery slice; it does not authorize implementation until approved.
Tracking task: [#3553](https://github.com/motioneso/moss/issues/3553).

## Outcome

The Android companion connects an already-owned Vocci ring to Moss. Normal
recordings become meetings with transcripts, summaries, decisions, and suggested
tasks/follow-ups. Hold-to-talk becomes a user message in the main Moss chat, where
Moss responds in text. Ben explicitly selected text-only replies on 2026-10-20.
Completed-file delivery is the baseline. Investigate live streaming separately.

| Ring interaction                   | Destination    | Result                                                                              |
| ---------------------------------- | -------------- | ----------------------------------------------------------------------------------- |
| Normal recording, then stop        | Meetings       | One meeting, transcript, summary and suggested actions                              |
| Bookmark while recording           | That meeting   | Preserve the original offset and link to the transcript                             |
| Hold to talk, then release         | Main Moss chat | Transcribed user message, normal Moss processing and text reply                     |
| Record away from the phone/network | Local queue    | Deliver when connectivity returns, with explicit handling of delayed voice requests |

Meeting actions use the existing review/Add task workflow. They retain transcript
evidence and do not invent owners or deadlines. Hold-to-talk intentionally sends a
user instruction through the usual Moss action permissions and confirmation flows.
Meeting speech remains evidence rather than instructions to the assistant.

## Verified baseline and remaining work

PR [#3551](https://github.com/motioneso/moss/pull/3551) merged the Android developer
client at `aba4bd7f39d9201be5fc41c3c93bcc8b05bc28d6`. The preceding receiver is also
merged. Current code in `apps/vocci-delivery` authenticates an existing ring,
retrieves completed files, retains sidecars/hashes/bookmarks, decodes audio and
replays durable uploads. Both normal and `amsg_` recordings currently become
Meetings imports; voice-request classification does not dispatch a chat turn.

This is a developer-installed application with private bootstrap provisioning and
a foreground notification, not finished consumer setup. Its limits are 120 seconds,
1 MiB packets, 64 KiB sidecar and an 8 MiB JSON request. Those limits prevent ordinary
meeting-length recordings from passing. The importer commits a transcript but does
not schedule the existing summary workflow.

Relevant seams verified in the current code:

- `packages/meetings/src/recording-import-service.ts`: acceptance, transcript commit
  and completion; source identity and immutable fingerprints already exist.
- `packages/meetings/src/output-service.ts`: meeting output generation and existing
  validation/evidence rules. Automatic-on-stop admission currently depends on a
  capture grant, so imports need their own completion trigger.
- `packages/chat/src/live/chat-session-manager.ts`: normal turn execution and
  persisted replies. A replayable voice-request admission boundary must precede it;
  a bare retry of `submitTurn` does not establish idempotency.
- `packages/module-registry`: composition across declared module APIs; Meetings
  must not import Chat internals or query Chat tables.

## 1. Completed recording to processed meeting

Keep one stable meeting identity for the entire original recording. Preserve exact
source packet and sidecar bytes, source UUID/recording ID, hashes, normalized bookmark
offsets and the original recording time separately from upload time.

After the complete transcript commits, schedule an import-completion processing
intent in the same transaction. A durable, metadata-only job invokes the existing
meeting output generator with a stable request key and the committed transcript
revision. It uses the person's configured transcription and generation capabilities.
Do not fabricate a live capture grant to enter `generateOnStop`.

Use the existing summary template and automatic-summary preference. When enabled,
generate once after transcription; when disabled, leave Generate summary available.
Show transcription and analysis as separate states. An analysis failure preserves
the transcript and offers a bounded explicit retry. Retries cannot create another
meeting, summary revision for the same intent, or duplicate Tasks. Existing summary,
decisions, evidence citations and Add task controls remain the review surface.

## 2. Hold-to-talk to a Moss text conversation

Enable this behavior explicitly in the companion. Submit transcribed messages into
the authenticated owner's main Moss chat using its existing conversation context
and normal thread lifecycle. Ben selected the main chat on 2026-10-20. Ring speech
is another input method for that chat; replies appear alongside its other messages.
Resolve and persist the destination thread when admitting a request so a reconnect
or retry cannot move an accepted message into a different conversation.

Retain the audio and its provenance, transcribe through the configured service,
then submit the final nonempty text as a user message through a public Chat-owned
admission API wired by the composition root. Preserve ordinary Chat context,
permissions, configured engine, tool confirmations and response persistence. Reply
in text in Moss. Audio playback, TTS, phone/earbud replies and ring playback are
outside this scope.

Persist the relationship between owner/source/recording, transcript revision,
thread, user message and execution identity before dispatch. The dispatch boundary
must support recovering an existing turn, not creating a new turn after an ambiguous
response. Serialize voice requests with other turns through the main chat's existing
admission/queue behavior, preserving any turn already in progress. Do not promise
exactly-once external effects beyond the existing action writer guarantees.

New requests use an explicit versioned voice-request intent. Existing version-1
imports retain their current behavior forever. At first enablement, snapshot the
ring inventory as a baseline; existing `amsg_` files and imported history never
become commands retroactively. Requests demonstrably captured after enablement
may be sent automatically after release. Requests over 15 minutes old, with
uncertain capture time, or found while establishing the baseline wait for explicit
Send in Moss. Silence/empty transcripts become "No speech detected" without a turn.
This age policy is a proposed default included in this approval.

Expose pending, transcribing, ready-to-send, responding, replied and failed states
with a link to the message in the main chat. Transcription and turn retries are
distinct. A provider outage, account change or revoked access preserves pending work.
A request
already submitted is not silently resubmitted by pressing Retry or reconnecting.

## 3. Meeting-length recordings

Add a version-2 resumable completed-recording transfer while retaining version 1.
Proposed first bounds: two hours, 32 MiB original packet file, 256 KiB sidecar and
256 MiB decoded WAV; binary upload chunks are at most 1 MiB. Enforce limits at both
ends and expose oversized recordings without deleting them from the ring.

Reserve an owner-scoped upload with immutable source identity, manifest and file
sizes/hashes. Upload binary file chunks with position/hash and replay detection;
query durable received progress after interruption. Conflicting bytes return a
conflict. Finalize only after complete coverage, recomputed whole-file hashes,
strict packet/sidecar checks, WAV geometry and decoded duration validation. The
server still treats decoded audio as supplied evidence, not hardware attestation.

Store originals and derived audio as files rather than one base64 JSON object.
Stream phone decoding/upload and server assembly; memory use must be bounded by
chunk size, not total recording size. Reserve disk capacity before starting,
including decoding space and a free-space reserve. Expire abandoned partial server
uploads; retain phone originals until accepted and processed. Provide explicit
cleanup for completed local items and preserve queued/failed evidence by default.

Transcribe in bounded windows supported by the configured transcription adapter,
offset timestamps back into the original meeting and checkpoint progress. Confirm
the adapter's duration/output limits during implementation. A fixed 35-second
whole-recording deadline and the existing 500-segment cap cannot serve a two-hour
recording. Window retries must preserve stable segment IDs and avoid duplicate
text at boundaries. Final summary generation waits for all windows to commit.

BLE offset resume remains an investigation. Until validated against hardware, a
disconnected ring read restarts from zero into a temporary file, while an already
retrieved recording's HTTP upload resumes independently. Never claim resumable BLE
because the network upload resumes.

## 4. Companion screens and setup boundary

Extend the existing native Android app; keep Meetings and Chat as the Moss product
surfaces. Proposed screen structure for approval:

```text
Vocci companion
  Ring: Connected / Reconnecting / Needs attention
  Moss: Connected / Sign-in required
  [Start / Stop connection]  [Setup]
  Hold-to-talk messages: On / Off
  Recent recordings
    Meeting recording   Uploading 42%       [View meeting when available]
    Voice request       Moss replied       [Open main chat]
    Voice request       Waiting to send    [Open in Moss]
    Meeting recording   Storage full       [Manage storage]

Setup
  1. Connect Moss account
  2. Select the already-owned ring
  3. Grant Bluetooth/notifications and hand off from Vocci
  4. Enable meeting processing and hold-to-talk

Manage storage
  Queued / Failed / Complete space usage
  [Clear completed local copies]
```

Show actionable prerequisite/error states, account identity, queue progress and
last successful delivery. Notification Stop preserves queued work. Android battery,
force-stop and background restrictions remain visible reliability constraints.

Reuse the retained binding for the already-configured ring. For broader onboarding,
validate supported official Vocci sign-in and read-only binding retrieval before
promising a browser login/return flow. Do not turn diagnostic credential extraction
or package disabling into consumer setup. Keep credentials in Keystore-backed
storage; continue owner/origin/ring pinning. Moss account login/session refresh needs
a reviewed supported exchange; do not embed or scrape a login page or introduce a
new auth bypass. Initial behavior slices can use the established developer
provisioning while this setup seam is designed and verified separately.

## 5. Live-streaming investigation

The prior hardware inventory on Timon V2.5.1 / firmware 0.4.01 exposed legacy GATT
services, not the V3 live L2CAP services packaged in the official APK. A prior
recording with UART/auth/audio/file subscriptions emitted recording events but no
live audio. These are prior observations, not a new capture in this design session;
they establish neither support nor impossibility for every legacy mode.

Investigate the legacy audio activation path in the saved official APK/bytecode,
then run a bounded authenticated capture with successful audio subscriptions
before a real recording. Distinguish audio arriving during recording from file
transfer after stop; measure first-packet latency, continuity and decoding. Require
an observed documented activation command before trying additional ring writes.
Preserve ownership, recordings and firmware, and restore the prior phone/app state.

Deliver one of: verified legacy live audio with an activation recipe; a bounded
negative result identifying tested conditions; or a specific unresolved dependency.
V3 source presence alone is not a firmware upgrade plan. Integrating proven live
audio into Moss's capture grants/leases is a subsequent design extension. The
completed-recording flows above can ship regardless of the investigation result.

## Build order and completion evidence

Use separate task/PR slices: (1) explicit voice-request admission, text replies and
imported-meeting analysis on the existing short transport; (2) resumable long-file
transport and windowed transcription; (3) companion screens and supported setup.
The live investigation is independent. Each slice must state its remaining limits.

Before calling the companion complete, prove installed ring → Android → Moss with
real recordings: a meeting longer than two minutes and ultimately the two-hour
boundary, preserved bookmarks, summary/actions available in Meetings, and a fresh
hold request that appears as one user message with a real text reply. Exercise
restart, lost acceptance/turn responses, duplicate inventory, offline return,
stale request review, account mismatch, disabled modules and storage exhaustion.
Verify first-enable backlog does not execute, and replay does not create duplicate
messages/actions. Prove consent/access guards with failing negative controls.

Run Android host/device checks and repository lint, format, file-size, types and
scoped integration tests. DB/live checks use the verify-gate workflow. Every product
PR updates the owning app-map declarations and includes actual UI-path proof;
public receipts exclude private audio, transcripts and credentials. Ring reboot and
background endurance claims need their own observed tests. No production deployment
or firmware update is authorized by this proposed spec.
