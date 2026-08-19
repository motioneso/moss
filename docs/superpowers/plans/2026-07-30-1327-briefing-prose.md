# Plan — surface Today briefing prose (#1372 Task 5)

## Scope

Update the existing Today prose gap only. Morning prose is resolved from the existing definitions
and runs API; evening primary prose becomes complete text while the compact day-mode tile keeps its
existing 220-character summary. No briefing composition, persistence, contracts, API routes, or
action-row work.

## Seams and current state

- `apps/web/src/today/today-page.tsx:116-136` loads definitions and evening runs, but has no
  morning definition/run query. The main column starts with “Start here” at `:332`, while the
  compact evening tile is rendered at `:539`.
- `apps/web/src/today/evening-mode.tsx:119-173` renders freshness and compact prose only; the
  primary “What happened today” card has no summary body. `compactSummary()` at `:280-284` is the
  existing 220-character cut to preserve for compact mode.
- `apps/web/src/today/briefing-freshness.tsx:60-76` provides the required stale-banner parser and
  renderer.
- Existing tokenized styles already provide `.jds-brief__body` in
  `apps/web/src/styles/components-jarvis.css:447-453` and `.agenda-clear` in
  `apps/web/src/styles/kit-today-misc.css:290-299`; extend only if paragraph-preserving prose
  needs authored spacing.
- The spec's named evening test already exists at `tests/unit/today-evening-mode.test.tsx`; its
  old assertion that primary prose is absent will be deliberately replaced, not weakened. The
  morning test file is absent and will be added as specified.

## Implementation

1. Add the morning definition query and same-local-day morning run resolution in `TodayPage`, using
   `listBriefingDefinitions`, `listBriefingRuns`, `queryKeys.briefings.runs`, `findDefinition`, and
   the existing local-time helpers. Render the morning prose card only when its definition is
   enabled, immediately before “Start here”; keep it present with the authored loading state while
   its definition/run data is pending, and use the authored empty state for a missing/blank run.
2. Update `EveningReviewSection` so the primary card renders the complete `summaryText` as authored
   text with paragraphs preserved, freshness above the prose, and the existing empty/loading states.
   Leave `compactSummary()` exclusively on the compact tile and keep its existing feedback behavior.
3. Reuse existing `.jds-brief__*`, `.jds-brief__body`, `.agenda-clear`, and freshness styles; add no
   raw colors, new fonts, or new UI primitives.
4. Add `tests/unit/today-briefing-prose.test.tsx` for morning ordering, full text, loading, empty,
   disabled, and stale states. Update `tests/unit/today-evening-mode.test.tsx` to prove full primary
   prose, stale/empty/loading behavior, and that only the compact tile applies the 220-character
   cut. Seed each definition's run query with real `BriefingRunDto` data in the render helper.

## Verification

- Targeted tests: `pnpm vitest run tests/unit/today-briefing-prose.test.tsx tests/unit/today-evening-mode.test.tsx`.
- Formatting: `npx prettier --write apps/web/src/today/today-page.tsx apps/web/src/today/evening-mode.tsx apps/web/src/styles/components-jarvis.css apps/web/src/styles/kit-today-misc.css tests/unit/today-briefing-prose.test.tsx tests/unit/today-evening-mode.test.tsx` (only files changed).
- Full gate: export a fresh isolated `JARVIS_PGDATABASE`, then run `pnpm verify:foundation`; do not
  run any DB/test command against a shared or live database.
- Live proof: exercise a real dev instance through the UI and record concise DOM/network/log
  walkthrough of the morning prose card and evening recap on the PR; otherwise report
  code-complete, unverified.
