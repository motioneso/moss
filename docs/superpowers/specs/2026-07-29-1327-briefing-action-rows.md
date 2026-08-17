# Structured action rows in morning and evening briefings

**Status:** draft — awaiting Ben approval
**GitHub:** #1327
**Grounded on:** `c637da5c` (`spec/1327-briefing-action-rows`)
**Risk tier:** `security`

This spec adds a typed action-row payload beside briefing prose. It does not turn the prose into
data, derive actions at briefing time, add an email client, or add a second reply-writing path.
Email sync continues to create `status: "suggested"` tasks; briefing composition only snapshots
those continuously maintained rows. It also closes the existing Today-page render gap for morning
and primary-evening prose using the `summaryText` already composed, persisted, and served—no new
composition logic, API field, or migration.

The tier is mechanical under `.claude/skills/coordinate/SKILL.md`: this changes cross-module
contracts and a shared table (`sensitive`) and adds owner-only suppression state with FORCE RLS
(`security`). The build therefore needs Opus adversarial QA, a posted security verdict, Ben's merge
sign-off, and the user-facing live-path proof below.

## 1. Locked product behavior

- Morning and evening expose the same source of action rows. Evening includes only rows still
  outstanding when it runs; it does not derive a separate set.
- A row remains a suggested task until Accept changes it to `todo`. Dismiss changes it to
  `archived`. The existing task update route and feedback transition are reused.
- Email v1 rows are only `needs_reply`, `needs_action`, and `time_sensitive_info`.
  `waiting_on_someone`, `fyi`, `noise`, and `unknown` never become rows.
- `needs_reply` gets **Reply**. `needs_action` and `time_sensitive_info` get **View**.
  Accept and Dismiss remain available on every outstanding row.
- Every row has a `cacheMessageId`. A candidate without one is omitted and is not counted, because
  no action could run against it.
- A source link is optional. A candidate without one is still shown and still counted; it simply
  renders no **View** control. Reply resolves through `cacheMessageId`, not through the link, so a
  linkless row remains fully actionable via Reply, Accept, and Dismiss.
- Existing confidence floors stand: `0.4` generally and `0.7` for `time_sensitive_info`.
- Subject-level suppression is exact-match v1: normalize inferred subject by trimming,
  lowercasing, and collapsing whitespace, then SHA-256 hash it with a fixed namespace, matching
  the `createMemoryFactSignature()` pattern. No embeddings or similarity suppression.
- Two dismissals suppress the subject. Volume never resurfaces it.
- Accepting a row clears that subject's dismissal count back to zero. A subject the actor has
  demonstrably chosen must never sit one dismissal away from permanent suppression.
- A suppressed subject may return only for:
  1. a deadline newly entering “due tomorrow” in the actor's timezone; or
  2. a new message on the thread whose inferred subject matches relevant ingested Obsidian notes
     or memory-graph recall.
- A resurfaced row carries one deterministic reason: `Back — due tomorrow` or
  `Back — related to active work`.
- Catch-up is email-only in v1.
- The existing Today suggested section stays, but uses the same row component and underlying task
  IDs as the briefing surfaces.

## 2. Current seams, re-verified

- `packages/briefings/src/compose.ts:65` owns morning composition and delegates evening immediately
  to `composeEveningBriefing`; the issue's old prose-only line citation is stale.
- `packages/briefings/src/compose-evening.ts:107` is the separate evening gather path.
- `packages/briefings/src/compose-shared.ts` owns `ComposeResult`, manifest-tool gathering, and the
  capability-routed economy synthesis call.
- Morning `summaryText` is composed at `packages/briefings/src/compose.ts:457`, persisted as
  `summary_text` at `packages/briefings/src/repository.ts:289`, and served at
  `packages/briefings/src/routes.ts:590`.
- Across `apps/web/src` and `packages/chat/src`, `summaryText` has exactly one render site:
  `apps/web/src/today/evening-mode.tsx:148`.
- `apps/web/src/today/today-page.tsx:116-136` selects and fetches only the evening definition and
  runs. Its “Start here” content is derived client-side from tasks at
  `apps/web/src/today/today-page.tsx:240-243` and rendered at
  `apps/web/src/today/today-page.tsx:332-362`; no morning run prose is queried or rendered.
