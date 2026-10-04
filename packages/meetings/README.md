# Meetings development checkpoint

Issue [#2981](https://github.com/motioneso/moss/issues/2981), approved
[design](../../docs/superpowers/specs/2026-10-03-meeting-companion.md) and
[plan](../../docs/superpowers/plans/2026-10-03-2981-meeting-companion.md).

This package is not yet a meeting recorder. The current checkpoint contains:

- A package-owned `/meetings` screen for Setup, draft history and personal notes.
- Explicit capture-mode defaults; Start remains unavailable until native capture exists.
- Real draft creation, reopening, version-checked notes, conflict review and confirmed deletion.
- In-memory unsaved-note recovery across signed-in navigation; save before closing/signing out.
- Pure capture/lifecycle/send-eligibility rules for later native wiring.
- Authenticated text-only transcript ingestion, immutable revisions, bounded snapshots and evidence.
- Read-only transcript review with source labels, provisional status and revision navigation.
- Meeting questions in the existing chat drawer using the selected API-key model and exact evidence.

The AI-owned clip transcription API separately supports an explicit timestamp request and
cancellation. That adapter is not yet wired to meeting capture or a persisted meeting transcript.
There is no claimed streaming, speaker separation, summary, Tasks or vault-export
implementation in this checkpoint. Meeting questions are the bounded API-key-only stage below. Setup links to existing AI providers configuration and does
not present an unvalidated meeting profile as ready.

## Draft API

All routes use the existing general-session resolver and actor-scoped data context. They do not
start capture, contact a provider, or create/expand companion grants.

- `POST /api/meetings/records`: `{ requestKey, title }`; a UUID request key makes creation retryable.
- `GET /api/meetings/records`: optional `limit` (1–100), plus paired `beforeId` and
  `beforeCreatedAt` cursor fields.
- `GET /api/meetings/records/:id`: read the current draft and personal notes.
- `PUT /api/meetings/records/:id/notes`: `{ requestKey, expectedRevision, personalNotes }`.
  Notes start at revision zero. A stale version returns a conflict and current notes. Reusing a
  key with identical input returns the original saved snapshot, even after later edits; fetch
  the record again for its current version. Reusing a key with different input conflicts.
- `DELETE /api/meetings/records/:id`: permanently remove the owner's draft and cascading note
  receipts, transcript revisions and derived meeting-chat threads atomically. Repeated and inaccessible deletion requests return the same 204 response. The UI
  requires confirmation and explains the retained content and unsaved edits that will be lost.
- `GET` / `PUT /api/meetings/preferences`: `{ defaultCaptureMode }`, where the value is
  `microphone-only`, `selected-app`, `computer-audio`, or `null` to clear the explicit default.
  Reading preferences never creates a default, and choosing a mode alone does not save it.

Titles are at most 240 UTF-8 bytes; notes at most 64,000 UTF-8 bytes. Draft titles are immutable
at this checkpoint. A stored draft is not evidence that capture occurred. Migration 0260 defines
the records and receipts; 0261 separately grants owner-policy-governed draft deletion.

Meetings is optional but default-enabled, as required by the repository's deny-only built-in
module model. Existing module controls can disable it. This does not start any recording.

## Transcript storage API

Migration 0262 adds append-only transcript batch receipts owned by the meeting. Deleting the
meeting cascades transcript revisions and receipts. Runtime grants permit select/insert only;
forced owner RLS and a composite owner/meeting foreign key are declared. Database protection
removal proof is still required; these declarations alone are not live isolation evidence.

- `POST /api/meetings/records/:id/transcript` accepts `{ requestKey, expectedVersion, sources,
events, stopCutoffMs }` through the same general-session resolver as drafts. It accepts text,
  not audio. Supplied source metadata is not proof that native capture occurred.
- A successful response contains an immutable `{ version, transcriptRevision, cursor,
stopCutoffMs }` receipt. Exact retries return the original receipt, even after later writes.
  Reusing a key with different input or writing against a stale version returns 409.
- Sources identify microphone/output, label, epoch and confirmed interval. Existing bounds only
  extend monotonically; source identity is preserved. Stop's cutoff is immutable once set;
  sources/events beyond it are rejected. Late corrections within those bounds remain possible.
- `GET /api/meetings/records/:id/transcript?maxSegments=500&maxCharacters=100000` returns
  `{ snapshot, sources }`. Optional `transcriptRevision` pins history; optional `cutoffMs` can
  narrow but never enlarge server-retained bounds. Without it, the server resolves the bound.
  An absent/inaccessible/uninitialized transcript returns 404.
- `GET /api/meetings/records/:id/transcript/evidence` takes `segmentId`, `segmentRevision`,
  `startCharacter`, and `endCharacter` and returns `{ evidence: { segment, excerpt } }`.
  Exact UTF-16 ranges are end-exclusive; later corrections never redirect old citations.
- Public `MeetingTranscriptRepository.snapshot` and `.evidence` require `DataContextDb` and
  derive ownership from the authorized meeting. Callers must recheck authorization before
  releasing asynchronously generated answers. Snapshot retrieval is chronological, not
  relevance-ranked, and reports omitted segments and provisional text.

Limits: 4,096 batches, 20,000 accepted segment revisions and 32 MiB canonical input per meeting;
128 source intervals, 100 events and 512 KiB per batch. Two hours at ten-second chunks on two
sources requires 1,440 chunk events before revisions; streaming adapters must honor these bounds.
Limits reject the whole batch explicitly with `meeting_transcript_limit`; no text is silently
accepted then dropped. Future capture wiring must preserve rejected input within its retention
policy or record a visible gap. These are storage limits, not a measured native capture profile.
Aggregate size is checked before history is read; accepted history is reconstructed linearly.
Read snapshots are capped at 500 segments/100,000 characters and never cut a segment's text.

## Meeting questions checkpoint

Ask Moss selects one meeting in the existing chat drawer. Each request resolves the latest
owner-authorized transcript revision, cursor and cutoff. Relevance ranking examines all retained
latest segments before choosing at most eight whole segments and 12,000 characters. Coverage,
omitted segments and provisional text are visible. A segment larger than that budget is omitted;
if nothing fits, the request returns a size-limit error rather than an ungrounded answer.

The selected chat model, including administrator pins, is resolved before dispatch and rechecked
before release. This stage supports only active API-key models. CLI/subscription models receive
an actionable unsupported-capability error; there is no provider or model fallback. The direct
HTTP request declares no tools or native search and never launches a CLI engine. The entire reply
is buffered until authorization is rechecked. No partial meeting stream is exposed.

Each question uses the current transcript. Include context in follow-up questions: previous chat
answers are displayed in history but are not sent to the model. This is not yet full conversational
continuity. Recorded instructions remain escaped external evidence, never action authorization.
Meeting questions do not create Tasks, export notes, or feed general chat memory/automatic archives.

The existing chat surface encodes the complete meeting UUID without truncation. Stored answer
metadata pins the selected segment revisions and exact character ranges. Timestamp citations open
those ranges; corrections affect later questions, and deleted/unavailable evidence is not replaced
with newer text. Deleting a meeting uses a public Chat cleanup callback in the same actor-scoped
transaction; saved chat answers and their citations are deleted with its meeting data.

Shared contracts live in `packages/shared/src/meeting-chat-api.ts`. The existing `/api/chat/turn`
accepts `meetingContext: { meetingId, selectionId }` with its canonical meeting surface. History
and citation reads recheck meeting access; general engine seed, stream, switch and resume paths
cannot operate on that reserved surface. `GET /api/chat/meeting-context?surface=...` checks access.

## Local verification

Use a separate checkout/worktree if another agent is editing your local tree. Read the
repository's `shared-checkout` and `verify-gate` skills. Use the pinned pnpm version and run
`pnpm install --frozen-lockfile`.

Focused checks (expected exit 0):

```sh
pnpm test:unit tests/unit/meeting-transcript-storage.test.ts tests/unit/meeting-api-schema.test.ts tests/unit/meeting-lifecycle.test.ts tests/unit/meeting-transcript.test.ts tests/unit/meeting-record-routes.test.ts tests/unit/meeting-preferences-routes.test.ts tests/unit/meeting-manifest.test.ts tests/unit/meeting-web.test.tsx tests/unit/meeting-web-interaction.test.tsx tests/unit/ai-transcription-routes.test.ts tests/unit/ai-transcription-timestamps.test.ts
pnpm verify:static
```

Full isolated database gate (expected exit 0):

```sh
scripts/run-gate.sh start
scripts/run-gate.sh wait --follow
```

Real UI acceptance uses the existing UAT harness and its own disposable fixture, without
rewriting network responses. The dedicated Meetings wrapper points the harness at an absent
auth file in a fresh temporary directory, so this draft-only test does not read or copy the
host’s real chat login. Use this wrapper rather than invoking the general UAT command directly. Through the supported gate wrapper:

```sh
scripts/run-gate.sh start --gate test:uat:2981-meetings
scripts/run-gate.sh wait --follow
```

Do not hand-run database reset/migration/integration commands against the shared development
database. The cloud development workspace has no Docker/Postgres stack, so local DB/UAT commands
could not run there. Exact CI results, commits and remaining blockers are on PR #2982.

## Remaining release proof

Database tests cover owner/admin isolation, idempotency, concurrent notes, rollback and cascading
receipts. The transcript suite includes a rollback-only protection-removal probe: it verifies a disposable
`jarvis_gate_`/`jarvis_test_` database, disables only the transcript table's RLS inside a
transaction, verifies runtime role/actor, requires the same owner assertion to detect its
synthetic leaked row, rolls back, then rechecks RLS and owner isolation. This must pass in CI;
it has not run in the Docker-free cloud workspace. Earlier draft-table negative proof remains
separate. Run through `scripts/run-gate.sh start --gate test:integration`, then
`scripts/run-gate.sh wait --follow`; never invoke DB tests directly.
Draft-only real UI acceptance is verified at `468aaa8` by
[CI](https://github.com/motioneso/moss/actions/runs/37165385320) and
[UI UAT](https://github.com/motioneso/moss/actions/runs/37165385348). This does not verify the
new transcript storage/review and meeting-question slices. Their fresh CI, DB tests and real-path UAT remain pending. The meeting-chat UAT uses a disclosed local HTTP provider stand-in to inspect real outbound requests, not real provider credentials or rewritten Moss responses.

The Linux checks cannot prove macOS/Windows audio routes, permissions, device release, Teams/Zoom
compatibility, real-provider handling, diarization, native live/post-meeting capture or capture latency.
These remain separate implementation and live-proof requirements before the meeting recorder is
ready. Do not use real workplace audio before its separate policy and provider authorization.
