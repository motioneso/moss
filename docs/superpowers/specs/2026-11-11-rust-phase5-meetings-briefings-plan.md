# Rust Phase 5: Meetings, Backtrack and Briefings port plan

Part of https://github.com/motioneso/moss/issues/4027. This is a planning document. It builds
nothing. It follows the rules in `2026-11-06-rust-port-plan.md` (Phase 5) and
`2026-11-07-rust-module-packages-and-registry-design.md` (sections 5 and 7), and uses
`2026-11-11-rust-phase5-memory-plan.md` and `2026-11-11-rust-phase5-email-connectors-plan.md` as
its pattern.

Every claim about the old TypeScript app was read from the files named below. Anything marked
**Guess** is my inference and needs checking before a builder relies on it. Anything marked
**Open** is a question with a named owner.

## 1. Summary

- Three legacy packages are in scope. **Meetings** (`packages/meetings`, about 22,500 lines, 17 SQL
  files, 22 owned tables) keeps recordings, transcripts, notes, summaries and the links to
  recording devices. **Backtrack** (`packages/backtrack`, about 1,900 lines, one SQL file, 3 tables)
  keeps screen history sent by the Mac companion. **Briefings** (`packages/briefings`, about 8,700
  lines, 6 SQL files, 2 tables) writes the morning briefing, the evening review and the weekly
  review that Today shows.
- **Recommendation.** Port them as three packages, in this order of risk. Briefings first in the
  parts list after the shared pieces, because Today depends on it. Meetings next. Backtrack last
  because it only matters once Memory's search index exists. All three are packages from the
  registry. Meetings and Backtrack run work that needs the host (audio decoding, model calls, the
  companion login), so those pieces stay in the host behind ports, as the registry design's rule 3
  requires (no network or threads in a package).
- **Two model jobs exist today and neither is a hardcoded provider.** Meetings asks the user's
  configured speech-to-text route to turn audio into text, and asks the user's default chat model
  to write a structured summary. Briefings asks the user's default chat model to write the
  briefing prose. The Rust platform already has the three capabilities by name (`Transcription`,
  `Summarization`, `Json`, in `rust-spike/platform/routing/src/lib.rs:7-17`). The module host has
  no port for them yet (section 4.2). That gap is the main new platform work.
- **Three things the legacy code does not have are not built here.** Sensitive meetings (the app
  password lock) is a spec only. Nothing in `packages/meetings/src` reads a sensitivity field
  (checked with a search for "sensitive"). The meeting-summary slices 4 and 5 stay paused. The
  "any recording" design is partly built (type, title and side are stored in
  `recording-metadata.ts`); the filing into Notes and Memory is the part to confirm (section 3.7).
- **The Mac recorder app and the Android ring app do not change.** They speak the same HTTP API
  (port plan section 3.7, line 414). Rust must answer their exact routes, status codes and error
  shapes, so the parity checks replay recorded requests from the old app.
- **Pairing a device is not in Rust yet.** The routes `/api/companion/pair`, `/heartbeat`,
  `/ring-session` and the ring credential resolver (`apps/api/src/companion-routes.ts`,
  `ring-recording-auth.ts`) have no Rust counterpart (a search of `rust-spike/shell`, `platform`
  and `module-host` finds none). Meetings and Backtrack uploads cannot be proven end to end until
  that exists. **Open**, owner Ben: confirm that device pairing is its own part of the Rust server
  work, not a Meetings part. This plan assumes it is and lists it as a dependency (part 7).
