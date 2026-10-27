# Meetings manual audio and Calendar — Phase 3 refinement

Part of #3777. Refines the merged `2026-10-26-meetings-any-recording.md` plan and approved
`2026-10-26-meetings-any-recording-design.md` spec. The approved manual-entry and Calendar
mockups remain the UI contract. Work stays in `~/Jarv1s/.claude/worktrees/meetings-build`.
This is a draft for seam review, not implementation authorization or execution evidence.
Merge the plan PR before its product implementation; retain the earlier filing acceptance gate.

## Verified seams

| Capability                                           | Current evidence                                                                                                | Decision                                                                                              |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Manual transcript atomic creation and summary intent | `packages/meetings/src/manual-entry-service.ts:55`                                                              | Extract owning finalization for validated transcript segments; keep existing request replay behavior. |
| Manual screen draft and preserved choices            | `packages/meetings/src/web/manual-entry.tsx:18`                                                                 | Extend the approved screen with shared Tabs and the audio form; keep title/type ownership.            |
| Binary child route and bounded chunk admission       | `packages/meetings/src/recording-upload-routes.ts:14`                                                           | Reuse its route pattern, not its ring manifest or act-as policy.                                      |
| Ring source allocation                               | `packages/meetings/src/recording-upload-storage.ts:25`                                                          | Separate manual receipt/storage namespace; shared low-level Vault byte primitives only.               |
| Guarded configured ASR port                          | `packages/ai/src/configured-transcription.ts:50`, `:107`, `:157`                                                | Use availability/modelRoute and dispatch validator; clips must be self-describing bounded WAV.        |
| Real transcript checkpoint and summary commit        | `packages/meetings/src/recording-window-service.ts:122`                                                         | Reuse owning transcript ingest; each clip commits its receipt and next job together.                  |
| Provider retry and segment normalization             | `packages/meetings/src/recording-transcription-window.ts:125`                                                   | Reuse pure normalization where its bounds fit; do not invent another provider selector.               |
| Metadata initially omits imported source time        | `packages/meetings/src/recording-import-service.ts:157`, `packages/meetings/src/recording-upload-service.ts:86` | Populate timing from validated original source evidence, never upload insertion time.                 |
| Capture clock                                        | `packages/meetings/src/capture-domain.ts:45`                                                                    | Expose known capture origin/epochs through owning public timing service.                              |
| Bounded accessible Calendar query                    | `packages/calendar/src/repository.ts:83`, `:108`                                                                | Root adapter invokes public Calendar services/repository under the requesting actor.                  |
| Occurrence DTO                                       | `packages/calendar/src/serialize.ts:6`                                                                          | Keep cached event UUID and exact start/end, not title or recurring series identity.                   |
| Existing modal event detail                          | `apps/web/src/calendar/calendar-peek.tsx:12`                                                                    | Add ButtonLink using the existing shared Peek lifecycle.                                              |
| Runtime OS dependencies                              | `Dockerfile:80`, `infra/docker-compose.yml:128`, `:177`                                                         | Install general ffmpeg in runtime and both dev execution roles in the same PR.                        |

The shipped Playwright ffmpeg was executed and has no audio decoding. Bubblewrap installation
alone does not establish usable namespaces in the default deployment. This slice adds no host
security changes and makes no process-isolation claim. New decoder and general-audio lifecycle
contracts below are implementation work, not capabilities already supplied by ring capture.

## Scope and deterministic behavior

Two model jobs remain those already named by filing: recording interpretation and bounded filing
discovery. ASR uses the user's existing configured transcription capability. No extra generative
model chooses formats, timestamps, event matches, retry state or UI acknowledgements.
All progress/error/saved feedback comes from persisted receipts. Never inject a host chat turn.
The existing validated summary/fact boundaries remain unchanged. No model-supplied executable path.

## Manual admission and persisted state

Own new shared `meeting-manual-audio-api.ts`, Meetings `manual-audio-service.ts`,
`manual-audio-repository.ts`, `manual-audio-storage.ts`, `manual-audio-jobs.ts`,
`manual-audio-routes.ts`, owning SQL and public exports. Choose globally unused migrations at
implementation time. Register tables in catalog/export/delete, force owner RLS for app and worker,
and add declarations to the module app map and route policy fixture.