- The one prose render is the `compact` evening variant; the primary “What happened today” card at
  `apps/web/src/today/evening-mode.tsx:138-156` renders no prose. `compactSummary()` truncates that
  compact copy to 220 characters at `apps/web/src/today/evening-mode.tsx:280-284`, and the compact
  variant appears in day mode at `apps/web/src/today/today-page.tsx:539-550`.
- `packages/briefings/src/trust-boundary.ts` sanitizes every external prompt line and keeps the
  trusted preamble literal.
- `packages/connectors/src/monitor-jobs.ts:109` continuously plans email tasks and writes them
  through a structural task port.
- `packages/connectors/src/source-context/email-tasks.ts` enforces the confidence floors and
  deterministic per-message task key.
- `packages/connectors/src/email-extract.ts` is the only safe place to accept new model-written
  email fields: `safeSignalStr()` plus the cumulative body-reconstruction guard.
- `packages/tasks/src/email-feedback.ts` maps suggested→todo/done to accepted and
  suggested→archived to rejected.
- `apps/web/src/today/today-suggested-email.tsx` already performs Accept/Dismiss with `updateTask`.
- `TaskDto.sourceRef` is **not** the reply target. It is
  `connectorAccountId:externalId`; `email.draftReply` requires `cacheMessageId`.
- `EmailContextItem` already carries both the provider-stable `messageKey` and nullable
  `cacheMessageId`. The build must preserve account identity when resolving the latter:
  `listEmailContext()` currently indexes cached rows by external ID alone and must be corrected to
  use `(connectorAccountId, externalId)` before Reply relies on it.
- `email.draftReply` accepts `{ cacheMessageId, body }` and re-derives recipient, subject, and
  thread under `DataContextDb`.
- `ChatControls.openChatWith(prompt)` exists and auto-sends. It is the v1 Reply handoff.
- `GraphMemoryRecallService.recall()` is the graph-memory retrieval path. The existing briefing
  `memoryRetriever.retrieve(..., "vault")` is the ingested-Obsidian-notes path; neither is the
  `@jarv1s/vault` filesystem package.

## 3. Shared contracts

Add `packages/shared/src/briefing-action-rows.ts` and export it through the package's existing
public barrel.

```ts
export type BriefingActionCategory = "needs_reply" | "needs_action" | "time_sensitive_info";

export type BriefingActionPrimaryAction =
  | { readonly kind: "reply"; readonly cacheMessageId: string }
  | { readonly kind: "view"; readonly href: string };

export type BriefingActionResurfaceReason = "due_tomorrow" | "relevant_context";

export interface TaskSuggestionMetadataV1 {
  readonly version: 1;
  readonly category: BriefingActionCategory;
  readonly sourceLabel: string;
  readonly sourceHref: string | null;
  readonly cacheMessageId: string | null;
  readonly subjectSignature: string;
  readonly computedAt: string;
  readonly resurfaceReason: BriefingActionResurfaceReason | null;
}

export interface BriefingActionRowDto {
  readonly taskId: string;
  readonly title: string;
  readonly explanation: string;
  readonly category: BriefingActionCategory;
  readonly status: "suggested" | "accepted" | "dismissed";
  readonly primaryAction: BriefingActionPrimaryAction | null;
  readonly source: string;
  readonly sourceLabel: string;
  readonly sourceRef: string;
  readonly sourceHref: string | null;
  readonly dueAt: string | null;
  readonly computedAt: string;
  readonly resurfaceReason: BriefingActionResurfaceReason | null;
}

export interface BriefingCatchUpDto {
  readonly source: "email";
  readonly itemCount: number;
  readonly summaryText: string;
  readonly asOf: string | null;
}

export interface BriefingStructuredPayloadV1 {
  readonly version: 1;
  readonly actionRows: readonly BriefingActionRowDto[];
  readonly catchUp: BriefingCatchUpDto | null;
}
```

`TaskDto` gains nullable `suggestionMetadata: TaskSuggestionMetadataV1 | null`. The task API schema
must validate the closed fields above; no `Record<string, unknown>` escape hatch.

`BriefingRunDto` gains required `structuredPayload: BriefingStructuredPayloadV1`. Blocked, failed,
and legacy rows serialize as `{ version: 1, actionRows: [], catchUp: null }`.

`ComposeResult` gains `structuredPayload`. `BriefingsRepository.persistRun()` stores it under the
existing `source_metadata.structuredPayload` JSON key; no briefing-table migration. `serializeRun`
validates and projects it to the top-level DTO and removes that key from the returned
`sourceMetadata`, so the API does not duplicate the payload.

