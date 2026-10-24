# Automatic ring inputs through normal chat

Approved [spec](../specs/2026-10-24-vocci-normal-chat-input.md), task #3584.
Base: `4f757bccc52cdc589dcf96cd07e360486a9d26f2`.
One complete software slice; no phone or production operations.

## Verified seams and choice

- Receiver baseline/version checks: `packages/meetings/src/recording-voice-enablement.ts:96`
  and transcript transaction/public admission: `recording-import-service.ts:325`.
- Immutable receipt and source replay: `packages/chat/src/voice-requests.ts:97`;
  canonical scheduling/service: `voice-request-service.ts:54` and `:84`.
- Main/busy/privacy/transition guard before claim: `live/chat-session-manager.ts:237`;
  ordinary pre-model/model/persistence: `live/chat-session-turn.ts:83`.
- Voice UI presently separate: `apps/web/src/chat/voice-requests.tsx:29` and
  `chat-drawer.tsx:923`; typed drafts are bound independently at `:208`.
- Thread accepts canonical records: `packages/ui/src/chat-thread.tsx:35`;
  normal bubbles: `apps/web/src/chat/message-row.tsx:89`. Stream records and saved
  messages have turn IDs (`use-chat-stream.ts:420`), used for reconciliation.
- Owned deep links: `voice-request-link.tsx:9`. Saved-message reads use
  `listChatThreadMessages`; no new submission endpoint is needed.

Prefer server automatic admission plus inline canonical transcript rendering.
Composer insertion is a good fit for editable microphone text, but would require
browser presence and a second submission/receipt path for automatic ring delivery.
A browser auto-click of the old Send endpoint would also couple delivery to UI
mounts and risk changing legacy consent. Persist policy at admission instead.

## Decisions and sequence

1. Commit this plan, the controlling spec and corrected handoff before product edits;
   independent Standards/Spec review of this immutable plan, resolve findings.
2. Add module migration `packages/chat/sql/0332_chat_automatic_voice_inputs.sql`:
   `ALTER TABLE app.chat_voice_requests ADD COLUMN auto_send boolean NOT NULL DEFAULT false;`
   grant worker SELECT of that nonsecret column; register migration in manifest.
   Add the typed column and export projection. Existing records retain false;
   existing identity trigger already makes additional columns immutable.
   New admissions explicitly set true and queue all nonempty recognized text.
   `voiceNeedsConfirmation` first accepts immutable auto_send; legacy false uses
   the existing timestamp/explicit-confirmation rule. Fingerprint stays canonical
   to the source envelope so a replay cannot change policy or create a new turn.
3. Public status adds stable `turnId` and `createdAt`. Extend schema/fixtures.
   Query under owner/Main/privacy/selection fences, with an owner-specific key.
   Replace disclosure/list with canonical Thread inputs and recorded status rows.
   Deduplicate pending bubbles against live/saved turn IDs, never transcript text.
   Recover replied message pairs through the normal owned history API, matching
   receipt turn IDs; merge saved reply identities over transient replies. Preserve
   existing records and in-flight activity. Order pending arrivals by createdAt,id.
   No query or mount sends. Only legacy ready-to-send has its inline Send recovery;
   uncertain Send response invalidates status before another attempt. Interrupted
   requests expose their recorded explanation without a resend control.
4. Integrate within the drawer's existing scrolling transcript, remove old section
   and obsolete CSS. Leave composer/microphone/draft state untouched. Update Chat,
   Meetings and core app-map declarations to distinguish automatic NEW requests
   from retained legacy review. Deep links remain owned lookup/selection only.
5. Meaningful tests: new delayed/null-time automatic input, busy aging without
   losing automatic policy, legacy review/queued preservation, immutable policy,
   duplicate admission/send/process, no-speech, owner isolation, queue/reply failure.
   DOM tests exercise no disclosure, normal bubbles/status, live/history dedup,
   multiple requests, legacy lost-response retry, immediate hiding at every fence,
   owner cache change and no POST on mount/remount/links.
6. Real dev UI/data proof under verify-gate: disposable owner signup, actual Settings
   provider selection, generated versioned audio via receiver/enablement and real
   ASR/chat stand-ins. Show automatic normal message/reply, unsent typed draft,
   busy/private deferral, multiple arrivals, reload, immutable replay, provider
   failure/recovery and legacy inline recovery. Use Webwright textual assertions,
   disclose stand-ins/generated audio and retain failed runs. No Moss interception.
7. Independent immutable-head Standards/Spec review including raw proof, resolve
   and re-review findings; required final-head CI; authorized merge. Clean/push
   explicit paths and stop owned tools. Carry whole recovery queue forward.

## Determinism and verification

Status/confirmation/error UI derives from receipt/API records. The model's two
existing jobs are transcription and the normal Chat response/action proposal;
no new prompting, no model decision about admission, status, destination or replay.

Commands are unpiped, expected exit 0: scoped `pnpm exec vitest run` for relevant
unit suites; `pnpm verify:static`; `scripts/run-gate.sh start --gate test:voice-requests`
then one detached `scripts/run-gate.sh wait --follow`; and a scoped real-UI script
via the same gate. Verify scoped ESLint and root TypeScript including tests.
Security negative control: disable receipt RLS only inside the throwaway test
server and observe owner assertion fail (expected exit 1), then restore by cleanup.
No local receipt substitutes for exact-head required CI or independent review.

Kill gate (owner: this build agent): stop before merge if automatic dispatch needs
bypassing Main/privacy/claim identity or proof requires intercepted Moss responses,
production data or phone operations. Report the concrete blocker; preserve queue.

## Rulings ledger

- Ben's automatic-send clarification supersedes this task's prior explicit-Send
  premise. It does not enroll production hold or grant device/deployment access.
- Legacy queued/review receipts retain their policy; no migration mass-dispatch.
- Physical recovery acceptance is separate; #3565/#3584 stay open.
