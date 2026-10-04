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
- Explicit generated/manual summary versions, source-grounded decisions and owner-reviewed Tasks.
- Explicit versioned, create-only copies in Moss private vault with separate write/index receipts.

The AI-owned clip transcription API separately supports an explicit timestamp request and
cancellation. That adapter is not yet wired to meeting capture or a persisted meeting transcript.
There is no claimed streaming, speaker separation or native recording implementation in this
checkpoint. Meeting questions and summaries are bounded API-key-only stages below. Setup links to
existing AI providers configuration and does not present an unvalidated meeting profile as ready.

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
  receipts, transcript revisions, summaries, action candidates, export receipts and derived
  meeting-chat threads atomically. Independently accepted Tasks and saved private vault copies
  survive deletion; their source evidence can become unavailable. Repeated and inaccessible
  deletion requests return the same 204 response. The UI
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

## Summary, Task review and private export checkpoint

Review offers explicit template selection and Generate; merely opening a meeting does not run a
model. Generation resolves the configured active API-key model with both `summarization` and
`json` capabilities, respecting the routing/pin contract. It makes one structured HTTP attempt,
without executable tools, native search, CLI engines or repair/fallback attempts. The model's
claims must bind to the retained input's exact meeting, revision and UTF-16 evidence ranges.
A proposal never authorizes an action.

The escaped structured prompt is limited to **65,536 UTF-8 bytes**, including guidance and JSON
encoding. The input snapshot is independently bounded to 500 whole segments/100,000 characters;
personal notes and escaping also consume the prompt budget. An oversized prompt is rejected
before model dispatch, not silently truncated. These are bounded retained-evidence summaries,
not proof of whole long-meeting coverage or of any particular model's summary quality.

Generated summaries and manual edits append immutable versions. Historical evidence remains
attached to its original version; source changes mark summaries stale. Exact repeated action
proposals reuse candidates, while possible nonexact overlaps require separate review. Acceptance
requires an owner-reviewed title and explicit owner acknowledgment in the UI. Owner/date phrases
are suggestions: relative dates are not automatically resolved, and this UI sets no Task due date.
Accepted Tasks are independent; regeneration does not overwrite subsequent Task edits.

Save to vault explicitly copies the selected artifact version into **Moss private vault**, owner
only. This stage is versioned and create-only: a later summary version creates a separate note,
not an in-place update or merge. Repeated saves reconcile identical bytes without creating another
copy; changed/removed destination content produces a conflict rather than an overwrite. The UI
shows an opaque note reference because there is no supported open-note URL for these exports.
Write receipts distinguish `saved` from indexing `queued`, `delayed` or `conflict`; queued is not
proof that content has been indexed. Failed/delayed indexing does not undo a completed private
write. Independent saved copies and accepted Tasks survive meeting deletion.

## Local verification

Use a separate checkout/worktree if another agent is editing your local tree. Read the
repository's `shared-checkout` and `verify-gate` skills. Use the pinned pnpm version and run
`pnpm install --frozen-lockfile`.

Focused database-free checks (expected exit 0):

```sh
node_modules/.bin/vitest run tests/unit/meeting-transcript.test.ts tests/unit/meeting-output-runtime.test.ts tests/unit/meeting-outputs-fixture.test.ts tests/unit/meeting-summary-web.test.tsx tests/unit/meeting-export.test.ts
pnpm verify:static
```