## 4. Storage and ownership

### 4.1 Task row metadata

Add nullable `suggestion_metadata jsonb` to `app.tasks` in a **new** tasks-module migration:

`packages/tasks/sql/<next-free-at-build-time>_task_suggestion_metadata.sql`

Migration numbers are global and assigned by landing order. The builder resolves the next free
number immediately before the migration commit; this spec does not reserve one.

The column is **owner-or-share**, matching its parent task row. It contains no body, prompt,
secret, recipient, or credential. `cacheMessageId` is opaque and still useless to another actor:
`email.draftReply` re-resolves it through the caller's `DataContextDb` and fails closed. Suggested
email tasks remain in the owner's Personal list unless the owner explicitly shares/moves them.

`TasksRepository.create()` accepts the typed metadata. Its existing `(source, external_key)`
idempotency branch must refresh metadata for an existing `suggested` task without changing status.
It must never silently change an `archived` task back to `suggested`; only the explicit resurface
operation in §6 may do that.

### 4.2 Subject suppression state

Add connector-owned `app.email_action_suppression` in a **new** connectors-module migration:

`packages/connectors/sql/<next-free-at-build-time>_email_action_suppression.sql`

Fields:

| Field                        | Contract                           |
| ---------------------------- | ---------------------------------- |
| `owner_user_id`              | actor owner; composite primary key |
| `subject_signature`          | SHA-256 hex; composite primary key |
| `dismissal_count`            | non-negative integer               |
| `last_deadline_evidence_key` | nullable bounded text              |
| `last_context_message_key`   | nullable bounded text              |
| `updated_at`                 | timestamp                          |

Classification is **owner-only**. Enable and FORCE RLS for app and worker roles using
`owner_user_id = app.current_actor_user_id()`. Repositories take `DataContextDb` only. The table
stores hashes, counts, opaque evidence keys, and timestamps only—no inferred subject, title,
explanation, body, prompt, note excerpt, or recalled memory text.

## 5. Email extraction, provenance, and body-echo defense

Extend `EmailActionabilitySignal` with `inferredSubject?: string` and ask the existing economy
capability extraction prompt for a short statement of what the action is about.

Per persisted model-written field:

| Stored/displayed field | Source and mandatory guard                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inferredSubject`      | `safeSignalStr()` and `stripIfBodyReconstructed()` before `signals` JSON persistence                                                                          |
| row `title`            | existing `suggestedTasks[].text`, already through `safeActionItems()`/`safeSignalStr()`; metadata creation must reject missing text                           |
| row `explanation`      | existing `actionability.reason`, already through `safeSignalStr()` and the cumulative reconstruction guard; use a fixed authored fallback, never snippet/body |
| catch-up `summaryText` | deterministic composition of already body-echo-guarded `EmailMessage.summary` values only; no snippet/body fallback and no new model call                     |
| `resurfaceReason`      | deterministic enum-to-copy mapping; not model-written                                                                                                         |

Unknown model keys remain dropped. Caps remain in force. Tests must cover exact body echo, a long
body substring, wrapped body text, and cumulative reconstruction spread across
`inferredSubject`, reason, and suggested titles.

Create the subject signature locally in connectors with the exact
`createMemoryFactSignature()` normalization/hash pattern and a fixed `email-action-subject`
namespace. Do not import memory internals across the module boundary and do not introduce an
embedding dependency.

`TaskSuggestionMetadataV1` is written by the email monitor only when all are present:

- guarded title and explanation;
- guarded inferred subject and its signature;
- `cacheMessageId`;
- a provider source link when one can be built (optional — its absence does not drop the row);
- an eligible actionability category and confidence.

For Gmail, add a provider-owned deep-link helper using verified account/thread metadata. The
builder must verify the final URL against a real connected dev account before enabling it.
IMAP exposes no linkable surface — it is a protocol, not a web application, so there is no address
to send an actor to and no way to know which client reads the mailbox. IMAP rows therefore carry no
source link, but they are still shown: they simply render no **View** control. Building an email
reader remains out of scope.

Missing `cacheMessageId` means no row and no count, because nothing could act on it — though the
underlying suggested task may remain visible in Tasks. A missing source link is not a reason to drop
a row (Ben's ruling, 2026-07-30): Reply resolves through `cacheMessageId`, so a linkless row is
fully actionable via Reply, Accept, and Dismiss, and dropping it would hide real mail from anyone on
a non-Gmail provider.

Fix `listEmailContext()` cache lookup to key by connector account plus external ID. Add a collision
test with two accounts sharing the same provider message ID; each must receive its own cache row ID.

## 6. Suppression and resurfacing

Replace the sender-domain skip/halve decision in `effectiveConfidence()` with subject-state
evaluation for action-row candidates. Sender-domain aggregates may remain analytics, but may not
hide or demote a row; otherwise rejecting GitHub noise can still swallow a token-expiry warning.

The monitor performs one bounded batch read for the distinct candidate subject signatures on that
account. Do not issue one suppression query per row.

Planning rules, in order:

1. Apply category and existing confidence floors.
2. If `dismissal_count < 2`, plan normally.
3. If `dismissal_count >= 2`, suppress unless one unused evidence trigger below succeeds.
4. Volume, sender frequency, repeated sync of the same message, and briefing frequency are never
   evidence.

Dismiss must update task status and increment the matching subject state in the same
`withDataContext()` transaction through a structural `SuggestionSuppressionPort` supplied by the
composition root. The tasks module knows only that public port; it never imports connector
repositories. Repeating a request against an already archived task must not increment again.

Accept must reset the matching subject state in that same `withDataContext()` transaction, through
the same `SuggestionSuppressionPort`: set `dismissal_count` to `0` and clear
`last_deadline_evidence_key` and `last_context_message_key` so the subject starts clean. An accept
on a subject with no suppression row is a no-op, never an insert. Repeating accept against an
already accepted task must not reset again.

Deadline trigger:

- evaluate with the actor's canonical IANA timezone, never server UTC;
- eligible only when the due date is now on the actor's tomorrow;
- evidence key is `deadline:<dueAt>`;
- if it equals `last_deadline_evidence_key`, remain suppressed;
- on successful resurface, persist the evidence key and set reason `due_tomorrow`.

Context trigger:

- run only when the matching subject arrives on a new message/thread event;
- evidence key is `<connectorAccountId>:<messageKey>`;
- if it equals `last_context_message_key`, do not retrieve again;
- query both the ingested-note `MemoryRetriever.retrieve(..., "vault")` path and
  `GraphMemoryRecallService.recall()` through one composition-root
  `ActionRowRelevancePort`;
- the port returns only a boolean. It never returns/stores/logs note excerpts or memory text in
  connectors;
- graph recall uses its existing confidence/direct-match filters; an ingested-note result counts
  only when it also shares at least one normalized inferred-subject token of four or more
  characters, preventing “nearest vector always wins” resurfacing;
- persist `last_context_message_key` after evaluation whether it matches or not, bounding cost;
- on a match, resurface with reason `relevant_context`;
- retrieval failure fails closed: keep suppressed, record only a sanitized metric, continue the
  monitor.

Resurfacing is an explicit task-port operation: it may transition the matching archived task back
to `suggested` or create the new-message task as `suggested`, refresh typed metadata, and set the
deterministic reason. It may not reset `dismissal_count` — the same evidence therefore cannot beat a
second dismissal. An explicit Accept is the only thing that resets the counter.

## 7. Structured payload beside prose

Add `packages/briefings/src/action-rows.ts` with a pure projector plus one gather function:

- call the declared `tasks.list` read-risk assistant tool with `status: "suggested"`;
- accept only tasks with valid `TaskSuggestionMetadataV1` and non-null `sourceRef`. A `needs_reply`
  row additionally requires a `cacheMessageId`; a view-category row does not require a
  `sourceHref` and emits `primaryAction: null` without one;
- map `needs_reply` to `{ kind: "reply", cacheMessageId }`;
- map the other two categories to `{ kind: "view", href: sourceHref }` when `sourceHref` is
  present; when it is null the row has no primary action and offers only Accept and Dismiss;
- sort due date first, then task `updatedAt`, then task ID for deterministic output;
- cap at the existing section item cap; count only the emitted rows;
- set row status to `suggested` in the run snapshot.

This is the #1282 module→briefing seam, not a tasks-package import:
`tasks.list` is resolved from declared module manifests like every other source. The metadata
contract and structural creation port are source-neutral, so another installed module can create a
suggested task carrying the same contract without adding a branch to `composeBriefing`.

Both `composeBriefing()` and `composeEveningBriefing()` call the shared gather/projector and return
the resulting `BriefingStructuredPayloadV1`. Evening gathers current `suggested` rows at its own
run, so accepted/dismissed morning rows are absent while still-outstanding rows remain.

### No contradiction or duplication

- Filter all `suggested` tasks out of prose task sections.
- Build the set of action-row `sourceRef`s before email prose/signals and filter those messages out
  of the prose email channel.
- Counts in UI come from emitted structured rows after all eligibility checks, never from model
  text or pre-filter candidate counts.
- Add one literal sentence to both trusted synthesis instruction constants: discrete action rows
  are rendered separately, so the prose must not invent, count, or restate action items.
  Interpolate no row value into trusted text.
- Fallback prose uses the same filtered sections.
- On Today, render prose and rows as separate authored sections. Prose provides orientation; row
  titles, explanations, counts, and controls appear only in `BriefingActionRowsSection`. The web
  layer must not concatenate structured row or catch-up copy into `summaryText`.

The structured payload itself never enters the synthesis prompt. It travels alongside
`summaryText` through `ComposeResult`, persistence, and `BriefingRunDto`.

### Email catch-up

Catch-up includes email `waiting_on_someone` and `fyi` messages that did not contribute an action
row. Exclude `noise`, `unknown`, and every action-row source reference.

`itemCount` is the exact number after those filters. `summaryText` is a deterministic, bounded
join of up to three already-guarded cached summaries; messages without a guarded summary are
counted but contribute no text. If none has safe text, use the authored copy
`No safe summary is available yet.` No model call is added. `asOf` is the email connector-sync
timestamp, not briefing creation time.

## 8. Web behavior

### Briefing prose surfaces

Close the existing render gap before adding rows:

- In day/morning mode, resolve the enabled morning definition and its same-local-day run using the
  existing briefing API. Render that run's `summaryText` as the first `jds-brief` in the main
  column, immediately before “Start here”. The resulting order is morning prose → “Start here” →
  `BriefingActionRowsSection` (replacing the suggested-from-email section) → the optional overnight
  section → the calendar card. The narrative frames the day first; task triage and discrete email
  actions follow; the calendar remains the chronological detail.
- In evening mode, render the run's `summaryText` directly below the primary “What happened today”
  heading and any freshness banner.
- Morning and primary-evening prose are complete text: preserve paragraphs, render as text, and do
  not call `compactSummary()`, line-clamp, or otherwise truncate them. The small day-mode evening
  tile keeps the existing whitespace normalization and 220-character `compactSummary()` cut.
- If the relevant briefing definition is disabled, omit its prose surface. While an enabled
  definition or run query is loading, keep the card in place with the authored
  `Gathering your morning briefing…` or `Gathering your evening review…` state. When no
  same-local-day run exists or its prose is blank, use `Your morning briefing is not ready yet.` or
  the existing `Your evening review is not ready yet.` empty state; never render a blank card.
- Reuse `parseBriefingFreshness()` and `BriefingStaleBanner` above the prose on both full surfaces.
  The morning surface gets the same stale treatment as evening. Extend existing `jds-brief__*`,
  `agenda-clear`, and authored loading/empty patterns; do not add raw colors, mono, or serif.

### Action rows

Replace `SuggestedFromEmailSection` with `BriefingActionRowsSection` in
`apps/web/src/today/briefing-action-rows.tsx`; use it from both day and evening layouts.

- Extend existing `jds-brief`, `loose`, and `loose-row` primitives.
- No raw colors outside `apps/web/src/styles/tokens.css`; no mono or serif.
- Title is the instruction, explanation is one sentence, provenance is a source link where one
  exists and plain non-interactive text where it does not, and `computedAt` supplies “Updated … ago”.
- The displayed count is the number whose live task status is still `suggested`.
- Join run-snapshot rows to the existing `tasksQuery` by `taskId`:
  `suggested` stays actionable, `todo|done` renders Accepted, and `archived` renders Dismissed.
  This keeps a visible “dealt with” state without asking briefings to query task internals.
- The next briefing snapshot includes only then-current suggested rows.
- Accept/Dismiss call the existing `updateTask` transition and invalidate both task and briefing
  queries.
- View opens `sourceHref` with safe external-link attributes.

Reply uses the coordinator-approved chat handoff:

```ts
chatControls.openChatWith(
  `Draft a reply to the cached email ${cacheMessageId} using email.draftReply.`
);
```

That is a fixed literal template with exactly one interpolated value: the opaque
`cacheMessageId`. Never interpolate title, explanation, subject, sender, summary, snippet, or body.
`openChatWith` auto-sends; this is acceptable only because the actual write remains downstream of
the existing `email.draftReply` confirmation card. One click does **not** create a Gmail draft.
There is no new endpoint, reply composer, AI call, or duplicated write policy.

Known v1 limitation: Reply is chat-mediated and unavailable on a surface without chat. Such a
surface may show the source link but must not pretend Reply ran.

Authored states are required:

- loading: `Checking what needs you…`;
- empty: `You're caught up — nothing is waiting on you.`;
- catch-up empty: omit the section rather than render a blank card;
- stale: use the existing briefing freshness authored pattern, based on the oldest displayed
  row's `computedAt`.