Public operations take AccessContext and are owner-only:

- `reserve(access, { requestKey, byteLength, sha256, title?, typeId?, recordedAt? })` returns upload
  ID, bounded chunk size and current receipt; same request/key and canonical input replays.
- `putChunk(access, uploadId, index, bytes)` verifies expected length/hash and idempotent bytes.
- `finalize(access, uploadId)` validates all source bytes and atomically queues decode intent.
- `status(access, uploadId)` returns persisted phase, completed clip count, failure code, and final
  meeting ID only when committed. No private content in logs or queue metadata.
- `retry(access, uploadId)` creates a fresh current lease/attempt while retaining committed clip
  receipts; `cancel(access, uploadId)` fences future publication and schedules bounded cleanup.

An upload receipt owns title/type/time choices, source checksum, chunk receipts, decoder version,
validated decoded sample count, modelRoute, current attempt/job/deadline and clip checkpoint.
Phases: uploading, queued, decoding, transcribing, complete, failed, cancelled. Status reconciles
missing/expired/exhausted accepted jobs using stored exact job ID and attempt lease, following the
filing plan's scoped lookup pattern; a process killed before catch cannot leave eternal progress.
A late lease cannot dispatch or publish, even if its old process is still running.

Start with fixed limits: 256 MiB source, 2 hours decoded audio, 1 MiB upload chunks, two active
uploads per owner and 512 MiB retained source allocation per owner. Reserve decoded storage plus
source allocation and the existing 100 MiB free-space floor before accepting decode. A canonical
16 kHz mono PCM16 recording needs at most 230,400,000 decoded bytes at this duration; count real
samples, not format metadata. Bound transcript to the existing transcript ledger limits and reject
explicitly rather than silently truncate. Check existing ledger limits before choosing clip count
and batching. Failed uploads expire after 24 hours; cancelled/complete source and decoded bytes
are purged once no active admitted reader remains. Retain non-content operation receipts for replay.

Store source/decoded files only through VaultContext APIs in a private manual-audio namespace.
Add the minimal Vault streaming/range helpers needed instead of raw feature-owned filesystem I/O.
Content identity and storage allocation are durable before acknowledgement. Retrying a lost response
never creates a second recording. Account/source cleanup fences admitted decode/transcription,
removes retained files and authority through public owning services. Add cleanup reconciliation for
crash windows before/after filesystem publication. Job payload contains only actor/resource/attempt
UUIDs and a bounded clip index; extend the metadata allowlist deliberately if an additional key is
necessary. Do not carry filename, transcript, audio, destination or credentials in pg-boss.

## Decoder boundary and deployment

Own `packages/meetings/src/manual-audio-decoder.ts` plus root dependency wiring. Invoke a fixed
installed binary through argv without a shell, URLs or user-selected executable/options. Use a trusted Vault-owned seekable input handle for containers requiring seeks; emit raw PCM
through stdout and construct canonical WAV clips in the owning service. The decoder receives only
that preopened handle, never an uploaded filename or user-selected path. Validate the descriptor
transport and protocol/format restrictions in the actual deployed ffmpeg build. Pipe-only stdin
does not support ordinary non-faststart M4A reliably. Supported container/codec families are WAV PCM, MP3, FLAC, Ogg Vorbis/Opus, WebM Opus and
M4A AAC/ALAC. Validate actual admitted content/demuxer, not MIME or suffix. Reject playlists,
concat/nested references and video-only content. Restrict input formats/protocols to the supported
families and the trusted descriptor transport; no user path input. Verify the installed ffmpeg build's actual flags
and negative cases before claiming that external references are refused.

Set one decoder thread, bounded probe/analyze work, 120-second wall deadline, bounded stderr and
strict stdout byte accounting. Terminate the child and await exit on limit/abort. Reject a source
that exceeds decoded sample limit rather than claiming a truncated file succeeded. Decode before
sending any ASR request. Never buffer the whole 256 MiB source/decoded output in API memory.
No unverified claim of sandboxing or protection against arbitrary native decoder vulnerabilities.
If this deployment cannot execute the bounded decoder, show a truthful unavailable state and keep
the live acceptance gate red until repaired; do not weaken host security automatically.

