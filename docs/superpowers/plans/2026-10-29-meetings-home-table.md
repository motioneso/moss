# Meetings home table — phase 1 plan (#3806)

Spec: `docs/superpowers/specs/2026-10-27-meetings-home-and-page-redesign.md`, Phase 1
only (Delivery slices, line 557). Mockup: `home-table.html`, approved by Ben
2026-10-27. This plan covers the home projection and table only.

Not in scope: Coming up, parallel panes, speakers and attendees storage,
anything sensitive-meeting related, playback. No Lock column and no Sensitive
type in this slice.

## Verified current state (seams check, this branch at origin/main)

- Transcript search already exists. Per-term matching over title, notes and
  transcript terms, intersected with the type filter:
  `packages/meetings/src/history-repository.ts:186`, type filter at `:213`.
  The web search box and type select already call it:
  `packages/meetings/src/web/meeting-history.tsx:44`.
- Recorded time already exists on recording metadata:
  `packages/meetings/sql/0335_meeting_recording_identity.sql:17`,
  `packages/meetings/src/recording-metadata.ts:33`. The history projection
  does not select it. It orders and pages by creation time:
  `packages/meetings/src/history-repository.ts:210`, `:222`.
- Recording length already exists for live capture as the latest capture
  grant duration: `packages/meetings/src/history-repository.ts:242`,
  bounded at write time by `packages/meetings/sql/0292_meeting_minimal.sql:16`.
  Imports store a duration in `metadata_json`
  (`packages/meetings/src/recording-import-repository.ts:34`) that came from
  the validated WAV header (`packages/meetings/src/recording-bundle.ts:74`).
  Nothing validates that value again when history reads it, so history must
  not trust it raw.
- The app header already owns the page title and the settings cog:
  `apps/web/src/shell/app-shell.tsx:685`. The Meetings page duplicates both:
  `packages/meetings/src/web/meetings-page.tsx:85`.
- Attendee storage does not exist. The spec settles this for phase 1: the
  Attendees column shows "—".
- No new public port is needed for this slice. Search, type, date and length
  all live inside Meetings or in the shared history contract. The Calendar,
  People, Tasks and playback ports belong to later slices and stay untouched.

## Collision check with #3777

- No open PR mentions #3777 or #3806 (checked 2026-10-29). Most #3777 work
  already reached main through merged PRs.
- The `feat/meetings-any-recording` branch still carries 54 commits not on
  main, but its changes against main touch none of the history or home files
  above. The only shared files are `packages/meetings/src/features.ts` and
  `packages/meetings/src/manifest.ts`, where its diff against main is 3 lines.
- Rule for this slice: rebase on origin/main before building, keep the
  app-map edits in those two files small and additive, and re-check the
  branch before pushing. If that branch lands first, rebase again rather
  than editing around it.

## Decisions

