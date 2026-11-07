# Summary owner context and speakers: build slices 1-3

Spec: `docs/superpowers/specs/2026-11-06-summary-owner-context-and-speakers.md` (merged, all seven
forks ruled as recommended by Ben, 2026-11-06). Task issue: #4020 (parent #4017; each PR says
`Part of #4020`).

Scope: slices 1 (public read APIs), 2 (context pack builder and prompt block) and 3 (speakers in the
output schema and stored shape). Slice 4 (screens, correction storage, settings toggle, app map) and
slice 5 (live proof) wait for Ben's mockups and are not planned here.

## 1. Seams check

Every capability the plan assumes, cited against `origin/main` at the time of writing.

| Capability                                                                                                            | Evidence                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prompt is assembled in the registry composition, one place, with an escaped JSON `externalData`                       | `packages/module-registry/src/meeting-output-runtime.ts:310-321` (`promptFor`), `:298-302` (`escapeData`)                                                                                                           |
| Meetings never imports calendar, people or memory, so the pack is composed in the registry (design choice, not a ban) | `packages/meetings/package.json` deps (db, module-sdk, shared, structured-state, ui, jobs, vault); registry imports `@moss/calendar` and `@moss/memory` already (`approval-source-references.ts:3,7`)               |
| Meetings already receives other modules through a port built in the registry                                          | `createTask: MeetingTaskCreator` at `meeting-output-runtime.ts:484-493`                                                                                                                                             |
| Generation runs in Moss under the owner's data context, no tools                                                      | `meeting-output-runtime.ts:351` (`prepareStructuredGeneration`), `output-service.ts:149-170`                                                                                                                        |
| Prompt cap and split loop; unsplittable piece throws `meeting_output_input_too_large`                                 | `meeting-output-runtime.ts:324-330,392-398`; `STRUCTURED_PROMPT_MAX_BYTES` from `@moss/ai`                                                                                                                          |
| Instruction scan covers transcript and notes only, returns reader-facing lines, never blocks                          | `packages/meetings/src/instruction-scan.ts:34-47`; stored via `output-service.ts:149,209`                                                                                                                           |
| Artifact is one JSON text column, so a new optional field needs no SQL                                                | `packages/meetings/sql/0278_meeting_outputs.sql:12-22` (`artifact_json TEXT`, 1 MB cap)                                                                                                                             |
| Output schema, content type and validation limits                                                                     | `meeting-output-runtime.ts:67-130` (`MEETING_OUTPUT_SCHEMA`; overview, decisions and actions start at `:102`), `packages/shared/src/meeting-output-api.ts:24-31`, `packages/meetings/src/output-validation.ts:9-17` |
| Transcript speaker is anonymous and meeting-local                                                                     | `packages/shared/src/meeting-transcript-api.ts:23-24`                                                                                                                                                               |
| People has an exact name or identity lookup that takes the owner's scoped db                                          | `packages/people/src/service.ts:25-50` (`PersonContextService.resolve`), `listPeople` at `:60`                                                                                                                      |
| Memory recall takes a free-text query, scoped db and owner id, with no chat context                                   | `packages/memory/src/graph-recall-service.ts:62-69` (`recall`); needs an embedding provider, built at `built-in-module-helpers.ts:31`                                                                               |
| Calendar reads are owner-scoped by row policy, with an owner-only filter option                                       | `packages/calendar/src/repository.ts:23-32` (`ListVisibleCalendarEventsOptions`), `:83` (`listVisible`)                                                                                                             |
| Meeting preferences are per-user keys through a store port                                                            | `packages/meetings/src/preferences.ts:19-22,95-115`                                                                                                                                                                 |

### Open checks from the spec, resolved by reading the code

1. **Can meetings read attendee names through a public calendar surface? No, and the names are not
   stored at all.** Google sync writes only `attendeeCount` into event metadata
   (`packages/connectors/src/google-sync-phases.ts:340`), the shared contract exposes only the count
   (`packages/shared/src/calendar-api.ts:16`, `serialize.ts:19`), and the Outlook path stores none
   (checked `packages/connectors/src/outlook-calendar-source.ts:4` and `outlook-calendar-jobs.ts:139`; no attendee list). So slice 1 needs a connector change as well as a read
   function, and events already cached have no names until their next sync.