The Today section can fall back to live suggested tasks with valid metadata before today's
briefing exists. Once a run exists, its payload supplies the snapshot and catch-up section. Add a
same-local-day morning-definition/run query; day mode uses morning, evening mode uses evening.

## 9. Dependency-ordered build tasks

Each task is independently committable. Tasks marked **user-facing** require matched e2e/live proof
in their landing PR.

### Task 1 — typed contracts and storage

Files:

- new `packages/shared/src/briefing-action-rows.ts`
- `packages/shared/src/tasks-api.ts`
- `packages/shared/src/briefings-api.ts`
- `packages/db/src/types.ts`
- `packages/tasks/src/repository.ts`
- `packages/tasks/src/serialize.ts`
- new tasks and connectors migrations named in §4
- new `packages/connectors/src/action-suppression-repository.ts`

Tests:

- `tests/unit/briefing-action-row-contract.test.ts` —
  `rejects malformed suggestion metadata and structured payloads`
- `tests/integration/tasks-suggested-status.test.ts` —
  `round-trips typed suggestion metadata without changing suggested status`
- `tests/integration/email-action-suppression-rls.test.ts` —
  `owner cannot read or update another owner's suppression state`

### Task 2 — resolve reply targets and provider links

`TaskDto.sourceRef` cannot be passed to `email.draftReply`: it is
`connectorAccountId:externalId`, while the tool accepts the cache row's opaque
`cacheMessageId`. This is required net-new plumbing, not a UI conversion or guessed identifier.

