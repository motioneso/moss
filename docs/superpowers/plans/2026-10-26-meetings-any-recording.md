# Meetings for any recording — implementation plan

Task: #3777. Approved design: [spec](../specs/2026-10-26-meetings-any-recording-design.md).
All six [mockups](../specs/mockups/meetings-any-recording/index.html) are approved.
Work stays in `~/Jarv1s/.claude/worktrees/meetings-build`.

## Delivery and acceptance

Merge this plan-only PR before product work. Deliver ordered slices, each with truthful app-map
metadata, a release note, a passing verify-gate receipt, CI and recorded real-model browser proof.
Keep #3777 open until all slices pass. Use explicit-path commits and `gh pr merge --squash --auto`.
Phase 1 is specified in detail below. Later phases have contracts and exit criteria; refine their
implementation decisions after observing Phase 1, committing any material plan amendments first.

## Verified seams (current tree)

| Capability                                                               | Evidence                                                                                                                                                         | Decision                                                                                                                    |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Owner-scoped creation, compare-and-set title and revisioned notes        | `packages/meetings/src/repository.ts:60`, `:157`, `:177`                                                                                                         | Reuse record locking; add classification in a separate owner-scoped repository.                                             |
| Transcript ingest and retained evidence                                  | `packages/meetings/src/transcript-routes.ts:39`, `packages/meetings/src/transcript-repository.ts:1`                                                              | Manual transcripts enter this same evidence model, with explicit manual provenance.                                         |
| Single generation reservation and provider work outside transactions     | `packages/meetings/src/output-service.ts:27`, `:84`, `:121`                                                                                                      | Extend this generation, rather than add a second classifier model call.                                                     |
| Live configured model, bounded structured generation, route revalidation | `packages/module-registry/src/meeting-output-runtime.ts:110`, `:212`                                                                                             | Extend schema and validate at the owning Meetings boundary. Preserve existing transport checks.                             |
| Evidence-bound output and fixed summary styles                           | `packages/meetings/src/output-validation.ts:14`, `:27`, `packages/shared/src/meeting-output-api.ts:28`                                                           | Keep existing cited decisions/actions; add recording metadata and idea groups.                                              |
| Automatic capture/import summary intents                                 | `packages/meetings/src/stop-summary-repository.ts:88`, `:148`                                                                                                    | Reuse for capture and ring imports. Manual entry needs its own durable admission, not a fabricated capture/import identity. |
| Search is server-side and paginated                                      | `packages/meetings/src/history-repository.ts:37`, `packages/meetings/src/history-routes.ts:52`                                                                   | Apply type filtering before pagination, together with existing text search.                                                 |
| Existing audio upload is ring-specific                                   | `packages/meetings/src/recording-upload-service.ts:29`, `packages/meetings/src/recording-bundle.ts:63`, `packages/meetings/src/recording-audio-validation.ts:47` | Do not fabricate ring packets for general audio. Add a separate manual-audio admission using configured ASR.                |
| Private Notes copies and index enqueue                                   | `packages/notes/src/private-note-export.ts:95`, `packages/module-registry/src/meeting-export-runtime.ts:10`                                                      | Existing fixed immutable-copy API cannot update a topic note or undo. Add a Notes-owned revision-checked contribution API.  |
| Filesystem scope and operations                                          | `packages/vault/src/vault-context.ts:31`, `packages/vault/src/index.ts:10`                                                                                       | All recording filing I/O goes through VaultContext and public Vault operations.                                             |
| Durable Memory facts                                                     | `packages/memory/src/facts-repository.ts:9`, `:31`                                                                                                               | Extend Memory's public surface for recording-origin facts, side labels, revision checks and reversal.                       |
| Calendar access and bounded matching window                              | `packages/calendar/src/repository.ts:83`, `:108`                                                                                                                 | A host adapter reads Calendar's public repository; Meetings never queries Calendar tables.                                  |
| Existing workspace and shared controls                                   | `packages/meetings/src/web/meeting-record.tsx:91`, `packages/meetings/src/web/meetings-page.tsx:20`                                                              | Match approved controls using Menu, Tabs, Field, Select, Card, Dialog and Button.                                           |
| Main-chat background display                                             | `packages/chat/src/live/chat-session-manager.ts:520`, `packages/chat/src/live/background-message-routing.ts:25`                                                  | Display delivery exists; a durable, deduplicated module notice API and reply actions still need implementation in Chat.     |