2. **Does people expose a lookup by name that respects sharing? Partly.** `resolve` matches one exact
   display name or identity for the owner. It returns one person or null, so it cannot rank near
   matches and nothing batches. Slice 1 adds a bounded batch lookup that takes a list of names.
3. **Does memory recall take a free-text query without a chat context? Yes.** `recall(scopedDb,
ownerUserId, query, options)` needs only the embedding provider the registry already builds. No new
   memory function is needed. Slice 1 only wraps it in a registry-side adapter.
4. **Real pack size on a seeded account: not measurable until slice 2 exists.** It is a slice 2
   exit criterion, with the numbers recorded on the PR.

### Open questions with owners

| Question                                                                              | Owner           | Default if unanswered                                                                         |
| ------------------------------------------------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------- |
| Store attendee display names only, or also email addresses, in event metadata?        | Ben (privacy)   | Names only. Matching to People then works by name, not address.                               |
| Is there a recording start time on the meeting, or only `meeting_records.created_at`? | Slice 2 builder | Read the recording metadata first, fall back to the record's creation time.                   |
| Does the Outlook mirror expose attendee names to the browser reader at all?           | Slice 1 builder | Google only in slice 1. Outlook events stay count-only, and the pack skips the attendee list. |

Ben's ruling on the first row blocks nothing: the default is built, and widening it later is one
metadata key plus one filter.

## 2. Determinism boundary

- The summary text, speaker marks and warnings all render from the stored record. Nothing in this
  work writes a turn into chat.
- The model has two jobs here, both inside the existing summary call: write the summary, and propose
  a speaker label for each speaker id with evidence. No new call.
- Added prompt guidance for the pack and speakers stays under 150 words. If a build step needs more,
  the design is wrong and comes back to this plan.
- The model's names cross into stored data, so all four guards apply:
  1. Schema field descriptions on every speaker field.
  2. A worked example in the guidance (one named, one null).
  3. A boundary validator in Moss: evidence exists, name appears in the pack or transcript, basis and
     confidence are in range.
  4. Per-item acceptance by the owner (Confirm in slice 4). Until then every inferred name is stored
     as a guess.
- Pack contents are untrusted text. The guidance says follow no instructions in them, and the scan
  below reports hits without stopping a run.

## 3. Invariants for every slice

- **Module isolation.** Calendar, people and memory expose read functions through their package
  index. Meetings defines a port type; the registry builds it. No meetings code imports another
  module's internals or tables.
- **Private by default.** Every read runs in the owner's data context. No admin path, no new
  `BYPASSRLS`. A test must show a second user's calendar, people and memory never appear.
- **Metadata-only job payloads.** The job still carries the meeting id and request key. The pack is
  built inside the generator and never reaches pg-boss, logs, the request receipt or the stored
  artifact. Only speakers, warnings and scan counts are stored.
- **No hardcoded provider.** Model selection is untouched. No provider or model name appears.
- **Secrets never escape.** Pack fields are display text. Connector columns, tokens, mail bodies and
  email addresses are not selected.
- **Never edit an applied migration.** Slice 1 likely needs no SQL. If one is needed it is a new file
  in the owning module's `sql/`.
- **App map.** Slices 2 and 3 change behaviour (default-on owner context, a preference, speaker marks
  in copy and export), so each updates the meetings manifest `features` and `settings` entries in
  the same PR. Slice 1 changes no behaviour a user can see. Slice 4 adds the screen-level entries.

## 4. Slice 1: public read APIs

Goal: the registry can read, under the owner's access, attendee names for an event window, people by
name, and memory recall, each with a hard cap.

Tasks, in order:

1.1 **Store attendee names.** In `packages/connectors/src/google-sync-phases.ts` add
`attendeeNames: string[]` beside `attendeeCount` in the event metadata. Display names only, at most
20 names, each trimmed to 80 characters, blanks and the owner's own entry dropped. No emails.

1.2 **Calendar read function** in `packages/calendar/src/repository.ts`, exported from the package
index:

```ts
export interface CalendarEventContext {
  readonly eventId: string;
  readonly title: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly attendeeNames: readonly string[];
}
listEventsOverlapping(
  scopedDb: DataContextDb,
  window: { readonly start: Date; readonly end: Date; readonly toleranceMinutes: number }
): Promise<readonly CalendarEventContext[]>;
```