- The work splits into 22 parts (section 6). No part needs a new
  crate (the Android app sends a validated WAV, and Backtrack reuses Memory's embedding service). Two parts need hardware or a
  real account, so they need Ben (section 4.3).

## 2. What the legacy modules do

### 2.1 Meetings home and the meeting page

The person sees a Meetings page (route `/meetings`, nav order 36) with a table of recordings (title,
date, length, attendees, type), search over titles, notes and transcripts, a type filter, and an
Add recording entry for a pasted transcript (the form takes only title, type, time and transcript text; there is no audio upload by hand). A meeting opens to a
transcript beside personal notes. New meetings start as "Untitled meeting". When a summary is
current its first sentence becomes the title. The person can rename, edit notes (saved with a
version check), delete (confirmed, takes linked chats with it), and open a History view.

Files. `packages/meetings/src/web/` (`meetings-page.tsx`, `meeting-record.tsx`,
`meeting-transcript.tsx`, `meeting-title.tsx`, `meeting-history.tsx`, `manual-entry.tsx`,
`capture-panel.tsx`, `capture-session.ts`, `capture-status.ts`, `use-meeting-notes.ts`),
`styles.css`, `client.ts`, `capture-client.ts`. Specs: `2026-10-06-meetings-minimal-design.md`,
`2026-10-27-meetings-home-and-page-redesign.md` (home, with the table and "Coming up" strip),
`2026-10-26-meetings-any-recording-design.md`.

### 2.2 Recording, by three paths

1. **Mac recorder (Trail Marker).** The person links the Mac once. Pressing Start in Moss binds
   one meeting, one device and chosen sources to a short-lived grant. The Mac sends bounded audio
   clips. The server wraps them as WAV, asks the speech route for timestamps, and writes transcript
   revisions. Pause, resume and stop are commands the browser sends and the Mac acknowledges.
   Files. `capture-service.ts` (986 lines), `capture-connection-service.ts`,
   `capture-routes.ts`, `capture-domain.ts`, `capture-repository.ts`,
   `capture-connection-repository.ts`, `capture-maintenance.ts`, `capture-transcriber.ts`,
   `capture-transcript-sources.ts`, `recording-window-service.ts`,
   `recording-transcription-window.ts`, `preferences.ts`, SQL 0284, 0288, 0295.
2. **Ring recordings (Android delivery app, "Vocci").** The Android app signs in with a ring
   credential that only works on the receiver routes. It uploads completed recordings in resumable
   pieces (create, put piece, finalize), or as an import, or as a voice request (a short spoken
   command that Moss admits into Chat, where it is sent automatically when the person enabled voice commands, or held as ready-to-send when it needs confirmation). Files. `recording-import-*.ts`,
   `recording-upload-*.ts`, `recording-voice-*.ts`, `recording-audio-validation.ts`,
   `recording-metadata.ts`, `recording-upload-manifest.ts`, `recording-bundle.ts`,
   `apps/api/src/ring-recording-auth.ts`, `apps/vocci-delivery` (Android app, untouched), SQL
   0325, 0326, 0328, 0329, 0335. Specs `2026-10-19-vocci-completed-recording-delivery.md`,
   `2026-10-20-vocci-automatic-delivery.md`.
3. **By hand.** A pasted or typed transcript (`manual-entry-service.ts`, route
   `POST /api/meetings/manual-transcripts`), or an uploaded audio file that Moss transcribes.

### 2.3 Transcripts and History

Transcripts are append-only batches with immutable revisions, per-segment identity and exact
character ranges that citations point at. Corrections never move old citations. History search
matches all words across title, notes and current transcript segments before paging
(`transcript.ts`, `transcript-batch.ts`, `transcript-repository.ts`, `transcript-retrieval.ts`,
`transcript-routes.ts`, `history-repository.ts`, `history-routes.ts`, `history-projection.ts`,
SQL 0275 and 0280 with its JavaScript backfill). Stated limits: 4,096 batches, 20,000 segment
revisions and 32 MiB per meeting, 500 segments and 100,000 characters per read.

### 2.4 Summaries, action suggestions and exports

Generate is explicit (or automatic on stop, when the person's setting is on). The model returns
a structured result (overview, decisions, open questions, suggested actions, warnings, and the
recording reading: type, title, side, ideas). Every claim must cite an exact transcript range. A
check refuses a result whose citations do not match the retained text. Summaries are immutable
versions, can be edited by hand, and go stale when the transcript changes. Suggested actions are
proposals. The person reviews each one, titles it, and accepts it into Tasks. Save to private
notes copies one version into the person's notes, create-only. Long meetings are cut into pieces
with a running summary (`2026-10-29-long-meeting-summaries-design.md`). Files.
`output-service.ts`, `output-repository.ts`, `output-validation.ts`, `output-guidance.ts`,
`output-chunks.ts`, `output-routes.ts`, `stop-summary-*.ts`, `instruction-scan.ts`,
`export-*.ts`, `export-port.ts`, `action-presentations.ts`, SQL 0278, 0279, 0326, 0352.

### 2.5 Ask about this meeting

Chat gets a meeting surface. Each question reads the latest authorized transcript (at most 8
whole segments and 12,000 characters, ranked by relevance), cites exact ranges, and is buffered
until access is rechecked. This lives in the chat module (`packages/chat`, `chat-targets.ts` in
Meetings, `packages/shared/src/meeting-chat-api.ts`) and ports with Chat, not here (section 3.7).

### 2.6 Backtrack

A Mac sends screen history batches. The person sees a status (days kept, stored size, last
received), a pause switch, and delete (last hour, today, a day, all). A job embeds new segments
into Memory's search index. An hourly job applies retention. Files. `packages/backtrack/src/`
(`routes.ts`, `repository.ts`, `jobs.ts`, `chunking.ts`, `settings/index.tsx`,
`deletion-range.ts`, `data-lifecycle.ts`), ingest route in `apps/api/src/companion-routes.ts`
(`resolveBacktrackState`, 422 `backtrack_clock`), SQL 0282.

### 2.7 Briefings

A briefing is a definition (type morning, evening or weekly review, cadence manual, daily or
weekly, a schedule, a choice of sources) plus runs. A run gathers the person's tasks, calendar,
email commitments, chat of the day, news, sports and weather through each owning module's public
tool, wraps outside text in a labelled untrusted block, asks the default chat model for prose,
and stores the text with source labels, gaps and structured action rows. If no model is set up
or the model fails, a fixed fallback text is stored. A scheduled run notifies once, with no
content. Today shows the latest run, the action rows, email catch-up, and the day-plan handoff to
Calendar. Chat can re-run a briefing and read its status.

Files. `packages/briefings/src/` (`compose.ts`, `compose-shared.ts`, `compose-evening.ts`,
`morning-inputs.ts`, `morning-day.ts`, `morning-order.ts`, `evening-lenses.ts`, `signals.ts`,
`email-evidence.ts`, `action-rows.ts`, `plan-context.ts`, `plan-reconcile.ts`, `plan-prose.ts`,
`priority-consumer.ts`, `external-contributions.ts`, `trust-boundary.ts`, `fallback.ts`,
`freshness.ts`, `jobs.ts`, `schedule.ts`, `run-queue.ts`, `run-status.ts`, `run-deadline.ts`,
`repository.ts`, `routes.ts`, `tools.ts`, `feedback-*.ts`, `manifest.ts`), SQL 0015, 0026, 0085,
0116, 0124, 0237. Web. `apps/web/src/today/` (`morning-briefing.tsx`, `evening-mode.tsx`,
`briefing-action-rows.tsx`, `today-email-refresh.tsx`, `day-plan-review-controller.ts`),
`apps/web/src/briefings/briefing-settings-model.ts`. Specs
`2026-09-10-morning-briefing-flow.md`, `2026-09-10-today-briefings-design.md`,
`2026-07-02-evening-briefing-redesign.md`, `2026-06-20-briefings-prompt-injection-hardening.md`,
`2026-09-29-briefing-rerun-from-chat.md`.

## 3. Parity checklist

### 3.1 Meetings routes

Every route in `packages/meetings/src/manifest.ts` and the two declaration files. Each keeps its
permission (`meetings.read` or `meetings.write`) and its chat class (read, write, destructive,
or blocked with the stated reason).

| Group              | Routes                                                                                                                                                                                                                                                                                          | Part  |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| Records and notes  | `GET/POST /api/meetings/records`, `GET/DELETE /records/:id`, `PUT /records/:id/title`, `PUT /records/:id/notes`                                                                                                                                                                                 | 1     |
| Preferences        | `GET/PUT /api/meetings/preferences`                                                                                                                                                                                                                                                             | 1     |
| Transcript         | `POST/GET /records/:id/transcript`, `GET /records/:id/transcript/evidence`                                                                                                                                                                                                                      | 2     |
| History            | `POST /api/meetings/history/search`, `GET /history/:id` (both `Cache-Control: no-store`)                                                                                                                                                                                                        | 2     |
| Recording identity | `GET/PUT /api/meetings/recording-types`, `GET /records/:id/recording`, `PUT /records/:id/recording/type`                                                                                                                                                                                        | 3     |
| By hand            | `POST /api/meetings/manual-transcripts`                                                                                                                                                                                                                                                         | 3     |
| Outputs            | `GET /output-availability`, `GET/POST/PUT /records/:id/outputs`, `GET /records/:id/outputs/:version`                                                                                                                                                                                            | 4     |
| Action review      | `POST /records/:id/actions/:candidateId/review` (blocked in chat: self authority)                                                                                                                                                                                                               | 5     |
| Exports            | `GET/POST /records/:id/exports`                                                                                                                                                                                                                                                                 | 5     |
| Receivers (ring)   | `POST /recording-uploads`, `GET /recording-uploads/:id`, `PUT /recording-uploads/:id/:kind/:index`, `POST /recording-uploads/:id/finalize`, `POST/GET /recording-imports[/:id]`, `POST /voice-enablement[/:id/disable]`, `POST/GET /voice-recordings[/:id]`, `POST /voice-recordings/:id/retry` | 8     |
| Mac capture        | `POST /capture/connection`, `/capture/commands`, `/capture/claim`, `/capture/status`, `/capture/control`, `/capture/audio`, `GET /capture/devices`, `GET /records/:id/capture`, `POST /records/:id/capture/start`, `/capture/control`, `/capture/cancel-start`                                  | 9, 10 |
| Retired            | The old recording-attempt and recording-decision routes return 410                                                                                                                                                                                                                              | 9     |

Public companion routes Meetings depends on (`/api/companion/*`, `/api/chat/voice-requests/:id`)
are listed in part 7.

### 3.1a Backtrack, Briefings and companion routes

| Module / part | Method and path                                                                                                                               | Permission         | Chat class                           |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------ |
| Backtrack, 13 | `GET /api/backtrack/status`                                                                                                                   | as manifest        | read                                 |
| Backtrack, 13 | `PUT /api/backtrack/preferences`                                                                                                              | as manifest        | blocked (data scope consent)         |
| Backtrack, 13 | `DELETE /api/backtrack/segments`                                                                                                              | `backtrack.manage` | destructive, own approval text       |
| Backtrack, 13 | `POST /api/companion/backtrack` (Mac ingest)                                                                                                  | device credential  | not a chat route; needs part 7       |
| Briefings, 16 | `GET/POST /api/briefings/definitions`                                                                                                         | view, create       | blocked (external effect)            |
| Briefings, 16 | `PATCH /api/briefings/definitions/:id`                                                                                                        | update             | blocked (external effect)            |
| Briefings, 17 | `POST /api/briefings/definitions/:id/run`                                                                                                     | `briefings.run`    | blocked (external effect)            |
| Briefings, 17 | `GET .../definitions/:id/runs`, `.../runs/:runId`                                                                                             | view               | blocked (reads reconcile and upsert) |
| Companion, 7  | `POST /api/companion/protocol` (discovery)                                                                                                    | none, rate limited | not a chat route                     |
| Companion, 7  | `/pair`, `/pair/attempt`, `/pair/decide`, `/pair/redeem`, `/pair/cancel`, `/heartbeat`, `/device`, `/logout`, `/ring-session`, `/ring-logout` | as legacy          | not chat routes                      |

Source: `packages/backtrack/src/manifest.ts:134-160`, `packages/briefings/src/manifest.ts:218-270`,
`apps/api/src/companion-routes.ts:200-511`. Permission names for the "as manifest" rows are read
from the manifest in part 13.

### 3.2 Background jobs

| Queue                                                                   | What it does                                                                          | Payload today                                                                         | Part |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---- |
| `meetings.stop-summary`                                                 | Runs the automatic summary after Stop or an import, with early enqueue and a due time | `{actorUserId, resourceId, idempotencyKey}`                                           | 4    |
| `meetings.recording-import`                                             | `transcribe`, `abandoned` and `purge` steps for ring imports                          | `{actorUserId, resourceId, kind, windowStartMs?}`                                     | 8    |
| `meetings.recording-notice`                                             | Tells the person a recording started or stopped                                       | metadata only                                                                         | 10   |
| Capture maintenance (apps/api `meeting-capture-maintenance-runtime.ts`) | Expires grants, stale starts, orphan chunks                                           | **Guess** metadata only                                                               | 9    |
| `backtrack.index`                                                       | Embeds up to 200 segments per job into Memory                                         | segment ids only                                                                      | 14   |
| `backtrack.upkeep`                                                      | Hourly at minute 7, retention sweep                                                   | `{kind}`                                                                              | 13   |
| `briefings.run` (name from `BRIEFINGS_RUN_QUEUE`)                       | Writes one run. Manual or cron. Mints the run id at fire time                         | `{actorUserId, definitionId, runKind, briefingType, briefingRunId?, idempotencyKey?}` | 17   |
| Day-plan apply dispatch (owned by Calendar)                             | Metadata-only apply of a reserved automatic plan                                      | `{planId, operationId, batchKey}`                                                     | 20   |

### 3.3 Settings and preferences

- **Meetings settings** (`web/meeting-settings-form.tsx`, `preferences.ts`): capture mode
  (microphone only, selected app, computer audio), remembered source, transcript language,
  best-effort vocabulary, automatic summary on stop (default on), summary style (general,
  one-to-one, project review, interview), Mac link status and Unlink, recording types list,
  voice enablement for the ring, cleanup folder. App map ids in `features.ts` and the two
  declaration files (about 40 feature ids, listed in section 3.8).
- **Backtrack settings** (`settings/index.tsx`): recording switch (pauses every Mac), Kept and
  Delete, empty states, day memory.
- **Briefings settings** (`briefing-settings-model.ts`, `calendar/settings`): per definition type,
  cadence, schedule time, selected tools, inclusion switches per source, evening choices.

### 3.4 Screens

Every one is a front-end design part (section 6). Listed so none is lost.

- Meetings home table, Coming up strip, search, type filter, Add recording (`meetings-page.tsx`).
- Meeting page with transcript, notes, summary, actions review, exports, retry states.
- History view and selection rail. Manual entry. Recording panel and status pill.
- Settings sections for Meetings, Backtrack, Briefings.
- Today's morning briefing, evening mode, action rows, email catch-up and plan review
  (these are Today screens and may belong to the Today part of the port, **Open**, owner Ben).

### 3.5 Chat tools and chat actions

- Meetings declares no assistant tools of its own. Chat reaches it through the `chat` metadata on
  the routes (read, write with presentation, destructive with target), see section 3.1. The
  presentations (`action-presentations.ts`, 750 lines) draw every approval card from the stored
  record, never the model.
- Briefings declares two tools, `briefings.rerun` (action family `briefing_runs`, default tier
  ask each time) and `briefings.getRunStatus` (read, outside content). Backtrack routes: status is
  readable, preferences are blocked in chat (data scope consent), delete is destructive with an
  approval presentation.

### 3.6 Public API other modules call

| Provider  | Consumer                 | Call                                                                                                                                                                                                                                                                  | Today                                             |
| --------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Meetings  | Chat                     | transcript snapshot and evidence, meeting surface access check, `MeetingDeletionPort`                                                                                                                                                                                 | `transcript-repository.ts`, `deletion-service.ts` |
| Meetings  | Notes (through the host) | `MeetingPrivateExportPort` (inspect, create or inspect, queue index)                                                                                                                                                                                                  | `export-port.ts`                                  |
| Meetings  | Memory                   | recording facts, receipts, proposals (`packages/memory/src/recording-facts.ts`)                                                                                                                                                                                       | see memory plan part 9                            |
| Meetings  | Calendar                 | meeting link to a calendar event, "Coming up" list                                                                                                                                                                                                                    | `context-pack-port.ts`, spec 2026-10-27           |
| Meetings  | Tasks                    | accept a suggested action as a task                                                                                                                                                                                                                                   | `output-service.ts`                               |
| Meetings  | Account export           | `collectMeetingsExportSection`                                                                                                                                                                                                                                        | `data-lifecycle.ts`                               |
| Backtrack | Memory                   | chunk write and delete by source path (`screen`, `backtrack/<id>`)                                                                                                                                                                                                    | `jobs.ts`                                         |
| Briefings | Today (web)              | list definitions, list runs, one run, create, patch, run now                                                                                                                                                                                                          | `api/client.ts` lines 1660-1695                   |
| Briefings | Calendar                 | day-plan auto step (`packages/calendar/src/day-plan-auto.ts`)                                                                                                                                                                                                         | calendar report part 27                           |
| Briefings | Chat                     | rerun and run status tools; `chat.listTodaysTurns` read by Briefings                                                                                                                                                                                                  | `tools.ts`, `compose.ts`                          |
| Others    | Briefings                | tools `calendar.listVisibleEvents`, `email.listVisibleMessages`, `commitments.listVisible`, `commitments.threadJudgements`, `sports.followedFactsToday`, `news.topHeadlinesToday`, priority model, source context (`packages/connectors/src/source-context/types.ts`) | `compose.ts`, `morning-inputs.ts`                 |
| Others    | Briefings                | external module contributions (up to 20 items, headline 200, title 200, detail 500 characters)                                                                                                                                                                        | `external-contributions.ts`                       |

In Rust each of these becomes a declared `provides` and `requires` pair in the manifests, as the
Calendar package does (`modules/calendar/moss.module.json`, keys `requires` and `provides`).

### 3.7 What is not in these modules but touches them

- **Chat's meeting surface** ports with Chat. Meetings part 12 supplies only the read API and the
  deletion callback, tested against the old caller's shapes.
- **Filing a recording into Notes and Memory** (any-recording design). Meetings writes summaries to
  Notes through its export port, and the host queues the Memory index. Whether the type, title and
  personal or work side are filled by the same model call that writes the summary is stated in the
  design (`2026-10-26-meetings-any-recording-design.md`, Classification). The filing step itself
  (finding the person's own method) is **Open**: read `output-service.ts` in part 11 to see how
  much is built before sizing it.
- **Sensitive meetings** (lock with the app password). Spec only, not built. Not ported. The
  Rust schema leaves room for it because the plan keeps the SQL files byte for byte.

### 3.8 Errors and degraded outcomes

Each error code below stays word for word because the apps and tests read it.

- Meetings. `meeting_not_found`, `meeting_notes_conflict`, `meeting_invalid_input`,
  `meeting_transcript_limit` (whole batch refused, never partly kept),
  `meeting_history_{access_denied,invalid_input,rate_limited,unavailable}`,
  `meeting_output_{busy,generation_failed,input_too_large,interrupted,invalid_input,limit,module_unavailable,provider_failed,queue_unavailable,request_conflict,route_changed,route_unavailable,runner_offline,isolation_failed,evidence_unavailable,claude_subscription_unsupported,...}`,
  `meeting_action_{match_review_required,review_conflict,tasks_unavailable,unavailable}`,
  `meeting_export_{content_conflict,invalid_input,request_conflict,unavailable}`,
  `meeting_index_delayed`, `meeting_cleanup_{conflict,pending}`, `meeting_chat_unsupported`,
  `meeting_capture_{busy,conflict,interrupted,invalid_input,limit,processing_failed,processing_outcome,processing_unavailable,rate_limited,source_unavailable,unavailable}`.
  Also `meeting_output_subscription_isolation_unavailable` (`meeting-output-runtime.ts:615`).
  Ring recovery outcomes keep their status and text: 409 `Recording upload incomplete`
  (`recording-upload-service.ts:194`) and 409 `Ring inventory snapshot changed`
  (`recording-voice-enablement.ts:67`). The `...` in the output list stands for codes the text
  search did not show. Part 4 and part 8 each start by listing every code in their files into a
  table in the part's report, and a test fails if the Rust enum differs from that table.
- Summary degraded outcomes: no model set up (Generate disabled, "refresh summaries" rechecks
  safe metadata without reading credentials), prompt over 65,536 UTF-8 bytes (refused before
  dispatch for a short meeting, cut into pieces for a long one), Codex subscription
  (unsupported message, no fallback), Claude subscription (constrained CLI path, isolation checked first), model route changed mid-request (refused).
- Briefings. 404 `Briefing definition not found`, 409 on a second run while one is going, 202
  with `{jobId, runId}`, `already_running`, `no_briefing`, run states pending, ready, failed,
  not found, run deadline error (rolled back, fixed label logged), fallback text when no model or
  credential, "source gap" rows when a source fails, `briefing_evidence_invalid` (block dropped,
  run kept).
- Backtrack. 422 `backtrack_clock` when `sentAt` is too far from receipt, paused state returns
  without storing.

## 4. Recording, transcription and summaries

### 4.1 How they work today

- **Speech to text** goes through `packages/ai/src/configured-transcription.ts` and the HTTP
  adapter `adapters/http-api-transcription.ts`. The person configures one transcription route in
  the AI settings. The route is chosen before capture starts (`expectedModelRoute`) and a changed
  route fails closed (`route-changed`). The call sends a bounded WAV clip and asks for segment
  timestamps. Errors carry a reason, a stage, a retry flag, a retry delay and an HTTP status and
  never the audio, text or credential. The action code is `transcribe.meeting` or
  `transcribe.voice_note`. Source labels are microphone or output. This is chunked transcription,
  not speaker identification (README, native capture section).
- **Summaries** resolve "the same effective default model as chat, honoring administrator locks
  and user overrides" and need the `summarization` and `json` capabilities. API key models and a
  constrained Claude subscription make one bounded structured attempt, with no tools and no search
  and no fallback model. The whole reply must be one JSON value. Every claim binds to exact
  segment revisions and character ranges. The prompt is escaped, limited to 65,536 UTF-8 bytes,
  and built from at most 500 whole segments and 100,000 characters. Long meetings use the piece
  method (design 2026-10-29): piece one alone, each later piece with the running summary, same
  checker on every piece, one retry per piece.
- **Briefing prose** uses `generateChat` with the user's default model, a trusted instruction
  block built only from constants, and outside text inside a labelled block (`trust-boundary.ts`,
  static isolation test). Output tokens are capped (economy 1,024, morning 2,000).
- **Memory index for Backtrack** uses Memory's embedding provider (section 4.2 of the memory plan).

### 4.2 How Rust does it

Decision. **Add two host ports, `transcribe` and `structured`, beside the existing `embed` and
`generate`, and route both through the platform routing table.** The package asks for a
capability and the host picks the person's configured model. No provider or model name is in the
package or the host code. The credential is a brokered secret that never reaches a package.

1. `transcribe` (new). Input is a bounded audio clip (bytes held by the host, never in a job
   payload), language, a bounded prompt (vocabulary), and the expected route. Output is segments
   with start and end offsets. It uses `Capability::Transcription` and the existing
   `transcription_binding` in `rust-spike/platform/routing/src/lib.rs:75,224-229`. It writes one
   activity row per call with model, outcome and size, never text. The failure shape keeps the
   legacy reason, stage and retry fields. **Guess** that the host trait in
   `rust-spike/module-host/src/ai.rs:14-20` (today only `generate` and `embed`) gains these two
   methods rather than a second trait. The brief for part 4 checks that.
2. `structured` (new, or `generate` with a `json` flag, **Guess**). Input is a prompt of at most
   65,536 bytes, an output schema name, a token cap, and the capability set (`Summarization`,
   `Json`). Output is one JSON value or a refusal with a stable code. No tools, no search, no
   fallback model. The package validates the value (shape, lengths, citations) and never trusts it.
3. **Audio stays in the host.** Wrapping Mac PCM
   as WAV, and validating the WAV the Android app supplies (it normalizes decoder output itself, `recording-audio-validation.ts:49`; bundles carry separate `.opus`, `.json` and `.wav` members, `recording-bundle.ts:62`) (`recording-audio-validation.ts`) are host work, because a
   WebAssembly package may not run threads or large buffers (**Guess** on the size limit, the
   registry design's section 7 sets the real ones). The host does not decode Opus, so no new crate is needed.
4. **Subscription models** (a CLI the person signed in to). Legacy probes CLI readiness and, when ready, runs structured generation through a constrained CLI adapter (`meeting-output-runtime.ts:607,624`); Codex subscription is unsupported and a missing isolation gives `meeting_output_subscription_isolation_unavailable`. Rust keeps all three outcomes. Whether the host can run the constrained CLI adapter is open (**Guess** that it needs a host port beyond `structured`); part 4 settles it first, with isolation and readiness proofs, and returns the same unsupported codes where no supported transport exists.
5. **Briefings call `structured` or `generate` once per run**, with the same trusted block and
   fallback text. The fallback text and every UI line come from the stored run, not from a model.
6. **Scheduling.** The Rust job platform stores cron schedules with a timezone
   (`rust-spike/platform/jobs/src/lib.rs:162` `schedule`, `:284`). **Guess** that a package can
   declare one through its manifest the way it declares a queue. Part 16 checks this first and, if
   not, adds the declaration to the host.

### 4.3 What CI proves and what needs Ben

CI proves, with fixed fakes:

- A fake speech server that returns repeatable segments for known audio bytes, and a fake chat
  server that returns canned JSON. They log the exact text and audio hash received, test only.
- Transcript storage, limits, citations, history search, summary validation and chunked
  summaries against canned model output, including every refusal (wrong shape, citation outside
  the retained text, oversize prompt, route changed).
- Link and grant security with fixed clocks: expiry, revocation, stale callbacks, replay, cross
  owner. Each guard is seen failing with it removed (section 5).
- Audio validation of the supplied WAV on fixture files made from the old code.
- Briefing composition with canned module answers, schedule alignment across time zones with a
  fixed clock, the once-only notification, the deadline rollback.
- Replay of recorded requests from the Mac and Android apps against the Rust routes.

Needs hardware or a real account (so needs Ben, never claimed by CI):

- Mac microphone and system audio capture, OS permission prompts, device changes, Teams and Zoom
  behaviour, latency, CPU. (The old README says the same.)
- The ring and the Android app delivering a real recording.
- A real speech provider's timestamp quality and a real chat model's summary and briefing quality.
- Speaker identification (not built today either).
- The meeting link from a second device on the home network or tailnet (the standing Rust
  requirement), and signing in over HTTPS from it.
- A real signed-in subscription model, if Ben wants that path at all.

## 5. Keeping private data private

1. **Owner-only.** Meetings and Backtrack tables all have owner-only row level security
   (`owner_user_id = app.current_actor_user_id()` in the legacy SQL, **Guess** for tables I did not
   open, to be read in part 1 and part 13). Briefings is different. Definitions and runs follow
   0026 owner-or-share (a definition can be shared with grant levels view and manage) and 0085
   narrows run reads back to owner only. The Rust package keeps the SQL byte for byte. No
   `BYPASSRLS`, no admin path. Tests use two people and each policy is seen failing when removed.
   The existing rollback-only protection-removal probe on the transcript table is rebuilt in Rust.
2. **No leaks.** Transcript text, notes, audio, summaries, screen text, briefing text, queries and
   vectors never go into logs, errors, activity rows, job payloads or chat as anything but the
   result the person's own request asked for. A planted marker is searched in every response, log
   line, job payload and activity row, and the test is first seen failing with the protection off.
   Capture diagnostics keep only reason, stage and status fields.
3. **Metadata-only jobs.** Payloads are ids, a kind, a key and small parameters. The legacy check
   (`assertMetadataOnlyPayload`, `isBriefingRunPayloadMetadataOnly`) rejects other keys. A test
   inspects stored job rows, including the capture and import jobs. Audio rides in a host store,
   not a payload.
4. **Link security (Mac recorder).** Carried over exactly, from the README and
   `scripts/check-meeting-*`. Recording authority is separate from the old device identity
   credential. Linking never starts capture. An explicit Start binds the browser session, the
   meeting, the exact device and connection, and the sources. Only that connection can claim the
   short-lived grant. The Mac makes a per-meeting secret in memory and the server stores only its
   hash. The server never opens a microphone. Revocation, logout, expiry, reconnect and stale
   callbacks are fenced, and reapproval does not revive old grants. Initial approval is
   cookie-only and origin checked. The legacy credential alone cannot upload audio. Limits stay:
   30 seconds without authorization refresh, 8 MiB and 16 rings per process, an audio request cap of
   5,200,000 bytes, bounded stop finalization of 60 seconds, start rate limits.
   The four negative-control scripts (`scripts/check-meeting-link-negative-controls.py`,
   `check-meeting-resume-negative-controls.py`, `check-meeting-single-link-controls.py`,
   `check-meeting-source-negative-controls.py`, plus `test-meeting-link-revocation-controls.ts`
   and `test-meeting-capture-proxy.py`) mutate the code and require a named assertion to fail.
   Rust ports each as a mutation-based control, same names, run in CI (parts 9 and 10).
5. **Ring credential reach.** The ring credential works only on the receiver routes and the one
   voice-request read (`ring-recording-auth.ts`). Anything else is 403, and an act-as header is
   refused. Rust keeps that allow-list as a test with a route that must fail.
6. **Instructions in recordings are evidence.** Recorded and outside text is escaped, never an
   action. A model suggestion never authorizes anything (`instruction-scan.ts`). Accepting a task
   needs the person's reviewed title and explicit confirmation. Chat classes stay as in 3.1.
7. **Sensitive meetings.** Not built in legacy, so not in this port. When that spec is built, it
   needs its own plan. Until then no part may add partial lock behaviour.
8. **Deletion.** Deleting a meeting first fences it and cleans its managed Notes and Memory
   contributions, then removes its notes, transcript, summaries, candidates, export
   receipts and linked chats in one transaction, and reports the same 204 for missing and
   inaccessible. Accepted tasks and saved note copies survive, as legacy says. Account export
   includes the 18 meeting collections (`packages/meetings/src/data-lifecycle.ts:13`: recording types and metadata, manual entries, voice enablements, imports, records, note writes, transcript batches, output requests and artifacts, action candidates, export receipts and requests, stop summaries, and the four capture tables) with original JSON text and all revisions. Backtrack
   delete ranges and the retention sweep remove segments and their index chunks.
9. **Secrets.** Speech and chat credentials stay brokered in the host. The ring credential,
   capability proofs, verifiers and browser session ids never appear in exports or logs.

**The determinism boundary.** Every confirmation, status line, error, progress state and approval
card on the Meetings, Backtrack and Briefings screens is drawn from the stored record. A module
never injects turns into chat. The model has these jobs only. Meetings. (1) Transcribe audio, (2)
write the structured summary and recording reading. Briefings. (3) Write the briefing prose
(guidance well under 150 words per type, kept as constants). Model values that cross into user
data (a title, a type, a side, a suggested action) pass four guards. A schema with field
descriptions, a prompt contract with one worked example, a boundary validator (including the
citation check), and per-item before and after acceptance by the person.

## 6. Build parts

Sizes are by complexity (S, M, L), not time. Each part is one builder window. Order is dependency
order. Parts marked **Screen** need a front-end design discussion and mockups agreed with Ben first,
per `CLAUDE.md` ("Design the front end before building a module"). Some approved mockups already
exist for Meetings (`docs/superpowers/specs/mockups/meetings-redesign`, the any-recording set), but
those were agreed for the TypeScript app. **Recommendation.** Re-show them for the Rust screens
and get a yes before building. Each part with a screen ends with a live check on the real Rust
server over HTTPS and from a second device. Each part writes into a report
(`2026-11-xx-rust-phase5-meetings-report.md` or the briefings equivalent) and lists what is not
proven. Each names its e2e proof.

### 6.1 Parts

| #   | Track     | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Size | Proof                                                                                                                                                                                      |
| --- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Meetings  | Package skeleton `modules/meetings` (manifest, `core-legacy` ledger, the 22 owned tables, SQL hashes, the two JavaScript backfills handled through the host's backfill support, CHANGELOG, icons). Records, notes with version check, title, delete, preferences routes. Owner-only tests. No screens.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | M    | Two-person isolation, each policy seen failing when removed; notes conflict and key-reuse behaviour from the old tests; native and WebAssembly builds; live route calls on the Rust server |
| 2   | Meetings  | Transcript store and History: batches, revisions, segment identity, limits, evidence ranges, search projection, `no-store` headers. Replaces the 0280 backfill with the host backfill.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | L    | Old-code fixtures read by Rust and the reverse; limits refuse the whole batch; protection-removal probe; marker leak test                                                                  |
| 3   | Meetings  | Recording identity and types, manual transcripts (paste only, as legacy) and the new host `transcribe` port with the fixed fake speech server, used by the ring and Mac parts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | M    | Fake server gets exact bytes, refusals, route-changed failure, no text in activity rows                                                                                                    |
| 4   | Meetings  | Structured model port and summaries: templates, escaped prompt, 65,536 byte cap, validation and citation check, immutable versions, stale marks, long-meeting pieces, `meetings.stop-summary` job, automatic summary on stop.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | L    | Canned model output through every refusal; piece method matches the design's examples; job payload inspection; no prompt or text in logs                                                   |
| 5   | Meetings  | Action review into Tasks (public API), private export through the Notes port, account export section with all 18 collections (a round trip must keep ready-import audio, both as verified chunk bytes with hashes in base64 and as a retained legacy bundle, `data-lifecycle.ts:62,77`), deletion service with the chat cleanup callback. Deletion fences the source, cleans its managed Notes recording blocks and Memory recording episodes and search documents, seals the cleanup, and only then deletes the meeting. Incomplete or conflicting cleanup refuses deletion (`deletion-service.ts:57`, `managed-deletion-runtime.ts:62`, `recording-contribution-cleanup.ts:199`, `recording-memory-cleanup.ts:78`). Independent exported note copies survive. Tests assert no searchable recording content remains in Notes or Memory, and that a cleanup conflict keeps the meeting. Needs the Notes and Memory cleanup ports (**Guess** that they do not exist in Rust yet; confirm first). | M    | Task acceptance and regeneration deduplication; create-only export conflicts; survivors after delete; export archive holds all collections                                                 |
| 6   | Meetings  | Recording reading and filing (type, title, side, ideas), context pack from Calendar, People and Memory, Memory recording-facts hook. Confirm what is built first (section 3.7).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | M    | Fixed-model reading tests; work never writes to personal and the reverse; low confidence surfaces a chat message                                                                           |
| 7   | Server    | **Dependency, not Meetings.** Companion device pairing, heartbeat, ring credential issue and the receiver allow-list in the Rust server. Owner Ben decides where this lives (section 1).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | L    | Replay of recorded app requests; the 403 allow-list test with a route that must fail                                                                                                       |
| 8   | Meetings  | Ring receivers: resumable uploads, imports, voice enablement and voice recordings, audio validation of the supplied WAV (no Opus decoding), `meetings.recording-import` job. Voice requests keep the legacy Chat hand-off (automatic dispatch only when voice commands are enabled, confirmation gives ready-to-send, recovery as legacy); the Chat side waits for Chat to port, so part 8 stores and exposes them through a Chat port (**Guess** at its shape).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | L    | Fixture bundles from the old code; resume after a cut; hash and size limits (120 s, 1 MiB packet, 64 KiB sidecar, 8 MiB request); **needs Ben for a real ring**                            |
| 9   | Meetings  | Mac link: links, grants, receipts, connection, start, cancel-start, revocation, the 410 routes, maintenance job, start limits. Port the mutation controls.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | L    | The control scripts rebuilt in Rust, each guard seen failing when removed; fixed clock tests; replay of Trail Marker requests                                                              |
| 10  | Meetings  | Mac audio and control: audio route with its byte cap, chunk transcription windows, gaps, pause, resume and stop with the 60 second finalization, status, `meetings.recording-notice` job, capture completeness.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | L    | Generated-audio capture with the fake speech server; proxy test; **needs Ben for real hardware**                                                                                           |
| 11  | Meetings  | **Screen.** Meetings home, meeting page (transcript, notes, summary, actions, exports), manual entry, History view. Package screens and app map entries.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | L    | Live on the Rust server over HTTPS and from a second device; empty, loading and broken states; keyboard and phone width                                                                    |
| 12  | Meetings  | **Screen.** Meetings settings, recording panel and status, calendar link and Coming up. Meeting chat read API and the deletion callback for Chat (the surface itself ports with Chat).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | M    | Same live check; chat caller shapes replayed                                                                                                                                               |
| 13  | Backtrack | Package `modules/backtrack` (required, cannot be disabled, as legacy): 3 tables, status, preferences, delete ranges, ingest route with the clock check, hourly upkeep job, data lifecycle.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | M    | Pause stores nothing; `backtrack_clock` 422; retention sweep; two-person isolation; replay of Mac ingest                                                                                   |
| 14  | Backtrack | Index job: embeds segments through Memory's embedding service, chunk budget, `screen` source path. Needs Memory plan parts 1 and 5.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | S    | Fake embedding model; chunk bound holds for CJK text; delete removes chunks                                                                                                                |
| 15  | Backtrack | **Screen.** Settings section (switch, Kept, Delete, empty states).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | S    | Live check, second device                                                                                                                                                                  |
| 16  | Briefings | Package `modules/briefings`: 2 tables, owner-or-share policies, definitions and runs routes, serializers, schedule reconcile and timezone alignment (first check scheduling, section 4.2 point 6).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | M    | Two-person and share-level tests; schedule alignment across zones with a fixed clock; old route replay                                                                                     |
| 17  | Briefings | Run job: manual and scheduled, run id minted at fire time, same-day idempotency, deadline rollback, once-only metadata notification, fallback text, run status and queue read service. Composition is a stub returning the fallback.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | M    | Same-day skip does not re-notify; deadline rolls back; payload is metadata only                                                                                                            |
| 18  | Briefings | Gathering through public APIs: tasks, calendar, email commitments, chat of the day, priority, source context, external contributions with caps. Sources not yet ported give a visible source gap, as legacy does on failure.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | M    | Canned module answers; gap rows; cap truncation                                                                                                                                            |
| 19  | Briefings | Morning composition through the `structured` or `generate` port, trust boundary, caps, evidence capture, signals, ordering, action rows, email catch-up.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | L    | Static isolation test (trusted block has no interpolated outside value, seen failing when one is added); fixed-model output; no leaks                                                      |
| 20  | Briefings | Evening and weekly review composition, lenses, plan context, plan reconcile, day-plan auto step through Calendar's public API.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | L    | Canned inputs; the evening plan test from the old suite; apply payload metadata only                                                                                                       |
| 21  | Briefings | Chat tools `briefings.rerun` and `briefings.getRunStatus`, action family, feedback targets and verifier, approval presentation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | S    | Rerun while running returns `already_running`; no-model failure text                                                                                                                       |
| 22  | Briefings | **Screen.** Briefing settings and the Today briefing surfaces (morning, evening, action rows, catch-up, plan review) if Today does not already own them (**Open**, section 3.4). Then remainder: export, deletion, registry package, upgrade check on a copy of dev data, whole-module live pass with one real configured model.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | L    | Live Today check on a phone and desktop; upgrade from copy; **needs Ben for the real-model pass**                                                                                          |

Ordering. Parts 1, 2, 3, 4, 5, 6 run in order. Part 7 can run beside 1 to 6 and must land before
8, 9 and 13's live proof. Parts 8, 9 and 10 can run in parallel once 7 and 3 land. Parts 11 and
12 follow 5. Track B (13 to 15) needs part 7 and the Memory plan. Track R (16 to 22) can start
beside track M; part 19 needs the `structured` port from part 4, so do part 4 first or move that
port into its own small part if two builders run at once (**recommendation**).

### 6.2 Parts that need a new crate (Ben approves)

None. The Android app sends a validated WAV beside each Opus packet file, so the host needs no
decoder (`recording-audio-validation.ts:49`, `recording-import-service.ts:294`). Backtrack's index
part uses Memory's embedding service and adds nothing.

## 7. Kill gate and risks

**Kill gate for track M after part 5.** The old suite's fixtures (transcripts, summaries and their
citations, exports) read and write identically in Rust, and a real speech and chat model, set up by
Ben, produce a summary the person judges usable. Owner is Ben. A miss is a measurement that
re-plans parts 6 to 12, not a no-go for the port (the port plan treats kill gates as
measurements).

**Kill gate for track R after part 17.** A scheduled briefing fires at the owner's local time in
two zones and notifies once. Owner is Ben.

Risks.

- **Device pairing is a hidden dependency** (part 7). Without it, parts 8, 9 and 13 can only be
  proved against replayed requests, never against the real apps.
- **Hardware proof cannot come from CI.** Parts 8 and 10 are not "done" without Ben's device
  session. The honest status in between is code-complete, unverified.
- **Size.** Parts 4, 8, 9, 10, 19 and 20 are the widest. A builder may stop at a clean point and
  say so rather than compact twice. Part 9 is security work and should not be rushed to fit.
- **Dependence on modules not yet ported.** Briefings reads news, sports, weather, email and
  commitments. Until they land, those sources show a gap. Part 18 is re-proved as each arrives.
- **The model port shape** (4.2 points 1 and 2) is a guess. If the host trait cannot take audio
  bytes cleanly, part 3 re-shapes it and says so.
- **WebAssembly limits.** Transcript reads of 100,000 characters and history search over many
  meetings may miss the speed budget in a package. Part 2 measures it and moves the hot path to the
  native list if needed (rule 10 in the registry design), as the memory plan does.
- **Summary quality drift.** Fakes cannot show it. The real-model passes in parts 4 and 22 exist
  for this.

## 8. Not covered

- Workshop and Food (not ported, by Ben's ruling). Sensitive meetings and the meeting-summary
  slices 4 and 5 (paused). Any non-Rust work.
- Chat's own surfaces and the Today page itself (except where section 3.4 marks it **Open**).
- The People tab, Calendar's own screens, Memory's graph, and the companion apps themselves.
- Screen history review beyond the legacy Backtrack settings.