Missing capabilities are build work, not assumed existing APIs: general audio ingestion, side-scoped
Notes contributions and Memory facts, filing discovery/confirmation, reversible cross-module
receipts, and durable main-chat notices. Builder owns these seams and their verification.

## Decisions and boundaries

### Recording types and interpretation

Six stable default IDs: `work-meeting`, `appointment`, `brain-dump`, `conversation`, `idea`, `other`.
Each has an editable name, description and existing summary-template ID. New types default to
`general`. Types are owner-scoped and edited through declared Meetings chat routes. Removal retires
the type: old recordings retain their identity/name, but retired types are not offered for new
classification. Renaming never changes IDs. Reject an empty active list and duplicate names.

Recording metadata stores type ID, side (`personal` or `work`), confidence/reason, original
recorded-at time when known, title/type provenance, classification revision and source output
version. Existing recordings remain unchanged until explicitly regenerated. Capture/import system
titles are distinguishable from user titles; preserve all user-supplied titles and type selections.
Type editing uses compare-and-set revisions. A type change selects that type's summary style on
subsequent generation and immediately changes visible section headings/filter results.

The model has exactly two jobs:

1. Interpret the recording in the existing summary call: title, active type, side, confidence,
   evidence-bound summary, idea groups and proposed durable facts/filing content.
2. Describe a bounded folder inventory and propose side-to-destination mappings and topic matches.

All other behavior is deterministic. Saved records drive progress, acknowledgements, counts,
errors, undo/restore states and links. Modules never inject host chat turns; the host invokes
Chat's public durable-notice API. Model prose is data and cannot authorize tools or paths.
Keep added guidance under 150 words, with schema field descriptions, a worked example and owning
boundary validation. Before/after diffs are retained per item. Automatic additions follow the
approved design; per-item review, change and undo remain available after application. Replacement
of user-authored content requires explicit acceptance and a revision match.

### Side isolation, filing and reversal

Personal/work is a fixed, enforced data label, never inferred from a folder name at write time.
Persist it on recordings, contributions and facts. Repositories require the actor's DataContext;
Notes/Memory APIs require the side and source identity. A destination already bound to one side
cannot receive a contribution from the other. Unknown destinations are not silently admitted.
Do not relabel existing unrelated user material. Untyped legacy notes require user confirmation
before binding a side; empty/generated notes may be bound on creation.

Read a bounded inventory through Notes' public service and VaultContext. Discover the user's own
structure, store the proposed mapping as a Memory fact, and send one deduplicated main-chat notice
for confirmation. Until confirmed, use segregated generated fallback destinations in the private
vault. These are internal storage locations, not a prescribed user filing method. A confirmed
mapping offers explicit migration of fallback contributions; it does not reorganize folders.
Refresh discovery on missing destinations or an explicit request, never by rewriting the vault.

Use a durable per-recording change ledger: source output version, item ID, kind, side, target,
before/after revision or hash, applied/undone/conflict state and public-module receipt ID. An
idempotent operation resumes from its receipt after crashes. No private text enters pg-boss.
Undo removes only the recording's own contribution/fact. A later unrelated edit causes a conflict;
never restore an old whole-file snapshot over it. Restore revalidates the target and side.
Flip prepares destinations on the new side, removes the old contribution, relabels source facts,
and commits a durable reconciliation state. Expose failures truthfully; never show a completed
flip while any surviving contribution has the old label. A pending flip prevents competing filing.

Use confidence below `0.8` for an uncertainty notice. Folder confirmation is always explicit.
Notices name the chosen side/destination and reason, link the recording, and expose declared reply
actions for side changes and mapping confirmation. Deduplicate by source output/discovery version.

### Calendar linking