Add ffmpeg to Dockerfile runtime, both dev compose roles and any UAT image that executes this path.
Run actual decoder probes in the built image and actual app upload through it. No reliance on host
PATH or the stripped browser-test binary. Startup/status returns a stable unavailable remediation
when the required decoder cannot execute; no new mandatory secret/config setting.

## ASR clips, finalization and original time

Use at most 30-second canonical WAV clips. Transcribe one checkpoint job at a time through
`createConfiguredTranscription`, carrying existing language/vocabulary settings. Persist the chosen
safe modelRoute and revalidate it at dispatch; a route change produces explicit retryable failure.
Before actual fetch initiation, admit current actor/source/attempt and invoke the AI-owned validator.
No DB connection or row lock spans provider response waiting. Retry after a changed configured route explicitly binds the new route, starts a new transcript
generation and retranscribes every clip; discard prior-generation clips from final assembly.
Ordinary same-route retry retains current-generation checkpoints. Never silently combine routes
or require an obsolete route to return before Retry can work. Validate returned segment bounds and
add clip offsets; deterministic segment IDs and checkpoint uniqueness prevent duplicate content.

Extract a focused Meetings-owned finalization from existing manual-entry/import orchestration.
It atomically commits the final transcript revision, source metadata, manual operation completion,
one summary intent and Calendar matching intent. No summary or filing from an incomplete upload.
User title/type are preserved across retries and later type retirement; recording metadata follows
the existing retained identity rules. A completed transcript is not discarded if later summary,
filing or Calendar matching is unavailable. Empty ASR is an explicit no-speech failure.

Original recording time is supplied explicit ISO offset time or strictly validated embedded
creation timestamp with an unambiguous timezone. Add bounded owning metadata parsing before use;
container claims without offset/timezone are unknown. Browser File.lastModified, filename,
upload time and filesystem mtime are never recording evidence. Duration comes from decoded
samples. Persist timestamp provenance and effective start/end through the public timing API.
Capture and ring/import timing use their existing origin/epoch or validated sidecar evidence;
do not reinterpret relative segment clocks as Unix time. A pasted transcript's synthetic 1 ms span
is not a known duration and cannot qualify it for Calendar matching.

## Calendar occurrence matching and lookup

Own Meetings `calendar-link-port.ts`, `calendar-links.ts`, `calendar-link-jobs.ts`,
`calendar-link-routes.ts`, shared `meeting-calendar-api.ts` and root
`meeting-calendar-runtime.ts`. Calendar receives a public linked-recording lookup dependency;
no module imports another module's internals or queries its tables. Meetings link rows are
owner-RLS and store recording/time revision plus opaque event occurrence ID and matching event
start/end revision. They do not grant access or copy Calendar private content.

The root adapter returns at most 201 actor-accessible event candidates in a start window of
recording start +/-20 minutes; more than 200 means overflow/ambiguous and no automatic link.
Ignore all-day, cancelled, unconfirmed and Moss focus-block events. Require positive actual known
recording and event durations. Rank overlapping candidates by absolute start difference; require
overlap >= half the shorter duration, best start difference <=10 minutes and separation >=10
minutes from the next overlapping start candidate. Ties/unknown evidence yield no link. This
implements the existing plan's conservative matching, without a model call or title heuristics.

Persist concrete cached occurrence ID, never recurring series ID. An event can have more than one
recording; do not choose an arbitrary recording for singular Open meeting. Singular lookup returns
an action only when exactly one current accessible linked recording remains. No separate unapproved
picker screen. Matching jobs are idempotent metadata-only, bounded and revision fenced. A Calendar
outage is no link/retryable metadata state, not failed transcript processing.

Every event-to-recording lookup freshly authorizes both resources under current actor and validates
current timing/occurrence revision and matching evidence. Missing/changed/inaccessible resources,
disabled owning module or ambiguous linkage return no action, without exposing recording identity.
Forward links use the same authorization. Stale link rows are reconciled by owning services.
The browser fetch aborts on event switch and keys result by actor and occurrence; a delayed response
for a previous selection cannot show Open meeting on the current event.