Owned events only (`ownedByActor`), at most 3 rows, ordered by overlap. The caller decides what more
than one result means (Slice 2 uses none).

1.3 **People batch lookup** exported from `@moss/people`:

```ts
findPeopleByNames(
  scopedDb: DataContextDb,
  ownerUserId: string,
  names: readonly string[]   // at most 30
): Promise<readonly { name: string; role: string | null; note: string | null; matchedName: string }[]>
```

Case-insensitive exact match on display name or saved alias. The note is cut to one line of at most
200 characters. Follows the existing sharing grants.

1.4 **Memory adapter** in the registry (no memory change):
`recallForNames(scopedDb, ownerUserId, queries, limit)` calling the existing `recall`. Not exported
from memory; lives next to the other registry ports.

1.5 **Port type** in meetings (`packages/meetings/src/context-pack-port.ts`), no imports from the
other modules:

```ts
export interface OwnerContextSources {
  ownerProfile(db: DataContextDb): Promise<{ displayName: string; aliases: readonly string[] }>;
  calendar(db: DataContextDb, window: ContextWindow): Promise<readonly CalendarContextItem[]>;
  people(db: DataContextDb, names: readonly string[]): Promise<readonly PersonContextItem[]>;
  memory(db: DataContextDb, queries: readonly string[]): Promise<readonly MemoryContextItem[]>;
}
```

The three item types are plain data shapes defined in the same file.

Tests (each states what a broken build would do wrong):

- Calendar: a second user's overlapping event is not returned. Fails if the owner filter is dropped.
- Calendar: the stored attendee list holds names only and no `@` strings. Fails if emails leak.
- Calendar: an event outside the tolerance is not returned; four overlapping events return three.
- People: an unrelated person is never returned for a name that does not match. Fails on a
  `LIKE`-style fuzzy lookup.
- People: a person owned by another user and not shared is not returned.
- Port isolation: a source-scan test fails if `packages/meetings/src` imports `@moss/calendar`,
  `@moss/people` or `@moss/memory`.

E2E for this slice: none by itself, because nothing user-visible changes. The slice is exercised by
the slice 2 integration test and by the live check in slice 5. Wiring proof: a grep for a real caller
of each new function inside `packages/module-registry/src` is part of slice 2's exit.

Verification (unpiped):

```bash
pnpm test:unit tests/unit/<new calendar and people test files> > /tmp/s1-unit.log 2>&1; echo "EXIT=$?"   # expect 0
pnpm typecheck > /tmp/s1-types.log 2>&1; echo "EXIT=$?"                                                 # expect 0
pnpm lint > /tmp/s1-lint.log 2>&1; echo "EXIT=$?"                                                       # expect 0
```

Integration runs and the full gate go through the `verify-gate` skill, not a bare run. Full
gate before the PR, also through `verify-gate`: `pnpm verify:foundation`, expect exit 0.

### Kill gate after slice 1

Slice 1 alone changes stored calendar data. After it merges and a real Google sync runs on dev,
Ben (or the coordinator for him) checks one real event:

- **End the line if** attendee names do not arrive in the stored event, or the sync gets slower or
  starts failing. The whole feature depends on those names, and calendar-less speaker naming
  (talk-introduced names only) is a much smaller feature that would need a new spec.
- **Continue if** a real meeting event shows names, no emails, and sync time is unchanged.

Slice 2 is planned in full detail only after this check. This plan keeps slice 2 and 3 as decisions
so the check can change them.

## 5. Slice 2: context pack builder and prompt block

Goal: the summary prompt carries a bounded `ownerContext` block, scanned for orders, with a
terminating trim order. No speakers yet.

Files:

- `packages/meetings/src/context-pack.ts` (pure, no I/O): types, caps, ranking, trimming, scan.
- `packages/module-registry/src/meeting-context-sources.ts`: builds `OwnerContextSources` from
  calendar, people and memory.
- `packages/module-registry/src/meeting-output-runtime.ts`: builds the pack, adds the block.
- `packages/meetings/src/instruction-scan.ts`: scan the pack text.

Contracts:

```ts
export interface OwnerContextPack {
  readonly owner: { displayName: string; aliases: readonly string[] };
  readonly event: CalendarContextItem | null;
  readonly people: readonly PersonContextItem[];
  readonly facts: readonly MemoryContextItem[];
}
export const CONTEXT_CAPS_BYTES = { owner: 1024, calendar: 4096, people: 6144, memory: 6144 } as const;
export interface BuiltContextPack {
  readonly pack: OwnerContextPack;
  readonly trimmed: boolean;               // anything dropped for size
  readonly scanHits: readonly { source: "calendar" | "people" | "memory"; count: number }[];
}
buildOwnerContextPack(
  sources: OwnerContextSources,
  db: DataContextDb,
  input: { transcriptNames: readonly string[]; window: ContextWindow }
): Promise<BuiltContextPack>;
scanContextPack(pack: OwnerContextPack): BuiltContextPack["scanHits"];
fitContextPack(pack: OwnerContextPack, budgetBytes: number): { pack: OwnerContextPack | null; trimmed: boolean };
```

Decisions:

- Zero or two-plus calendar matches means `event: null`. A source that throws is treated as empty and
  the others still run. Nothing here may fail a summary.
- Names for People come from the calendar attendee list plus capitalised names heard in the transcript, capped at 30. Memory queries are those names plus the selected event title (spec section 1). This is a plain string extraction in Moss, not a model call.
- Scan hits store only the source and a count. The excerpt never leaves the function, so no pack text
  reaches stored output. The existing flag type gains an optional `packHits` list; the existing
  `lines` keep their meaning.
