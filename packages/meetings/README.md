# Meetings development checkpoint

Issue [#2981](https://github.com/motioneso/moss/issues/2981), approved
[design](../../docs/superpowers/specs/2026-10-03-meeting-companion.md) and
[plan](../../docs/superpowers/plans/2026-10-03-2981-meeting-companion.md).

## Native capture repair checkpoint (6 October 2026)

The current repair follows the [connection and reliability plan](../../docs/superpowers/plans/2026-10-06-2981-capture-reliability-and-connection.md).
It replaces the first Mac implementation's per-meeting preparation and approval with a shared
Trail Marker connection and one explicit **Start meeting**. The first implementation passed
synthetic checks but failed owner testing; the repair still needs exact-head hosted checks and
new owner-run OS/device acceptance. Windows shares the protocol but has no native host yet.

Moss may run on a remote, headless server without audio devices. Trail Marker runs on the
computer whose microphone/apps the person explicitly chooses. Device inventory and OS capture
stay on that computer. Browser and companion connect to the same public HTTPS Moss origin,
including its port; that may be a remote server. Use its final canonical origin: deployment
subpaths and HTTP redirects are unsupported. The server authorizes and processes uploaded clips;
it never opens a server microphone or output device. Browser-only capture is not implemented.

The supported static-web nginx proxy gives only `/api/meetings/capture/audio` a 5,200,000-byte
request limit and unbuffered HTTP/1.1 forwarding. A custom proxy must preserve that bound and
stream audio without request-body spooling or body logging. The proxy workflow exercises
fixed-length/chunked generated uploads and temporary-file negative controls; it does not validate
an operator's deployed proxy.

Connect Trail Marker once through the existing connection flow. New clients disclose meeting
recording in that approval; already paired clients require one clear capability upgrade. This
authorizes future explicit Starts, and does not start capture. In Meetings, choose the named
recorder and microphone with microphone-only, microphone + selected app, or microphone + computer
audio. Sources are remembered by device/microphone/app identity. Use Change when needed, then
Start meeting. There is no per-meeting Prepare, browser approval, or notice checkbox. First use
may prompt for the relevant OS permission. Granting permission alone cannot start a cancelled or
expired command. The browser stays where the person started; Trail Marker does not choose their
default browser for each meeting.

A second browser signed in as the same owner may explicitly control the named recorder. Opening
a meeting never changes the recording computer. Missing or ambiguous remembered sources require
selection; a missing selected app never widens to computer audio. Provider configuration stays in
Settings → AI providers. Connecting, page navigation, app restart or reconnect never creates a
recording Start.

The native host uses AUHAL microphone capture and macOS 14.2+ Core Audio process taps. Separate
tracks share a monotonic timeline and use bounded native-rate mono PCM chunks. Sample progression
establishes continuity; host-clock jitter and unchanged format notifications are not automatic
capture failures. The server wraps clips as WAV, requests timestamps from the configured
transcription route and writes retained transcript revisions. This is chunked transcription with
source labels, not speaker diarization. Real provider timestamp/latency acceptance remains needed.

System-audio permission stays `unknown` in inventory until there is trustworthy platform evidence;
tap creation alone is not permission proof. Native controls show Waiting for output audio until
the first valid callback, including a zero-valued callback. That establishes callback delivery,
not intelligible sound or chosen-app isolation. The owner trial must exercise a known test tone.

Pause closes inputs and sends no new audio. Stop closes inputs, fixes the cutoff and permits only
pre-cutoff finalization, bounded to 60 seconds. The single native recorder waits for that bounded
finalization before another meeting starts. Browser controls distinguish requested commands from
native acknowledgement, and remain available while navigating the meeting list or another Moss
module. The native menu-bar indicator has local Pause/Stop controls. Recording duration follows
acknowledged capture time; connectivity and transcription delay have separate status.

Each track retains at most 2,097,152 Float32 samples (8 MiB), with a process limit of 16 retained
rings (128 MiB of sample storage, plus bounded metadata/request buffers), and a maximum age of
60 seconds. The sample limit is shorter at higher rates:
about 43.7 seconds at 48 kHz. The connection lease permits at most 30 seconds without successful
authorization refresh. Whichever bound is reached first applies. Retryable chunk failures use
bounded backoff and the same identity; a terminal transcription failure records a gap and releases
that chunk without pausing healthy inputs. Sources receive fair independent upload scheduling.
Exhausted bounds pause visibly. There is no audio disk spool or crash-recovery archive, and no
promise of arbitrary offline recording. Safe diagnostic reason/stage/status fields omit raw
provider errors, audio, transcript text and credentials.

Recording authority is separate from Trail Marker's legacy identity credential. The shared
connection requires an independently stored recording-capability proof, current owner/device
capability revision and an ephemeral native connection verifier. Existing paired devices receive
no recording capability from migration. Browser approval is cookie-only and origin checked.
An explicit Start binds the current browser session, meeting, exact device/connection and sources;
only that native connection can claim the short-lived grant. Native creates the per-meeting secret
in memory and the server stores only its hash. Lost-response retries preserve identity. Revocation,
logout, expiry, reconnect and stale callbacks are fenced; reapproval does not revive old grants.
The legacy credential alone cannot upload audio or control a meeting.

Computer capture excludes native Moss processes. Unrelated process-list notifications do not
invalidate a verified exclusion set; changes affecting that set or output device are rechecked
and may pause capture. Inability to establish safe host-process exclusion disables computer mode.
This does not promise exclusion of a future Moss web player inside a shared browser. Selected-app
capture keeps its verified process scope and requires explicit Resume after that scope changes.
Teams/Zoom, device changes, actual isolation, permission timing, cleanup, latency and CPU still need
hardware testing.

The existing notes, History, transcript evidence, Ask Moss, reviewed Tasks, summaries and private
export flows remain independent of recording. Exports include retained capture/gap metadata but
exclude credentials, proofs, verifiers and browser-session IDs. Summaries warn about retained gaps.
Development and CI use generated fixtures; no provider credential or OS permission was activated.

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
- `GET` / `PUT /api/meetings/preferences`: `{ defaultCaptureMode, rememberedSource? }`. The mode
  is `microphone-only`, `selected-app`, `computer-audio`, or `null`. An explicitly chosen source
  stores device ID, microphone UID and, for selected-app mode, stable application identity.
  Reading preferences never creates a default or silently substitutes another source.

Titles are at most 240 UTF-8 bytes; notes at most 64,000 UTF-8 bytes. Draft titles are immutable
at this checkpoint. A stored draft is not evidence that capture occurred. Migration 0273 defines
the records and receipts; 0274 separately grants owner-policy-governed draft deletion.

Meetings is optional but default-enabled, as required by the repository's deny-only built-in
module model. Existing module controls can disable it. This does not start any recording.

## History API

- `POST /api/meetings/history/search`: `{ query?, filter?, limit?, before? }` returns
  lightweight meeting metadata and an actual next-page cursor. The default limit is 30, maximum 50.
- `GET /api/meetings/history/:id`: reauthorizes a selected meeting independently of the loaded page;
  absent and inaccessible identities return the same 404.

Search matches all words across current title, personal notes and current transcript segments,
before pagination. It excludes old corrections, generated output and independent copies. Up to
16 normalized words, 256 UTF-16 characters and 512 UTF-8 bytes are accepted; punctuation-only
searches return no matches. Search text stays in the POST body and signed-in query memory, not
URLs or persistent browser storage. Both endpoints set `Cache-Control: no-store`.

History supports all states, retained transcripts, needs review, saved versions and notes without
a transcript. The table and selection rail show retained-text spans, summary state, candidate
review counts and separate vault write/index receipts. These do not establish native recording,
continuous coverage, current Task contents or a fresh filesystem/index check. Mobile selection
has an explicit Back to results action; review navigation preserves the session's search.

Migration 0280 maintains a current-segment search projection in the existing transcript transaction.
Its explicitly declared, checksummed first-party sidecar backfills metadata from original TEXT JSON
inside the migration transaction; it preserves original payloads and UTF-16 segment identities.
The History sidecar restores FORCE RLS before returning; the canonical runner commits the
SQL and sidecar together, or rolls the transaction back on failure.
External module installation remains SQL-only. Isolated CI integration and real History UI tests
are required on the final commit before treating this slice as verified. Use only the supported
isolated gate described below for database checks.

## Transcript storage API

Migration 0275 adds append-only transcript batch receipts owned by the meeting. Deleting the
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
model. Generate stays disabled while the configured summary route is unavailable or its
availability cannot be checked. Refresh summaries rechecks safe configuration metadata without
reading credentials or contacting a provider; existing saved summaries remain readable.
Generation resolves the configured active API-key model with both `summarization` and
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

## Migration numbering

Account-export migration 0283 adds only owner-scoped worker SELECT access to the eight exported
Meetings tables. It grants no writes or cross-owner access. The account archive retains the
original transcript/output JSON text and all stored revisions, including inactive output versions;
it excludes derived History search projections. Disabled-module data remains exportable. Chat,
capture preferences and accepted Tasks continue through their existing export sections. Building
an archive does not invoke a model or regenerate content.

The unmerged Meetings sequence was renumbered from 0260–0267 to 0273–0280 in original order
before deployment, avoiding current main and the now-merged migrations at 0271/0272.
The owner confirmed that the reachable persistent development and production databases had no
Meetings migrations applied. Earlier branch references to “applied” describe disposable CI
runs, not persistent deployment. Historical checkpoint results keep their original commit and
numbering; they are not verification of this newly numbered tree.

The SQL bytes are unchanged except for History's required adjacent sidecar declaration, now
`0280_meeting_history.backfill.mjs`. Before persistent deployment, the sidecar's frozen header
was corrected to 0280; backfill sidecars are excluded from Prettier and ESLint so future formatter
changes cannot rewrite applied checksums. Applied main migrations are untouched. Do not reuse a
disposable database carrying an earlier sidecar checksum or the old sequence, edit an applied
ledger, or run these renames as a live database repair. Fresh exact-commit CI and UI proof remain
required. The historical unpublished device-authorization candidate remains excluded. The new capture
protocol described above uses migration 0284 for owner-bound links, grants and metadata receipts.

## Local verification

Use a separate checkout/worktree if another agent is editing your local tree. Read the
repository's `shared-checkout` and `verify-gate` skills. Use the pinned pnpm version and run
`pnpm install --frozen-lockfile`.

Focused database-free checks (expected exit 0):

```sh
node_modules/.bin/vitest run tests/unit/meeting-transcript.test.ts tests/unit/meeting-output-runtime.test.ts tests/unit/meeting-outputs-fixture.test.ts tests/unit/meeting-summary-web.test.tsx tests/unit/meeting-export.test.ts
pnpm verify:static
```

The current `scripts/run-gate.sh` includes the per-run server isolation from #2989/#2991:
it creates a fresh pgvector container and port, points the gate at that server, and removes the
container on completion, failure or handled interruption. Read `verify-gate` for the supported
launch/wait procedure and failure handling. Never run DB-backed commands directly or point a gate
at a persistent development or production database. Running the gate requires Docker and the
pinned dependencies; this source-only review did not run a local DB gate.

### Isolated real UI acceptance

The current GitHub-hosted workflows allocate fresh `ubuntu-latest` jobs. Each integration shard
starts its own Compose pgvector server and uses `if: always()` cleanup with `down -v`. The Meetings
workflow's outer gate server is likewise job-local, and the UAT provisioner starts separate
uniquely named `uat-*` Compose projects with private Postgres containers/volumes. Its teardown
removes project-scoped model fixtures, calls `down -v`, and checks for leaked containers, volumes
and networks. The workflow also stops the outer gate and removes its Compose volumes. The same supported gate wrapper now gives local runs their own outer Postgres server;
the UAT provisioner continues to isolate each spec stack. Seed containers use main’s #3013 guard, which checks all five
database URLs against their owned Compose Postgres service. The wrapper no longer forwards outer
gate markers into seed containers; it keeps the existing stack seed-confirmation flag.

Use the supported wrapper for the Meetings acceptance entry point:

```sh
scripts/run-gate.sh start --gate test:uat:2981-meetings
scripts/run-gate.sh wait --follow
```

The underlying `test:uat:2981-meetings` command runs `tests/uat/run-meetings-uat.ts`, which includes
`2981-meeting-drafts.uat.spec.ts`, `2981-meeting-chat.uat.spec.ts`,
`2981-meeting-outputs.uat.spec.ts`, `2981-meeting-history.uat.spec.ts` and
`2981-meeting-capture.uat.spec.ts`.
The dedicated wrapper selects an absent host-login file in a fresh
temporary directory; it never needs real provider credentials, host chat login, audio or a user's
vault. The chat/summary tests disclose local third-party HTTP stand-ins while exercising Moss's
real UI, APIs and services without intercepting Moss responses. Trace, screenshots and video are
off; evidence uses executable assertions and bounded text.

Draft/review checks measure tab-list and panel geometry at desktop and phone widths, confirm
the shell is the sole main landmark, retain multiline notes without a misleading record count,
disable summary generation with no configured model, and clear a successfully deleted History
selection. History checks also measure the gap before the next numbered section.

The output UAT covers Review → Generate → exact source evidence → explicit Task review and
acceptance, retry/regeneration deduplication, independent Task edits, immutable manual summary
versions, explicit create-only private saves, separate write/index receipts, repeated-save
stability, the required-Notes boundary, and independent copies surviving meeting deletion.
Notes cannot be disabled through module settings. The defensive `meeting_export_unavailable`
copy is component-tested; this UAT does not claim to trigger a missing required Notes service.
Settings → Prepare export → Download verifies the real worker-built archive contains all eight
Meetings collections, retained note revisions, transcript text, generated/manual versions,
accepted-Task references and vault receipts. Vault assertions use public
`VaultContext` operations. Real APIs clean up meeting/configuration fixtures; the provisioner
removes the isolated DB and volumes, including deliberately surviving synthetic Task/note copies.
This is the implemented acceptance path, not a claim of a passing live run. Exact-commit results
and remaining blockers for this capture slice belong on [PR #3056](https://github.com/motioneso/moss/pull/3056).

### Credential-free regression groups

The same supported `test:uat:2981-meetings` gate entry accepts the closed
`MOSS_MEETING_UAT_GROUP` enum below. Omission selects `meetings`; an empty/unknown group fails
before provisioning rather than falling back to all tests. Run these DB-backed groups only
through the supported isolated gate.

- `meetings`: draft/review/sign-out (3 tests), meeting chat (1), summary/Task/private and account
  exports (1), History (1), generated-audio capture/ASR/transcript/control (1).
- `chat`: private drawer #1089/#1090 (2), attachments #1133 (2 active, 1 fixme), runtime context
  (2 active, 2 fixmes), assistant naming (4).
- `runtime`: module install/restart (1), vault ownership #1217 (1), install grant #1311
  (1 active, 1 fixme), Today masthead #1112 (2).
- `model-fixtures`: Activity history #2956 (1), shadow-delete refusal #2911 (1), retired shadow-purge
  queue #2911 (1), classifier shadow (1), shadow report (1).

For example, the hosted `chat` matrix job sets `MOSS_MEETING_UAT_GROUP=chat` and invokes the same
`scripts/run-gate.sh start --gate test:uat:2981-meetings` / `wait --follow` sequence. Each of the
four hosted jobs has a 30-minute cap and its own disposable outer Postgres server. Each builds one
job-tagged image, then uses the provisioner's existing `JARVIS_UAT_BUILD=0` option to reuse that
image while still creating/tearing down a separate UAT stack for every spec. The three regression
matrix jobs do not cancel each other on failure. They retain bounded textual outcomes, not trace,
screenshot or video artifacts. The wrapper overrides any inherited host-auth location with an
absent temporary file and clears inherited real-chat readiness. No real provider login is used.
Module installation may still download the public Finance module; that is not provider proof.

The source groups define **27 active tests and 4 pre-existing fixmes**, not 31 passing assertions.
The retired #2889 activity spec is replaced by #2956, preserving the one-test slot. The assembled
main reconciliation and new migration numbering require a fresh run; older pass counts are historical.
Attachments do not prove a model read the file; runtime-context does not prove the model's refusal
or page-error resolution; install-grant does not prove model-driven Task dispatch. Scripted shadow
delete proves refusal/retention, not the real-model approval round trip. The private-drawer test
uses the scripted backend and delays/continues actual requests; it does not replace responses.
The trigger map's old advisory note for that spec is stale: both private-drawer tests are active
and the changed chat UI already makes the spec blocking. The separate advisory #1520 spec remains
an unconditional fixme and contributes no live assertion.

Four additional blocking trigger targets still require an explicitly authorized real provider:
`1909-sports-public-source-completion`, `notes-default-retrieval`, `notes-path-recheck`, and
`workshop-chat-handover` (all `.uat.spec.ts`). They are excluded from these credential-free groups;
a run that skips them is not passing live proof. Sports also needs actual public-publisher access.
Do not mark those gates complete or infer visual/layout/keyboard proof from these functional tests.

## Owner-run real-provider validation

The bounded `test:uat:2981-real-providers` script selects exactly the four blocking specs above.
It uses the existing real-provider harness; it is intentionally separate from credential-free CI.
The owner/operator must control this launch and authentication step. The harness automatically
copies the operator's existing signed-in Codex login into each disposable test stack, installs
and logs in its CLI, and makes real provider requests using an eligible economy-tier chat model.
This can consume the account's usage. Sports also accesses real public publishers and requires
an available JSON-capable model. This is not a generic API-key-provider test entry point.

Do not upload a login file to an agent or CI, disclose its bytes, create a new credential for this
PR, or put secrets in command arguments. Do not fabricate `JARVIS_UAT_REAL_CHAT_CONFIGURED` or
other readiness/authorization markers. If existing authorized login/runtime/network access is
unavailable, report the affected gates as not run. Read the pinned checkout's `verify-gate` skill,
use a separate worktree and fresh disposable servers, and launch only through its supported wrapper:

```sh
scripts/run-gate.sh start --gate test:uat:2981-real-providers
scripts/run-gate.sh wait --follow
```

The script disables Playwright trace, screenshot and video capture. It does not alter the
harness's existing authentication behavior, per-spec provisioning or cleanup. Never point these
commands at development/production databases or substitute a bare UAT command. Use the wrapper's
sentinel and actual exit status; do not pipe it through a command that hides failure.

Record the exact commit, clean/dirty fingerprint, toolchain, isolated server identity, executed
spec names, individual outcomes and teardown result without credentials/private connection data.
The required outcome is **four executed tests passing, with zero skips**. A zero runner exit code
with skipped tests is incomplete proof, not a pass of these gates. The generic runner stops on
the first failed spec, so later specs may be not run. Return failures and unrun targets explicitly;
only separately approved PR publication can add the final live-proof comment.

## Remaining release proof

Database tests cover owner/admin isolation, idempotency, concurrent notes, rollback and cascading
receipts. The transcript suite includes a rollback-only protection-removal probe: it verifies a disposable
`jarvis_gate_`/`jarvis_test_` database, disables only the transcript table's RLS inside a
transaction, verifies runtime role/actor, requires the same owner assertion to detect its
synthetic leaked row, rolls back, then rechecks RLS and owner isolation. This must pass in CI;
it has not run in the Docker-free cloud workspace. Earlier draft-table negative proof remains
separate. Current DB proof must come from the supported isolated gate or GitHub-hosted CI jobs
described above; required CI and real-UI evidence must still match the final commit.
The preceding draft/transcript/chat/output checkpoint is verified at `bee892ce` by
[CI](https://github.com/motioneso/moss/actions/runs/37180058593) and
[credential-free UI UAT](https://github.com/motioneso/moss/actions/runs/37180058600): 24 active tests
passed and four pre-existing fixmes were skipped. That evidence predates this History slice and
must not be reused as its verification. The additional History test and migration fixtures need
fresh exact-commit results. Neither checkpoint establishes native capture or real-provider proof.
The meeting-chat UAT uses a disclosed local HTTP provider stand-in to inspect real outbound requests,
not real provider credentials or rewritten Moss responses. Chat cleanup uses a bounded database
function; direct runtime deletion remains unavailable and thread surfaces are immutable. The
cleanup integration suite exercises the actual route and rollback-only protection-removal probes.

The Linux checks cannot prove macOS/Windows audio routes, permissions, device release, Teams/Zoom
compatibility, real-provider handling, diarization, native live/post-meeting capture or capture latency.
These remain separate implementation and live-proof requirements before the meeting recorder is
ready. Do not use real workplace audio before its separate policy and provider authorization.
