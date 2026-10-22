# Vocci companion phase two: durable Main chat admission

Approved spec: [Vocci companion](../specs/2026-10-20-vocci-companion-meetings-chat.md).
Task: [#3553](https://github.com/motioneso/moss/issues/3553). Existing approval applies.

## Grounded boundaries

- `ChatSessionManager.submitTurn` owns the synchronous actor/drawer busy guard.
  `runChatTurn` generates its own turn ID. The pre-model reminder/classifier path
  can act before the optional, best-effort live-turn record is opened.
- `selectTurnThread` follows a warm drawer session. `ensureSessionForCurrentProvider`
  returns a matching-provider warm session without rebinding it. `resumeThread`
  stops current work and discards the session; it is not an admission API.
- `ChatRepository.findStoredTurn` already recovers saved message pairs by turn ID.
  `CompletedTurnOptions` and the persistence ports carry that ID through model,
  classifier and reminder writers. Message IDs currently arise at completion.
- `getPrivacyState` identifies the shown thread/privacy. Manager subscribers are
  actor/surface scoped. Background replies have thread-aware routing and browser
  filtering; voice activity and approvals need their own captured-thread identity.

## Implementation sequence

1. Add a Chat-owned, owner-scoped durable admission repository/service and a new
   module migration. Reserve immutable source identity, transcript revision/text,
   Main thread, turn ID and user/assistant message IDs before any action. Duplicate
   admissions recover the same receipt; changed immutable input conflicts. Retain
   these records in account export and remove them with the owning account/thread.
2. State transitions are explicit: ready-to-send (old/uncertain capture), queued,
   dispatching, replied, interrupted. Empty text is a terminal no-speech receipt.
   Metadata-only work scheduling carries IDs. Busy work stays queued. Recheck the
   approved 15-minute age rule immediately before dispatch; waiting never grants
   fresh permission. Explicit Send authorizes that one retained request.
3. Add a narrow manager entry point sharing the ordinary drawer guard. It checks
   Main, the warm/shown drawer, pending launches and selection transitions before
   claiming the receipt. A non-Main/private drawer defers without changing any
   engine, token, current-thread pointer or replay flag. Expose the reason as
   “Waiting until Main chat is available.” Immediate execution alongside a private
   session would require separate engine/token/action routing and is not implied.
4. Pin the ordinary pre-model and model paths to the admitted Main thread and
   stable turn/message IDs. Persist queued → dispatching before effects. Pass a
   thread-aware emitter through lifecycle and model activity; tag voice stream
   records with their thread and filter stale browser selections. Preserve normal
   tool confirmations and configured engines. Never inject the request as hidden
   module-control context.
5. Recover a saved real reply after a lost response. Work already dispatched by a
   previous API boot becomes interrupted/unknown if no saved completion exists;
   never automatically requeue it. A stop, failed save or ambiguous action result
   cannot silently become a new turn. This does not promise exactly-once effects
   beyond the existing action writers.
6. Expose the Chat-owned API through public exports/composition. Only new explicit
   versioned voice intent can enter it after transcription. Version-1 imports and
   pre-enable inventory stay meetings. Meetings never imports Chat internals or
   queries Chat tables. Android enablement snapshots the ring inventory; uncertain
   or delayed requests require Send in Moss. The next transport slice owns this
   versioned input and its Android UI; do not prematurely activate legacy imports.

## Verification and limits

Test immutable admission replay/conflicts, same receipt and identities across
retry, owner isolation/provenance, empty text, delayed confirmation, age crossing
while queued, and recovery after dispatch with/without saved output. Observe owner
isolation tests fail with the relevant protection removed in a disposable gate.
Exercise real manager pre-model/model paths with fixed identities; busy, private,
other-thread, pending-launch and transition deferrals must preserve warm state.
Prove tagged voice activity/approvals never render in another selected browser
thread. Existing ordinary chat, private-chat, reminder and classifier behavior
must remain green.

Run DB tests only through the verify-gate skill and `scripts/run-gate.sh`. Run
scoped lint/format, root TypeScript, manifest/export tests, required foundation and
CI checks. The product slice is not complete until a real hold recording reaches
Main and receives a persisted text reply through the real dev UI, with retry
assertions and bounded evidence recorded on the PR. No production deployment,
firmware changes, screenshot proof or intercepted responses.

The full companion remains open: resumable two-hour transport, companion screens
and setup, and an independent legacy live-audio investigation are later approved
slices. This plan does not mark them implemented.

## Runtime checkpoint

The API now composes the durable admission service with its existing Chat manager.
A separate consumer uses worker credentials to claim metadata-only jobs; owner work
uses the API's app data context. API startup and shutdown own both the recording
and voice consumers. Deferred work reschedules; known pre-dispatch outages retry.
The public transaction-aware admission method joins the receiver's transaction and
derives the owner from that transaction. Status/list/Send APIs expose an explicit
projection; reserved messages are linked only after a real reply commits. Delegated
model access to these review endpoints is rejected, including Send.

The short version-2 receiver now snapshots enablement inventory and retains explicit
voice audio without creating a Meeting. Baseline members from every enablement stay
meeting evidence. The immutable envelope and source fingerprint prevent version-1
imports from becoming voice commands. Transcript persistence, Chat admission and
the receiver completion receipt share a transaction through the public port.
The source module owns audio/export/deletion; Chat owns transcript/turn/reply status.
Explicit transcription Retry preserves the source and never replays a completed
chat request. Developer API contracts are documented in the Android README.

The Android client now implements durable enablement snapshots, versioned voice
bundles, status/queue controls, transcription retry and completed-audio cleanup.
The Moss Main drawer exposes review, Send to Main and Open reply. Capture timing
remains uncertain, so newly discovered hold recordings require explicit Send.

At committed head `9b010134b`, isolated live gate `225414` exited 0: retained actual
ring audio, submitted through the authenticated developer uploader, reached real
Whisper transcription and ordinary ACP Main execution. Open reply displayed the
persisted nonempty assistant response, and upload replay preserved exactly one
user/assistant pair. This proves the receiving/chat path, not installed Android
delivery. The updated companion is installed on the verified Samsung phone, and
platform codec, atomic-file, voice journal and cleanup checks pass. All seven
installed status controls were subsequently verified on the unlocked phone.
The resumable two-hour transport remains a separate approved slice, unimplemented.

On October 21, native live gate `075518` at head `392c9c3ca` retrieved and uploaded
two fresh physical samples after native Start delivery and hold opt-in: a normal
14.1-second recording with a 10-second bookmark, and a 6.3-second hold recording
classified as a voice request. Final native state retained two accepted, queued
receipts with no last failure. The gate exited 1 when its wait expired roughly
20 seconds after upload acceptance; its deadline had started before the user made
the samples. This proves installed retrieval, decoding and server acceptance,
but does not prove uninterrupted native processing, reply display or restart
recovery. Both immutable bundles were preserved privately for further checks.

Direct Whisper base transcription was clear for the normal sample, but the hold
transcript did not match the requested reply phrase. Independent libopus decoding
matched Android output sample counts and correlated above 0.997 for both samples.
Do not describe this as absent inventory or a confirmed decoder fault; hold
speech accuracy remains unresolved. The original companion's encrypted state
was preserved, and the native proof restored official Bluetooth grants and the
previous screen timeout during cleanup.

Fresh-bundle replay gate `081423` at the same head exited 0 (fingerprint
`4b83c10c2d78`, private browser run 2). The unchanged native packet, sidecar and WAV
files were re-uploaded through the authenticated developer receiver after the
native gate's server had been cleaned up. Real GPU Whisper base transcription,
real analysis and the Meetings UI preserved the 10-second bookmark and one summary
revision. The hold transcript reached explicit Send to Main, ordinary ACP
execution, persisted user/assistant messages and a visible Open reply. Replay kept
one message pair. The normal test sample produced no task suggestions; the earlier
generated-speech task acceptance proof remains separate.

This is a composite proof of native capture/acceptance and developer replay through
processing/UI, not an uninterrupted native delivery/restart proof. The hold
transcript still did not recognize the requested phrase, so reply plumbing passes
but speech accuracy does not. Earlier replay gate `081023` passed the Meeting
portion but failed hold transcription with the CPU proof recognizer; switching
only the private provider to GPU with beam search and fixed temperature cleared
that failure. No product transcription timeout, audio evidence or transcript was
changed for the passing replay.

The independent static streaming result is recorded in
[the investigation](../../research/2026-10-20-vocci-legacy-streaming.md): no active
legacy activation path was identified within the searched bytecode boundary, and
dynamic/native activation remains unresolved.