Use existing PeekPanel and ButtonLink. Navigation opens actual Meetings detail, restores expected
focus and preserves the shared modal dismissal/isolation behavior. Match approved desktop/phone
Calendar fixture and audio tab using shared Tabs, Field, FormLabel and Button. Audio-empty state
has disabled submission; selected filename is display-only; upload/decode/ASR progress and retry
come from receipts, recover on reload and never claim completed recording before finalization.

## Ordered work and verification

1. Audio admission/storage/decoder contracts and owning migrations. Implement bounded receipt,
   quota, supported-content checks, subprocess limits, cleanup and deployment dependencies.
2. Checkpoint transcription, replay/deletion fencing and atomic manual finalization. Reuse AI
   dispatch and summary/filing intent boundaries. Assert exact original time provenance.
3. Public timing and Calendar host adapter, conservative occurrence matching and lookup.
4. Approved audio screen and Calendar action, truthful app map and Release note. Add tests below,
   full isolated gate, CI and real ASR+model UI proof before merge.

Add isolated integration suites `manual-recording-audio.test.ts`,
`manual-recording-audio-lifecycle.test.ts` and `meeting-calendar-links.test.ts`. Cover corrupt and
disguised formats, nested references, byte/sample/time/output limits, no-speech, unavailable decoder,
ASR configuration change, non-faststart M4A producing actual samples, worker death, queue expiry, lost response replay, upload quotas and every
cleanup path. Observe limit/lease/owner guards fail under individual negative controls. Include
both runtime roles and admin isolation, preserved title/type, failed finalization retry and clip
checkpoint replay without duplicated transcript, record, summary or filing intent.

Calendar cases cover unknown time/duration, explicit timezone and embedded metadata, upload-time
rejection, overlap/start bounds, candidate overflow/ties/separation, recurring occurrence IDs,
multiple recordings, changed/deleted/inaccessible event/record, module disable and stale browser
responses. Negative controls removing current authorization and occurrence comparison must fail.

Execute `3777-recording-audio-calendar-real.uat.spec.ts` against an instance on
`devports claim meetings-build`. Create synthetic spoken audio locally, upload through actual UI,
use an actual configured ASR model and actual summary model configured through Settings. Source
speech synthesis is test data creation, never a fake provider response. Assert recognized source
words, retained transcript, user identity choices, actual original time, automatic summary/filing,
Calendar -> correct occurrence -> Open meeting, unlinked/ambiguous/unknown cases and reload.
No intercepted responses, screenshots or traces. Record exact clean commit, process exit0 and
bounded assertions on PR; real ASR dependency readiness alone is not assembled proof.

All DB tests and full gate use verify-gate's start and background wait --follow; expected actual
terminal exit0. Never pipe verification. Run design token/class and keyboard/focus/phone checks for
changed UI. Keep #3777 open until all prior filing acceptance and this phase's proof are complete.
Merge with `gh pr merge --squash --auto` only after all checks and live proof pass, then stop owned
servers/browser, release devports and leave this worktree clean.

Kill gate owned by builder: stop and repair if replay duplicates source/transcript or dispatches a
stale attempt, unknown time links a Calendar event, either access check is bypassed, input escapes
fixed decoder admission, or real ASR UI cannot reach persisted final transcript. Ben owns scope
changes. Prefer this separate manual pipeline over fabricated ring packets; preserve existing
ring/capture paths and owning APIs. A second opinion reviews these seams before plan publication.

## Independent seam review ledger

- Reviewer reproduced valid non-faststart AAC M4A yielding zero decoded PCM through pipe input
  with ffmpeg exit0. The plan now requires a trusted seekable descriptor, validates decoded sample
  count and adds that actual-content case; exit0 alone is never decoder success.
- Reviewer required explicit route-change Retry semantics. A newly configured route starts a new
  transcript generation while preserving upload/final-record uniqueness; checkpoints never mix routes.
- No concrete Calendar architecture blocker found against current public bounded actor-scoped
  queries and occurrence fetch behavior. Review is plan feasibility, not implementation proof.