Use known original recording time, not insertion/upload time. Query accessible non-all-day event
occurrences in a bounded window. Link only when one candidate starts within 10 minutes and overlaps
at least half the shorter duration; require at least 10 minutes' score separation from competing
starts. Unknown recording time, ambiguous candidates or missing Calendar access leave no link.
Persist the concrete event occurrence identity. Revalidate both resources on every lookup. A stale,
deleted or inaccessible recording yields no Open meeting action. Calendar UI requests the public
Meetings lookup through a host adapter; no cross-module table query or permission grant.

## Phase 1 — recording identity, transcript entry and type filtering

### Files and contracts

- New `packages/shared/src/meeting-recording-api.ts`: recording type, classification, side,
  configuration revision, and manual transcript request/response contracts plus strict schemas.
  Re-export through `packages/shared/src/index.ts`.
- New `packages/meetings/src/recording-types.ts`, `recording-metadata.ts`,
  `manual-entry-service.ts`, `manual-entry-routes.ts`, `recording-declarations.ts`.
- New owning SQL migration (choose the next available number at implementation, never edit an
  applied migration): owner-scoped type configuration and recording metadata, foreign key to
  `meeting_records`, forced RLS and app/worker grants matching actual handlers. Add the migration
  to `manifest.ts` and schema-catalog coverage. No changes to existing record ownership rules.
- Extend `output-service.ts`, `output-validation.ts`, `output-repository.ts` and
  `packages/module-registry/src/meeting-output-runtime.ts` for bounded interpretation in the
  reserved summary call. Optional metadata on legacy output stays readable; new generation must
  validate a complete interpretation and a currently permitted type before persistence.
- Metadata writes take the record lock and compare revisions. Commit output and classification
  together only when transcript/notes/type configuration remain current. Preserve a concurrently
  changed user title/type. A stale output cannot automatically rename or file anything.
- Manual transcript request contract: `requestKey`, optional `title`, optional `typeId`, optional
  known `recordedAt`, nonempty bounded `transcript`. Create record, metadata, final manual
  transcript evidence and generation intent atomically. Retry the same request without duplicate
  records or model dispatch. Transcript text is evidence, never user instructions to the model.
- Extend `history-repository.ts`, `history-routes.ts`, shared history schemas and
  `web/history-client.ts` with optional `typeId`; use SQL filtering before cursor/limit.
- New `web/manual-entry.tsx`, `web/recording-type-picker.tsx`, `web/recording-client.ts`.
  Wire Add recording in `web/meetings-page.tsx`, the type chip/side badge in `web/meeting-record.tsx`,
  and the filter beside search in `web/meeting-history.tsx`. Transcript entry works without a Mac.
  Expose the audio tab when Phase 3 is wired; do not ship a control that promises an absent path.
- Extract declarations from the already 1000-line `manifest.ts` into focused declaration modules;
  add routes, permissions, errors and remediations with the feature's code.

### Tests and exit criteria

- Unit: invalid/retired type rejection, bounded title and confidence validation, unknown fields,
  preservation of user selections, stale evidence/configuration, type rename/removal behavior.
  These fail if output metadata is merely trusted or type IDs are matched by display name.
- Integration: manual transcript API persistence/replay, one generation reservation, actor isolation,
  concurrent title/type change, combined search/type cursor filtering and deleted record handling.
  Remove each relevant owner/side check in a controlled mutation and observe the corresponding
  isolation test fail before restoring it; record evidence.
- Real browser: `tests/uat/specs/3777-recording-identity-real.uat.spec.ts` signs in, follows Meetings
  → Add recording, pastes a synthetic brain dump, observes real configured-model classification and
  title, changes the type through the menu, combines type/text filters and reloads. A second entry
  preserves an explicit title/type. No intercepted network responses. Assert desktop and phone
  layout and shared menu keyboard behavior using DOM/style assertions, without screenshots.

**Kill gate:** after Phase 1, if a user selection is overwritten, a stale generation changes current
identity, or a real-model recording cannot reach its saved UI through manual entry, stop later
phases and repair this phase. Builder owns the call and evidence; product scope changes go to Ben.

## Phase 2 — filing, memory and What Moss took