Files:

- `packages/connectors/src/source-context/email.ts`
- `packages/connectors/src/repository.ts`
- new `packages/connectors/src/source-context/email-action-links.ts`

The builder must verify at `packages/connectors/src/source-context/email.ts:listEmailContext` that
cache lookup is keyed by both connector account ID and external message ID, and must carry the
resolved `cacheMessageId` separately from `sourceRef`. The builder must also verify the provider
deep link against a real connected dev account before enabling Gmail rows.

Tests:

- `tests/unit/email-monitor-run.test.ts` —
  `preserves account identity when external message ids collide`
- `tests/unit/email-monitor-run.test.ts` —
  `keeps source ref cache id and provider link as distinct values`

### Task 3 — extraction, monitor, suppression, and resurfacing

Files:

- `packages/connectors/src/email-extract.ts`
- `packages/connectors/src/source-context/types.ts`
- `packages/connectors/src/source-context/email-tasks.ts`
- `packages/connectors/src/monitor-jobs.ts`
- `packages/tasks/src/email-feedback.ts`
- `packages/tasks/src/routes.ts`
- `packages/module-registry/src/index.ts`
- new `packages/connectors/src/action-row-relevance.ts`

Tests:

- `tests/unit/email-extract-actionability.test.ts` —
  `guards inferred subject against body echo and reconstruction`
- `tests/unit/email-monitor-tasks.test.ts` —
  `suppresses exact subject after two dismissals and ignores volume`
- `tests/unit/email-monitor-tasks.test.ts` —
  `accept clears the subject dismissal count and used evidence keys`
- `tests/unit/email-monitor-tasks.test.ts` —
  `resurfaces once for new due-tomorrow evidence`
- `tests/unit/email-monitor-tasks.test.ts` —
  `evaluates relevance only for a new message and fails closed`
- `tests/integration/tasks-suggested-status.test.ts` —
  `dismiss and suppression update commit atomically`