1. **Date.** Order and page by the recorded time when one exists, else the
   time the record was added. The row says which one it shows.
   - `MeetingHistoryItem` gains `date: { at: string; source: "recorded" | "added" }`.
     `createdAt` stays for existing callers.
   - History gets its own cursor, `MeetingHistoryCursor { id, dateAt }`, in
     `packages/shared/src/meeting-history-api.ts`. The records-list cursor
     (`MeetingRecordCursor`, `packages/shared/src/meeting-record-api.ts:16`)
     keeps its current meaning. Sort is the effective date descending, then
     ID descending, in the query, the cursor test and the `records` CTE
     alike. This is the one contract fork in the plan; the alternative
     (redefining the shared cursor's `createdAt`) was rejected because the
     records list still pages by creation time.
2. **Length.** Capture grant duration wins. Otherwise use the import
   duration only when it parses as an integer between 0 and 7,200,000 ms
   (the bound already enforced for capture in `0292_meeting_minimal.sql:16`).
   Anything else is unknown and shows "—". Transcript coverage is never
   shown as length. No migration is needed; both sources already exist.
3. **Table.** Replace the week-grouped row list with one semantic table:
   Title, Date, Length, Attendees, Type. Attendees always "—" in this
   slice. The summary gist line leaves the table; the title cell is the
   title only. Rows still open the existing meeting route through the same
   open handler, and the title stays keyboard-reachable. Search, type
   filter, Add recording and New meeting stay above the table and use the
   full content width. Week group headings go away because the Date column
   carries that information now.
4. **Header.** Delete the duplicate Meetings heading and Settings text link
   from the page body. Settings stays reachable only through the header
   cog. No new Settings link anywhere in the module.
5. **States.** Keep the existing loading, empty, no-results, retry,
   offline, access-denied and module-disabled behaviour, restated on the
   table layout. No explanatory copy is added to any screen.
6. **App map.** Update `meetings.history` in
   `packages/meetings/src/features.ts:262` so it describes the table,
   transcript search, recorded-versus-added date and honest length, with
   its existing errors. Update the Meetings navigation description in
   `packages/meetings/src/manifest.ts:101` if the wording no longer
   matches. No `app-map-core.ts` change: this slice changes no host-owned
   surface, and the header it relies on already exists there.

## Determinism boundary

This slice renders everything from stored records. It adds no model job,
no chat turn and no generated text. The two model jobs named in the spec
stay with their existing slices.

## Tasks

1. Shared contract: add the `date` field and `MeetingHistoryCursor` to
   `packages/shared/src/meeting-history-api.ts`, including the JSON schema
   for the cursor. Update the history fixture in
   `tests/unit/fixtures/meeting-history.ts`.
2. Projection: select recorded time and the validated import duration in
   `packages/meetings/src/history-repository.ts`; sort, cursor and
   early-limit by effective date; validate the new cursor in
   `validateMeetingHistoryInput`. Keep the per-term search and type
   intersection unchanged.
3. Table UI: rebuild `packages/meetings/src/web/meeting-history.tsx` as a
   semantic table using `@moss/ui` primitives only, with layout-only rules
   in `packages/meetings/src/web/styles.css`. Add date and length
   formatting to `packages/meetings/src/web/history-presentation.ts`.
   Remove the duplicate heading and Settings link from
   `packages/meetings/src/web/meetings-page.tsx`.
4. App map: update the declarations in Decision 6, same PR.
5. Tests below, then the live proof.

## Test cases (behaviour, and why each fails when broken)

- Recorded date wins: a record whose recorded time differs from its added
  time sorts and displays by the recorded time and labels it recorded.
  Fails if the projection still selects creation time.
- Fallback is labelled: a record with no recorded time displays its added
  time labelled as added. Fails if the fallback is silent.
- Stable paging: several records sharing one effective date page through
  with no repeats or gaps across two pages. Fails if the ID tie-break is
  missing from either the sort or the cursor.
- Bad cursor rejected: a malformed `dateAt` returns the existing invalid
  input error. Fails if the new cursor bypasses validation.
- Transcript-only search: words present only in a transcript segment find
  the meeting, combined with a type filter that excludes it returns
  nothing. Fails if search regresses to titles or if the type filter stops
  intersecting.
- Length honesty: capture duration shows; a valid import duration shows;
  a corrupt or out-of-range import duration and a record with neither show
  "—". Fails if raw import metadata or transcript span is trusted.
- Table semantics and opening: the home renders a real table with the five
  column headers, "—" attendees, and activating a title opens that
  meeting. Fails if the grouped list survives.
- No duplicate chrome: the page body contains no Meetings heading and no
  Settings link. Fails if Decision 4 is only half done.
- States: empty, no-results and error-with-retry each render on the table
  layout. Fails if a state was tied to the old list markup.

Unit and integration homes: `tests/unit/meeting-history-*.test.*`,
`tests/integration/meeting-history.test.ts`. Extend them; do not fork new
suites.

## Live proof

New UAT spec `tests/uat/specs/3806-meetings-home-table.uat.spec.ts`
(spec name `meetings-home-table-live`), plus a blocking row for
`packages/meetings/**` in `.claude/skills/coordinate/uat-trigger-map.tsv`.
It signs in on a live dev instance, creates recordings through the real
record and transcript endpoints, and asserts: a transcript-only word finds
the recording, the recorded date and its label show, an unknown length
shows "—", stable paging holds, and opening a row reaches the meeting.
Claim a port with `devports claim`, release it and stop the server after.

## Verification commands (unpiped, expected exit 0)

```bash
pnpm format:check > /tmp/3806-fmt.log 2>&1; echo "EXIT=$?"
pnpm lint > /tmp/3806-lint.log 2>&1; echo "EXIT=$?"
pnpm typecheck > /tmp/3806-type.log 2>&1; echo "EXIT=$?"
pnpm check:ui-classes > /tmp/3806-ui.log 2>&1; echo "EXIT=$?"
scripts/run-gate.sh start
scripts/run-gate.sh wait --follow
```

Local green excludes CI's e2e verdict; say which was verified.

## Kill gate

Owner: Ben. Phase 1 ships alone. If a real user cannot find a recording by
remembered transcript words, tell a recorded date from an added date, and
open it without duplicate chrome, stop and revise the home before any
phase-2 planning. If judging that needs attendees or Coming up, agree that
one dependency first; "—" is honest, placeholder names are not.

## Release note

Category: Changed. Plain-English line on the clearer meeting list, in the
PR template's Release note section.