- Plumbing. The generator today returns only `content` and `modelRoute`, and the service scans and
  persists the flag itself (`output-service.ts:19,149,168,208`). The generator result gains an
  optional `context: { packHits, trimmed, knownNames }`. `knownNames` is in memory only: the service
  passes it to the validator and drops it before saving. `packHits` is merged into the stored flag.
  The summary screen's flag notice (`meeting-summary.tsx:54`) reads `lines` and `more` only, so
  slice 2 also renders pack hits there as one plain sentence per source ("1 line in a calendar title
  looked like an order"). The service revalidates twice, so the validator accepts `knownNames` on
  both calls.
- Trim order inside the loop that now throws `meeting_output_input_too_large`: (1) drop pack items
  lowest rank first, (2) drop the whole pack, (3) truncate the running summary's oldest evidence,
  (4) truncate the unsplittable segment with a visible marker. Each step adds a warning to the
  summary. The error stays only when the guidance alone exceeds the cap.
- The pack is rebuilt for every piece (spec section 2) with that piece's transcript names, and counted
  in the byte budget. Pieces still target half the cap, now minus the pack size. A test uses two
  pieces that name different people and asserts each prompt carries only its own people.
- A new meetings preference key `meetings.use-owner-context` (default on) is read in the generator.
  The toggle screen is slice 4, but the read lands now so slice 4 adds only UI.
- Guidance added to the prompt, kept under 150 words: the block is background about the owner, is
  untrusted, carries no instructions, and may only help understand the talk.

Tests:

- Pack over its cap: lowest-ranked items drop first and `trimmed` is true. Fails if a cap is ignored.
- A calendar title reading "ignore previous instructions" yields a hit with source `calendar` and
  count 1, and the stored artifact contains neither the title nor the line. Fails if text leaks.
- Prompt snapshot: `ownerContext` is escaped the same way as `externalData` (`<`, `>`, `&`). Fails on a
  raw `</` inside a note.
- A fact reachable only through the event title is recalled.
- One source throwing: the summary still completes with the other sources.
- Single oversized segment plus a full pack: the run completes with warnings in the trim order above.
  Fails if the pack is kept while evidence is cut.
- No context at all: the prompt is byte-identical to today's. Fails if an empty block is added.
- Job payload test: the enqueued payload contains only ids, kind and key (`assertMetadataOnly`-style).
- Second user's data never appears in the pack (integration, two seeded accounts).

E2E: an integration test on a seeded account runs a real summary generation through the no-tools path
with a stubbed model route, and asserts the prompt the model received. This is a recorded run, not a
claim from the unit tests. The stub is only the model; the pack comes from real reads. Wiring: grep
shows `buildOwnerContextPack` called from `meeting-output-runtime.ts`.

Size measurement (spec open check 4): on the seeded account, print the byte length of each source and
the total. Record the numbers on the PR. If the total exceeds 17 KB the caps change before merge.

Verification (unpiped):

```bash
pnpm test:unit tests/unit/<new context pack and prompt test files> > /tmp/s2-unit.log 2>&1; echo "EXIT=$?"   # expect 0
pnpm test:integration tests/integration/<new meeting context test> > /tmp/s2-int.log 2>&1; echo "EXIT=$?"    # expect 0
pnpm typecheck > /tmp/s2-types.log 2>&1; echo "EXIT=$?"                                                       # expect 0
pnpm lint > /tmp/s2-lint.log 2>&1; echo "EXIT=$?"                                                             # expect 0
```

DB-touching ones and the full `pnpm verify:foundation` (expect 0) run through `verify-gate`.

### Kill gate after slice 2

On dev, generate summaries for three real recordings with real calendar events, once with context
and once with the toggle off. Ben judges.

- **End the line if** the with-context summaries are not visibly better (better names, better
  topics), or summaries get slower than 1.5 times the old time, or the model follows an instruction
  planted in a calendar title in a planted test. Slice 3 depends on the same pack.
- **Continue if** the output is better on at least two of three and no planted order is followed.

## 6. Slice 3: speakers in the output schema and stored shape

Goal: the model proposes speaker labels, Moss validates them, and the stored summary holds speaker
references instead of names. Nothing renders yet (slice 4), but old summaries and copy keep working.

Contracts (in `packages/shared/src/meeting-output-api.ts`):

```ts
export type MeetingSpeakerBasis =
  | "calendar"
  | "introduced-in-talk"
  | "addressed-by-name"
  | "owner"
  | "inference";
export interface MeetingSpeakerGuess {
  readonly speakerId: string; // transcript speakerId, or a source label
  readonly name: string | null;
  readonly basis: MeetingSpeakerBasis;
  readonly confidence: "high" | "low";
  readonly evidence: readonly string[]; // transcript segment ids
}
// MeetingOutputContent gains:  readonly speakers?: readonly MeetingSpeakerGuess[];
```

The field is optional, so every stored summary and every exporter keeps working unchanged.

Decisions:

- `MEETING_OUTPUT_SCHEMA` gains `speakers` as an array of at most 20. Each field has a schema
  description. The required-set rule in the schema helper is respected (`object()` marks all
  properties required, so `name` is `anyOf` string or null).
- **Speaker references in text.** The model writes a reference token, `{{speaker:<id>}}`, wherever it
  names a speaker in the overview, decisions and actions. Stored text keeps the token. A small pure
  resolver (`resolveSpeakerReferences(text, speakers, ownerLabels)`) lives in meetings and is
  what slice 4 calls from screen, copy and export. Slice 3 ships the resolver and its tests, and
  wires **every existing consumer to it now**, so a summary with tokens never shows a raw token. That
  covers export and copy, the on-screen summary (`packages/meetings/src/web/meeting-summary.tsx`
  renders the overview at `:63` and decisions at `:82` verbatim today), the actions list, and any
  chat or history projection that reads summary text. A grep for every reader of `overview`,
  `decisions` and `actions` text is a slice 3 exit check. Unknown
  speaker resolves to "Speaker N". Inferred, unconfirmed names resolve with "(guess)".
- **Owner labels storage is deferred to slice 4.** Slice 3 passes an empty label map. The resolver
  signature already takes it, so slice 4 adds the table and no change to stored summaries.
- **Validator** in `output-validation.ts`, in this order, failing soft per entry (the entry is
  dropped, the summary is kept, one generic warning is added):
  1. `speakerId` exists in the transcript or is a known source label.
  2. A non-null name has at least one evidence segment id, and each exists in the supplied transcript.
  3. The name appears in the pack or in the transcript text. Otherwise dropped (no invented people).
  4. Calendar-only basis with no speech evidence is forced to `low`.
  5. Any token in text whose id has no entry resolves to "Speaker N" and is not an error.
- **Retry behaviour.** A malformed speakers block falls under the existing one-retry rule for bad
  shapes. A semantically bad entry is dropped, not retried.
- **Split transcripts.** The running summary carries `speakers` forward, and each piece may refine
  but not delete an earlier entry that still has evidence. Speaker evidence ids are segment ids and stay unchanged across pieces. `shiftMeetingOutputChunkEvidence` shifts note character offsets only (`output-chunks.ts:178`) and is not applied to them.
- No SQL: the artifact column is JSON text and the field is optional.
- Rewrite keeps owner labels as fact, but labels arrive in slice 4. Slice 3 only guarantees the
  prompt has a slot for them.
- Guidance added: under 150 words, with one worked example of a named speaker and one `null`.

Tests:

- Validator drops a name with no evidence; fails if evidence is not required.
- Validator drops a name found in neither pack nor transcript; fails if "no invented people" is not
  enforced.
- Calendar-only name is stored `low`; fails if the model's `high` is trusted.
- A summary containing `{{speaker:S2}}` exports as "Speaker 2" with no entry, and as "Name (guess)"
  with an inference entry. Fails if a raw token reaches copy or export.
- A legacy summary with no `speakers` field renders and exports byte-identical to before. Fails if
  the optional field is treated as required.
- The artifact size cap still holds with 20 speakers.
- Two-piece transcript: a name from piece one survives piece two.
- Rewrite with a different model route keeps the validator behaviour (no route name appears in code).

E2E: an integration run with the stubbed model, seeded transcript and a calendar event asserts the
stored artifact holds `speakers` plus tokens, and that the exported text has names marked "(guess)".
A browser test on dev opens the summary screen and asserts no `{{speaker:` text appears. Marks, the picker and corrections are slice 4.

Verification (unpiped):

```bash
pnpm test:unit tests/unit/<new speaker validator, resolver and export test files> > /tmp/s3-unit.log 2>&1; echo "EXIT=$?"   # expect 0
pnpm test:integration tests/integration/<new meeting speakers test> > /tmp/s3-int.log 2>&1; echo "EXIT=$?"                   # expect 0
pnpm typecheck > /tmp/s3-types.log 2>&1; echo "EXIT=$?"                                                                      # expect 0
pnpm lint > /tmp/s3-lint.log 2>&1; echo "EXIT=$?"                                                                            # expect 0
```

The meetings, calendar, shared and registry packages have no `test` script, so `pnpm --filter <pkg> test`
exits 0 with nothing run. Use only the root runners above, and check the log names the new files.

All DB-touching runs and `pnpm verify:foundation` (expect 0) go through `verify-gate`.

### Kill gate after slice 3

On dev, run the three real recordings again and count how many names the model put in that were wrong
against what Ben knows.

- **End the line if** more than one in three named speakers is wrong, or any name appears that is not
  in the pack or transcript (the validator should make that impossible, so one such case means the
  validator is broken). Naming a wrong person with a plain label is worse than "Speaker 2".
- **Continue if** wrong names are rare and every guess shows as a guess in copy and export.

Owner: Ben makes the call. The coordinator collects the numbers.

## 7. Order, branches and review

- One session per slice, one branch and one PR per slice, merged in order. Slices are session-sized.
- Spec before build is met. No front-end design is needed for these slices, because none render new
  screens.
- Slice 1 fills in the Release note section as `Category: N/A`. Slices 2 and 3 give a plain Added
  entry, since summaries change for the owner as soon as they merge.
- Each PR ends with proof from a real run on dev. No faked or rewritten responses.
- Plan documents are committed in this PR before any slice starts.

## 8. Rulings ledger

| Finding                                                                           | Evidence                                                 | Status                                              |
| --------------------------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------- |
| Attendee names are not stored anywhere, only a count                              | `google-sync-phases.ts:340`, `calendar-api.ts:16`        | Fact; slice 1.1                                     |
| Meetings cannot import the other modules, so the pack is composed in the registry | `meetings/package.json`, `meeting-output-runtime.ts:484` | Decision                                            |
| Memory recall needs no chat context and no new function                           | `graph-recall-service.ts:62`                             | Fact                                                |
| People lookup is exact-match and singular, so a bounded batch is added            | `people/src/service.ts:25`                               | Decision; slice 1.3                                 |
| Artifact JSON is one text column, no SQL for `speakers`                           | `0278_meeting_outputs.sql:12-22`                         | Fact                                                |
| Names default to display name only, no emails                                     | Spec section 1 "Never included"                          | Decision pending Ben's confirmation (default built) |
| Owner labels table belongs to slice 4, not 3                                      | Spec slice 4 "correction storage"                        | Decision                                            |