### Task 4 — compose and API structured channel

Files:

- new `packages/briefings/src/action-rows.ts`
- `packages/briefings/src/compose-shared.ts`
- `packages/briefings/src/compose.ts`
- `packages/briefings/src/compose-evening.ts`
- `packages/briefings/src/fallback.ts`
- `packages/briefings/src/freshness.ts`
- `packages/briefings/src/repository.ts`
- `packages/briefings/src/routes.ts`

Tests:

- `tests/unit/briefings-compose.test.ts` —
  `returns rows beside prose and excludes their tasks and emails from prose`
- `tests/unit/briefings-compose.test.ts` —
  `morning and evening use the same row projector`
- `tests/unit/briefings-compose.test.ts` —
  `counts only eligible linked rows and emits authored empty payload`
- `tests/unit/briefings-compose.test.ts` —
  `builds bounded email-only catch-up from guarded summaries`
- `tests/integration/briefings-synthesis.test.ts` —
  `trusted literals interpolate no structured row content`
- `tests/integration/briefings-synthesis.test.ts` —
  `persists and serializes structured payload without sourceMetadata duplication`

### Task 5 — surface existing briefing prose (**user-facing**)

This lands before the row UI so a builder cannot ship structured actions onto a Today page whose
narrative is still absent. It reuses the served `summaryText`; no briefing contract, composition,
storage, or API work belongs here.

Files:

- `apps/web/src/today/today-page.tsx`
- `apps/web/src/today/evening-mode.tsx`
- existing tokenized Today CSS files only

Tests:

- new `tests/unit/today-briefing-prose.test.tsx` —
  `renders full morning prose before Start here with authored loading empty and stale states`
- new `tests/unit/today-evening-mode.test.tsx` —
  `renders full primary recap and keeps the 220 character cut only on the compact tile`

### Task 6 — unified briefing row UI (**user-facing**)

Files:

- new `apps/web/src/today/briefing-action-rows.tsx`
- delete `apps/web/src/today/today-suggested-email.tsx` after callers move
- `apps/web/src/today/today-page.tsx`
- `apps/web/src/today/evening-mode.tsx`
- `apps/web/src/api/client.ts`
- `apps/web/src/api/query-keys.ts`
- existing tokenized Today CSS files only; add tokens solely in
  `apps/web/src/styles/tokens.css` if an existing token cannot express the state

Tests:

- new `tests/unit/today-briefing-action-rows.test.tsx` —
  `renders truthful count and accepted dismissed states`
- same file — `Reply auto-sends only the fixed cache-id chat instruction`
- same file — `View uses sourceHref and never model text as a URL`
- same file — `renders authored loading empty stale and catch-up states`
- `tests/unit/today-evening-mode.test.tsx` —
  `day selects morning payload and evening selects outstanding evening payload`

### Task 7 — integrated proof (**user-facing**)

Files:

- new `tests/e2e/briefing-action-rows.spec.ts`
- existing e2e mock API helpers as required

Test:

- `morning and evening prose and action rows render accept dismiss view reply and stay suppressed`

The test first proves full morning prose appears before “Start here”, the full recap appears on the
primary evening card, and only the compact day tile uses the 220-character cut. It seeds one row per
category, verifies count 3, verifies the source links, accepts one, dismisses one twice across
independent messages, and clicks Reply. It asserts that the chat turn contains only the fixed
literal plus opaque cache ID, that the existing confirmation card appears, and that no draft is
created before confirmation. It then verifies authored prose and row empty/loading/stale states and
that a new run keeps the twice-dismissed subject absent until one allowed evidence trigger.

## 10. Failure behavior

- Invalid/missing suggestion metadata: omit row, do not count, record a sanitized metric.
- Missing cache ID: omit row and do not count it — no action could run against it.
- Missing source link: keep and count the row, and render no View control. Never invent a fallback
  URL and never guess an account index.
- Suppression read failure: fail closed for previously suppressed candidates; monitor continues.
- Relevance retrieval failure: remain suppressed; no recalled content in logs.
- Structured-payload projection failure: prose run still succeeds with empty payload and a
  `structured_payload_failed` gap/metric.
- Synthesis failure: existing deterministic prose fallback plus the independently projected
  structured payload.
- Task mutation failure: row remains actionable and shows the existing error pattern.
- Chat unavailable: Reply is disabled with authored explanatory copy; View/Accept/Dismiss remain.