**Local database gates are withheld pending
[#2989](https://github.com/motioneso/moss/issues/2989).** Each DB gate must have its own disposable
Postgres server, share none with development or another gate, and clean up on every outcome.
The current `scripts/run-gate.sh` only creates a separate database on the configured existing
server (default `jarv1s-postgres`); that does not meet the new requirement. It also retains failed
gate databases. Do not launch local foundation, integration, migration, seed or UAT commands until
the supported per-run server wrapper and cleanup land. Do not bypass this by invoking DB commands
directly or by hand-building an alternative wrapper.

### CI-only real UI acceptance

The current GitHub-hosted workflows allocate fresh `ubuntu-latest` jobs. Each integration shard
starts its own Compose pgvector server and uses `if: always()` cleanup with `down -v`. The Meetings
workflow's outer gate server is likewise job-local, and the UAT provisioner starts separate
uniquely named `uat-*` Compose projects with private Postgres containers/volumes. Its teardown
removes project-scoped model fixtures, calls `down -v`, and checks for leaked containers, volumes
and networks. The workflow also stops the outer gate and removes its Compose volumes. This
job-level isolation does not make the current local shared-server wrapper safe and does not prove
#2989's future concurrent local-gate acceptance criteria.

After its job-local database startup, the existing Meetings workflow invokes:

```sh
scripts/run-gate.sh start --gate test:uat:2981-meetings
scripts/run-gate.sh wait --follow
```

The underlying `test:uat:2981-meetings` command runs `tests/uat/run-meetings-uat.ts`, which includes
`2981-meeting-drafts.uat.spec.ts`, `2981-meeting-chat.uat.spec.ts` and the new
`2981-meeting-outputs.uat.spec.ts`. These commands are documented for the CI workflow, **not for
local execution before #2989**. The dedicated wrapper selects an absent host-login file in a fresh
temporary directory; it never needs real provider credentials, host chat login, audio or a user's
vault. The chat/summary tests disclose local third-party HTTP stand-ins while exercising Moss's
real UI, APIs and services without intercepting Moss responses. Trace, screenshots and video are
off; evidence uses executable assertions and bounded text.

The output UAT covers Review → Generate → exact source evidence → explicit Task review and
acceptance, retry/regeneration deduplication, independent Task edits, immutable manual summary
versions, explicit create-only private saves, separate write/index receipts, repeated-save
stability and independent copies surviving meeting deletion. Vault assertions use public
`VaultContext` operations. Real APIs clean up meeting/configuration fixtures; the provisioner
removes the isolated DB and volumes, including deliberately surviving synthetic Task/note copies.
This is the implemented acceptance path, not a claim of a passing live run. Exact-commit results
and remaining blockers belong on [PR #2982](https://github.com/motioneso/moss/pull/2982).

## Remaining release proof

Database tests cover owner/admin isolation, idempotency, concurrent notes, rollback and cascading
receipts. The transcript suite includes a rollback-only protection-removal probe: it verifies a disposable
`jarvis_gate_`/`jarvis_test_` database, disables only the transcript table's RLS inside a
transaction, verifies runtime role/actor, requires the same owner assertion to detect its
synthetic leaked row, rolls back, then rechecks RLS and owner isolation. This must pass in CI;
it has not run in the Docker-free cloud workspace. Earlier draft-table negative proof remains
separate. Current DB proof must come from the isolated GitHub-hosted CI jobs described above;
local DB gates remain withheld until #2989 provides per-run server isolation and cleanup.
Draft-only real UI acceptance is verified at `468aaa8` by
[CI](https://github.com/motioneso/moss/actions/runs/37165385320) and
[UI UAT](https://github.com/motioneso/moss/actions/runs/37165385348). This does not verify the
new transcript storage/review, meeting-question or summary/Task/private-export slices.
Exact-commit CI, database and live-path results for those slices are recorded on [PR #2982](https://github.com/motioneso/moss/pull/2982).
The meeting-chat UAT uses a disclosed local HTTP provider stand-in to inspect real outbound requests,
not real provider credentials or rewritten Moss responses. Chat cleanup uses a bounded database
function; direct runtime deletion remains unavailable and thread surfaces are immutable. The
cleanup integration suite exercises the actual route and rollback-only protection-removal probes.

The Linux checks cannot prove macOS/Windows audio routes, permissions, device release, Teams/Zoom
compatibility, real-provider handling, diarization, native live/post-meeting capture or capture latency.
These remain separate implementation and live-proof requirements before the meeting recorder is
ready. Do not use real workplace audio before its separate policy and provider authorization.