Add Notes-owned contribution storage/API, Memory-owned recording facts and side-aware write APIs,
and Meetings' ledger/coordinator. Wire them only through `packages/module-registry` host adapters.
Add Chat's durable deduplicated notice surface and declared Meetings reply routes. Finalize SQL
contracts after Phase 1 with migration catalog, export/delete lifecycle and worker grants covered.

Implement discovery, confirmation, fallback filing, topic selection, before/after receipts, item
change, undo/all, restore, side flip and replay/reconciliation. Match `what-moss-took.html` using
Card, Badge, Button, Dialog and Field; never derive the box from a model's claim of having written.
Match the type configuration conversation through real chat actions, including rename, removal,
description and style changes. Settings for type configuration are out of scope.

Exit: `3777-recording-filing-real.uat.spec.ts` proves both sides, first discovery notice/confirmation,
file contents and facts through real services, note/fact edit, undo, restore, flip, reload and a
concurrent-note conflict. Integration tests prove crash replay, no duplicated contributions,
source deletion and cross-side rejection; mutation controls prove the isolation checks matter.

## Phase 3 — manual audio and Calendar

Add a bounded manual-audio upload service and durable metadata-only transcription job, using the
configured transcription capability and the same language/vocabulary settings as existing capture.
Reuse public provider dispatch instead of assuming ring imports accept arbitrary audio. Validate
actual supported format/size and surface provider/format errors; retain idempotency and cleanup.
Preserve supplied title/type and known source timestamp. Unknown timestamp means no Calendar link.

Wire the approved manual-entry audio tab with selected filename, disabled-empty submission,
Transcribe audio action, saved progress/failure/retry, and automatic interpretation on completion.
Add the host Calendar matching/lookup adapter and Open meeting in its existing event details panel.
Use the existing shared PeekPanel and ButtonLink; recurring occurrence matching must be explicit.

Exit: `3777-recording-audio-calendar-real.uat.spec.ts` uploads a synthetic spoken recording through
the UI using real ASR and real summary inference; exercises Calendar → event → Open meeting and an
unlinked event, unknown times, ambiguous candidates, recurring instances and inaccessible records.
Assert actual original time and retained transcript, and verify upload cleanup and source deletion.

## Verification and evidence procedure

Read `.claude/skills/verify-gate/SKILL.md` at execution. All database tests and the full gate run
only through that procedure. Commands below are unpiped; expected exit code is 0.

```bash
scripts/run-gate.sh start
scripts/run-gate.sh wait --follow
```

Launch the follow-wait in a background tool call, keep doing independent work, then read its exit
code and bounded failure passages. A successful local gate does not replace CI's browser suite.

For each live slice, claim the port with `devports claim meetings-build`; pass its result through
`JARVIS_UAT_CLAIMED_WEB_PORT` to the existing disposable UAT runner. Use its sanctioned real-model
configuration/signin flow, no host credential prints. Run the named spec through `tests/uat/run-uat.ts`
with capture disabled. Expected exit code 0. Record commit, actual model route metadata, exact UI
entry path, assertions, setup of synthetic source records, and exit code in a PR comment. No
screenshots, traces containing credentials, fake responses or personal data in evidence.

Each PR needs full gate, required CI, live assertions, app-map truthfulness and release note before
`gh pr merge --squash --auto`. Stop owned servers/browser, remove disposable stacks and scratch
outputs, release the claimed port, and leave the worktree clean.

## Rulings ledger

- Approved spec and six mockups supersede the older issue-body reminder to agree mockups. Evidence:
  spec status and Decisions by Ben; `mockups/README.md:38`.
- General audio and reversible filing are missing seams, not features supplied by the existing ring
  upload or immutable Notes export. Evidence cited in the seams table.
- The existing Meetings manifest is already at the file-size limit. Extract declarations before
  adding feature metadata; do not exempt or grow it.
- Rejected alternative: a new classifier call would reduce the summary-schema change but duplicate
  model dispatch, latency and stale-input handling. Extending the reserved summary call preserves
  one evidence snapshot and the spec's same-step classification requirement.
- Rejected alternative: use the ring upload API for manual audio. Its strict packet, sidecar and
  canonical WAV contract is valuable for device delivery; fabricating those records for a general
  upload would obscure source identity and recording time.