No job payload changes are needed. If implementation introduces a worker message, it may carry only
actor/resource IDs, job kind, idempotency key, and small command parameters—never title,
explanation, inferred subject, summary, body, prompt, note text, memory text, or secrets.

## 11. Exit criteria

1. Morning and evening `BriefingRunDto` objects carry versioned rows beside unchanged prose.
2. Day/morning Today renders the full same-local-day morning `summaryText` immediately before
   “Start here”; “Start here”, action rows, and calendar remain ordered as defined in §8.
3. Primary “What happened today” renders the full evening recap; only the compact day-mode tile
   applies the existing 220-character cut.
4. Enabled prose surfaces have distinct authored loading and empty states, never render a blank
   card, and show `BriefingStaleBanner` when freshness metadata is stale.
5. The same suggested task ID appears on Today and in a briefing; Accept/Dismiss updates both.
6. Category→button mapping is exact. A row with a source link renders a working View control; a
   row without one renders no View control and is still emitted and counted.
7. Reply uses only the fixed chat template plus opaque cache ID and reaches the existing
   `email.draftReply` confirmation flow; no second compose/write path exists.
8. Counts include only emitted, confidence-cleared, currently outstanding rows.
9. Row freshness reflects monitor/sync computation time, not briefing creation time.
10. Exact normalized-subject suppression holds after two dismissals; volume never resurfaces.
    Accepting a row resets that subject's dismissal count and used evidence keys to a clean state.
11. Deadline and relevant-context evidence each resurface once, state why, and cannot replay the
    same evidence after another dismissal.
12. Catch-up is email-only, exact-counted, bounded, and contains only previously body-echo-guarded
    summaries.
13. Body-echo/reconstruction tests cover every stored model-written field named in §5.
14. RLS proves suppression state is owner-only for ordinary users, admins, and workers; task
    suggestion metadata follows existing owner-or-share task policy.
15. `DataContextDb`, module isolation, capability-routed AI, metadata-only jobs, and pure trusted
    literals remain intact.
16. `pnpm verify:foundation`, `pnpm test:e2e`, `pnpm check:design-tokens`, and file-size checks pass
    with real exit codes.
17. A real dev-instance UAT is recorded on the PR with assertions and bounded DOM/network/log evidence: full morning prose
    above “Start here”, its loading/empty/stale states, morning rows, Accept, Dismiss, View source,
    Reply→chat→existing confirmation→Gmail draft, catch-up, full primary evening prose, the compact
    evening tile, evening outstanding rows, and one permitted resurfacing. Without that artifact
    the status is **code-complete, unverified**, not done.

## 12. Explicitly out of scope / v1 ceilings

- No email reader or reply composer.
- No direct Reply endpoint or second model/tool-policy path.
- No new connector.
- No embedding/similarity suppression; paraphrases may leak through once and be dismissed again.
- No relevance sweep on every sync; only a new message or newly due-tomorrow evidence evaluates.
- No volume trigger or sender-domain suppression.
- No catch-up source beyond email.
- No numeric briefing-specific sensitivity control; existing email task-creation mode remains the
  user control.
- Reply remains chat-mediated and therefore unavailable on chatless surfaces.
- IMAP action rows wait for a stable provider deep link; the underlying suggested task behavior is
  unchanged.

## 13. Decisions made where #1327 was silent

- Reply uses `openChatWith`, not editable `openAssistantWithDraft`, because the existing downstream
  confirmation card remains the user review gate and this avoids a second compose UX.
- Accept clears prior subject dismissals (Ben's ruling, 2026-07-30). A dismiss is a mute, and a
  suppressed subject can legitimately come back through the deadline or relevant-context triggers —
  so an actor really can see and accept something they previously muted. If the counter survived
  that accept, a subject they have just demonstrably chosen would be one dismissal away from
  permanent deletion. Accept therefore resets the count; the evidence triggers still do not.
- Catch-up is deterministic over guarded per-message summaries rather than a second LLM call.
- A relevance error keeps the mute instead of guessing.
- Email providers without a stable source link still contribute rows in v1; they contribute no
  View control. A generic scheme is not a substitute: `mailto:` composes a new message rather
  than opening the thread, and `imap://` (RFC 5092) has effectively no registered desktop
  handler. A per-account webmail base URL would be the real answer and is out of scope here.
