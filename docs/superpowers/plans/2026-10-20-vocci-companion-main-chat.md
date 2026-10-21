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

This is still inactive for ring input. Next, the versioned receiver must preserve
the enablement inventory baseline and immutable intent, then admit transcription
completion through this public transaction-aware method. Never route existing
version-1 files into it. Status APIs alone are not the approved review UI or Android
screens. Real hold audio reaching a saved Main reply remains an unmet live-path gate.

The independent static streaming result is recorded in
[the investigation](../../research/2026-10-20-vocci-legacy-streaming.md): no active
legacy activation path was identified within the searched bytecode boundary, and
dynamic/native activation remains unresolved.
