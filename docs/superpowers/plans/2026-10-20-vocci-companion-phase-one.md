# Vocci companion phase one: imported meeting analysis

Approved spec: [Vocci companion](../specs/2026-10-20-vocci-companion-meetings-chat.md).
Task: [#3553](https://github.com/motioneso/moss/issues/3553). Ben approved on 2026-10-20.

## Current seams

- Import transcription and completion commit atomically in
  `packages/meetings/src/recording-import-service.ts:196`; no summary trigger exists.
- `packages/meetings/src/stop-summary-repository.ts:77` persists automatic intent;
  admission at line 153 requires a live grant. Import completion must instead
  validate a retained, completed import belonging to the same owner and meeting.
- `packages/meetings/src/output-service.ts:88` reserves a stable request before
  provider dispatch and replays saved/failed/pending receipts. Do not resubmit
  ambiguous provider work. Existing Generate summary starts an explicit new attempt.
- `packages/meetings/src/output-routes.ts:62` already exposes automatic summary state;
  the existing Meetings output UI supports waiting, failure and explicit generation.
- `packages/module-registry/src/index.ts:3035` runs the automatic-summary worker;
  `recording-import-runtime.ts:22` supplies transactional scheduling to imports.
- `packages/meetings/sql/0292_meeting_minimal.sql:21` has owner-scoped automatic
  intents. Add import provenance to this table, preserving existing capture behavior.

## Decisions and boundaries

1. Extend the existing automatic intent with nullable recording import provenance.
   Add a new module migration, never edit an applied migration. Enforce exactly one
   of grant/import provenance, and bind import, meeting and owner with a foreign key.
   Old imports are not backfilled. No capture grant is fabricated.
2. At transcript completion, snapshot the summary preference/template and reserve
   one automatic intent. Schedule its metadata-only job in that transaction.
   Optional queue failure records analysis failure without losing the transcript.
3. Admission validates completed import provenance, preferences, current output,
   meaningful final transcript and template. Reuse the existing reserved output
   generation, validation, evidence and review/Add task controls. Persist fixed
   revision input before dispatch. Duplicate jobs cannot generate another revision.
4. Preserve existing capture admission/finalization behavior and deadlines. Imported
   intents may wait through an outage; already-dispatched requests use the existing
   bounded interruption receipt. Deletion cascades provenance and queued work no-ops.
5. Update app-map behavior, migration declaration and account export for provenance.

Determinism: status renders from persisted records. Models have two jobs only:
transcribe audio, and produce validated meeting analysis from transcript evidence.
Meeting content cannot inject a host-chat instruction; actions require existing
review and Add task acceptance. No new prompt guidance or model-controlled UI state.

## Verification

Behavior tests in `tests/integration/meeting-recording-imports.test.ts`:

- completion creates one import-bound summary intent/job; transcription replay does
  not add another; disabling automatic summaries skips generation;
- configured template is retained, silence skips, changed preferences are respected;
- queue failure preserves completed transcript and exposes analysis failure;
- duplicate summary jobs reuse output receipt; provider failure does not retranscribe;
- deleted imports cannot dispatch; existing capture summary tests remain green;
- owner provenance cannot cross users; account export retains its metadata.

Run through `scripts/run-gate.sh start --gate test:recording-imports`, then
`scripts/run-gate.sh wait --follow` (expected exit 0). Run required lint, format,
file size and root typecheck, then the full isolated gate (expected exit 0).
Observe a real import in an isolated dev instance through Meetings history and its
output UI; record assertions for transcript, summary and reviewable actions on PR.
No screenshot evidence or fake network responses.

Kill gate: if the real imported transcript cannot reach the existing evidence and
summary/review UI, stop layering later phases; this agent diagnoses the seam and
Ben decides any product-scope change. Phase one needs live proof before deeper
phase implementation. Missing hardware input is reported as unverified, not passed.

## Observed verification, 2026-10-20

The isolated live UI proof passed (`test:recording-live`, exit 0), with a retained
real ring capture, CPU Whisper base transcription and real Claude inference via a
disclosed proof-only OpenAI-compatible transport. Signup and provider setup used
the real UI; the supported uploader submitted the original recording. The proof
opened its transcript and generated summary through Meetings history and the
Summary tab, preserved the 13,000 ms bookmark, and replayed the upload without
changing the import, meeting or single output revision. No task candidates arose
from this recording, so this run does not demonstrate accepting a suggested task.
No response interception or screenshot evidence was used.

The harness now starts the canonical worker process as well as the API: import
transcription is API-owned, while automatic analysis runs in the normal worker.
It cleans up the worker, API, claimed port, temporary vault and gate container.

Focused verification passed 27 import integration tests, 15 existing summary
admission tests, and 16 manifest/account-export unit tests. Removing the composite
import provenance foreign key in a throwaway gate database caused exactly the two
provenance assertions to fail; restoring it passed. The first full gate exposed
two outdated manifest/export expectations, now corrected. A pre-existing Skills
browser test matched two headings; its selector now names the page heading, and
both tests in that file pass. Full foundation and current-head CI must still pass;
these focused results do not substitute for them.

Live log: `vocci_companion_design-20261020-170338.log`, exit 0. Private browser
artifacts retain assertions and diagnostics outside the public repository.

## Later approved slices and architecture findings

Next: explicit versioned voice requests into Main; resumable meeting-length files;
companion setup/status; independent live streaming investigation. These remain open
on #3553, not finished by phase one.

Independent critic verified that chat has neither a durable admission queue nor an
execution-id input. `chat-session-manager.ts:194` supplies a busy guard, and
`chat-session-turn.ts:155` can act before best-effort live-turn persistence. A new
Chat-owned receipt must commit queued/dispatching before actions, pin Main with a
stable turn identity, defer while busy and recover completed output. An ambiguous
dispatched request must never automatically requeue. A warm drawer may be another
or private chat; do not use resumeThread, which stops active work. Extend the pinned
thread machinery after acquiring the same busy guard. Meetings accesses only a
public Chat API through the composition root. These are implementation seams for
the next plan, not permission to inject module turns into host chat.
