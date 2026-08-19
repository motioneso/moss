# Job Search Post-Onboarding UX Corrections — Implementation Plan

> **Status:** Approved — user-approved after independent Fable 5 review
> **Issue:** #1375 · child of #1280
> **Approved spec:** `docs/superpowers/specs/2026-07-30-job-search-post-onboarding-ux-corrections.md`
> **Review:** `docs/superpowers/research/2026-07-30-fable-5-job-search-plan-review.md`

**Goal:** Make the populated Job Search experience coherent, efficient to triage, accessible, and
honest about its current state, including showing the captured job description in match detail.

**Architecture:** Repair shared truth at three existing seams—score parsing before persistence,
action-result records after writes, and one shared board-bucket helper—then simplify the five
screens around those records. Job descriptions use the existing `Posting.body` column and existing
`match.get` read; one data-only migration invalidates legacy Fit values, but no schema migration or
second detail route is added.

**Tech stack:** TypeScript, external module worker/web runtime, Vitest, Playwright/Webwright,
Postgres integration tests.

## Global constraints

- Fit and Want remain independent. No combined score, recommendation number, or cross-axis cap.
- No phrase matching against model prose. Coherence comes from a strict structured field.
- `Posting.body` stays off `matches.list`; the list is render-capped and does not display it.
- No new dependency or schema migration. The single data-only Fit invalidation migration is
  idempotent and changes no table shape.
- No cards/Kanban rewrite, gradients, animation pass, or decorative AI motifs.
- Module CSS stays layout-only: no new `var(--...)`, font, color, or shadow declarations.
- Ordinary `profile_changes` writes use #1246’s install-time grant. Do not reintroduce routine
  permission requests.
- Preserve the auth-wall hard stop. LinkedIn description enrichment uses only the public guest
  detail endpoint and never signs in.
- Preserve #1333 paging and the #1330 one-match detail route. Extend them; do not create siblings.
- Keep every edited source/CSS file below the repository’s 1000-line gate.
- Use an isolated `JARVIS_PGDATABASE` for integration tests and live proof writes.
- Stage explicit paths only; never `git add -A`.

## Branch preparation

Implementation gets its own branch/worktree after this plan is approved:

1. Start `build/1375-job-search-ux-corrections` from the local `feat/job-search` tip (`5eaf9560` at
   review time), which includes the typed worker-refusal fix `b3ba0152`. This tip is local-only;
   resolve it from the local repository rather than assuming `origin/feat/job-search` is current.
2. Cherry-pick #1246’s implementation commits in order:
   `1a2b3648`, `05cd594c`, `e76e199d`.
3. Cherry-pick the local documentation range
   `e76e199d..research/1246-ui-critique`; this includes both evidence reports, the approved spec,
   the implementation plan, and the independent Fable 5 review.
4. Confirm a clean worktree and run the existing Job Search unit suites before changing code.

If `feat/job-search` advances before implementation begins, use its new tip and record the resolved
base in the issue. Do not silently omit the #1246 grants.

---

## Task 1 — Return and lazily enrich job descriptions

**Files:**

- Modify: `external-modules/job-search/src/adapters/linkedin.ts`
- Modify: `external-modules/job-search/src/adapters/freehire.ts`
- Modify: `external-modules/job-search/src/domain/records.ts`
- Modify: `external-modules/job-search/src/worker/handlers/matches.ts`
- Modify: `external-modules/job-search/src/worker/registry.ts`
- Modify: `external-modules/job-search/src/worker/store-sql.ts`
- Modify: `external-modules/job-search/src/web/board-types.ts`
- Test: `tests/unit/job-search-adapter-linkedin.test.ts`
- Test: `tests/unit/job-search-match-handler.test.ts`

**Behavior:**

- Export and reuse freehire’s existing HTML-to-plain-text helper; do not add another parser.
- Add one LinkedIn helper that fetches
  `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/{externalId}`, rejects auth walls and
  non-success statuses with the adapter’s existing failure vocabulary, extracts the public
  description container, and returns normalized plain text.
- Extend `createMatchGetHandler` with the existing `FetchLike` bridge. When `posting.body` is empty
  and `sourceId === "linkedin"`, fetch the description once, upsert the same posting with its body,
  and return it. A non-empty stored body performs no network request.
- Treat the network read and idempotent posting-body upsert as a documented public cache-fill
  exception inside the existing `risk: "read"` tool. Give the fetch a short timeout with headroom
  before `ctx.deadlineAt`; a timeout degrades to an empty body rather than killing detail.
- A failed enrichment still returns the match with `body: ""`; it does not turn a usable inspector
  into a generic match-load error or change portal health. Record a 24-hour retry-suppression
  timestamp in the existing user-scoped module KV; do not add a column, portal cause, or cache
  service.
- Cap every body at the shared storage boundary with `BODY_MAX_CHARS`, sized against the platform's
  16 000-character rendered-result limit with every other detail field at maximum. The handler also
  returns the bounded value defensively.
- Add `body` and `scoredAt` to worker and web `MatchDetail`. Keep both off `BoardMatch`.

**Checks:**

- [ ] Write failing adapter tests for public detail HTML, entity decoding, auth wall, non-2xx, and
      missing description.
- [ ] Write failing handler tests for stored body, one-time LinkedIn enrichment/persistence,
      non-LinkedIn empty body, timeout/failure fallback, 24-hour retry suppression, no portal-state
      mutation, and harmless concurrent double-open convergence.
- [ ] Add a worst-case `match.get` render-survival test with body, reasons, and identity fields at
      their caps; assert the full structured result remains below 16 000 characters.
- [ ] Implement the smallest passing adapter/handler changes.
- [ ] Run:
      `pnpm vitest run tests/unit/job-search-adapter-linkedin.test.ts tests/unit/job-search-match-handler.test.ts`
- [ ] Commit the task’s files explicitly.

---

## Task 2 — Make Fit classification coherent and refit legacy rows

**Files:**

- Modify: `external-modules/job-search/src/domain/score.ts`
- Modify: `external-modules/job-search/src/worker/stages/score.ts`
- Modify: `external-modules/job-search/src/web/keyline.tsx`
- Add: `external-modules/job-search/sql/0009_invalidate_legacy_fit_scores.sql`
- Test: `tests/unit/job-search-score.test.ts`
- Test: `tests/unit/job-search-score-stage.test.ts`
- Test: `tests/unit/job-search-keyline.test.tsx`
- Test: relevant isolated-DB module migration suite

**Behavior:**

- Add strict `fitDisposition` validation for:
  `supported | insufficient_evidence | domain_mismatch | dealbreaker`.
- Require the field in `SCORE_SCHEMA` and scoring instructions. Unknown fields remain rejected.
- Move the existing Fit band minimums to one exported domain constant used by both `fitBand` and
  score normalization. Derive caps from the next band boundary rather than hand-copying `84`/`39`.
- Normalize before `upsertMatch`: supported is unchanged; insufficient evidence stays below Strong;
  domain mismatch and dealbreaker stay below Fair.
- Preserve the model’s Fit reason and the original Want value/reason exactly.
- A missing or invalid disposition fails the entire score with no partial write.
- Add one idempotent data-only module migration that sets legacy non-null Fit values to `NULL`
  without touching Want, reasons, state, or posting data. The existing `unfitted` repair pass then
  drains that backlog within its current AI budget and deadline. Do not add a candidate mode,
  queue, column, or runtime marker.

**Checks:**

- [ ] Add failing parser/schema tests for every value, missing field, unknown value, and continued
      rejection of combined-score fields.
- [ ] Add failing stage tests proving both caps reach `upsertMatch`, a lower model Fit is not raised,
      and Want never changes.
- [ ] Add an isolated-DB migration test proving legacy Fit is cleared while Want, reasons, and state
      survive, and that rerunning the statement is harmless.
- [ ] Add a pass-level test proving the existing `unfitted` path rescores an invalidated row and
      leaves no-résumé profiles unscored.
- [ ] Implement in `score.ts` and the single persistence path in `runScore`.
- [ ] Run:
      `pnpm vitest run tests/unit/job-search-score.test.ts tests/unit/job-search-score-stage.test.ts`
- [ ] Commit explicitly.

---

## Task 3 — Render durable, user-readable action outcomes

**Files:**

- Modify: `packages/ai/src/gateway/gateway.ts`
- Modify: `packages/chat/src/gateway-notifier.ts`
- Modify: `packages/chat/src/live/chat-session-manager.ts`
- Modify: `packages/chat/src/live/types.ts`
- Modify: `packages/chat/src/repository.ts`
- Modify: `packages/chat/src/route-serializers.ts`
- Modify: `apps/web/src/chat/use-chat-stream.ts`
- Modify: `apps/web/src/chat/message-row.tsx`
- Modify: Job Search state-changing handlers under
  `external-modules/job-search/src/worker/handlers/`
- Add: `tests/unit/gateway-action-result-invalidation.test.ts`
- Test: `tests/unit/chat-drawer-activity.test.tsx`
- Test: relevant Job Search handler suites
- Test: `tests/e2e/chat-drawer.spec.ts`

**Behavior:**

- Enumerate every gateway `action_result` emission at implementation time. Every successful
  execution site attaches the existing bounded/sanitized result data; failures and denials carry no
  arbitrary handler output.
- State-changing Job Search handlers return a capped `statusText`, for example:
  `LinkedIn monitoring enabled`, `Criteria updated`, or `Résumé saved`.
- `toTranscriptRecord` uses safe `statusText` when present and falls back to the existing
  tool-name outcome.
- `action_result` is removed from the collapsed activity group and rendered as a compact status
  row with executed/denied/error semantics.
- During a live turn, `ChatSessionManager` retains only capped, module-authored action-result
  text/outcome and passes it to `recordCompletedTurn`. Store that small array in the assistant
  message’s existing `tool_metadata` JSONB; do not add a column or migration and do not persist the
  full result.
- The existing history serializer reconstructs `action_result` activity records from that metadata,
  so `recordsFromMessages` receives the same short terminal rows after reload.
- Keep `affectsQueryKeys` invalidation unchanged.

**Checks:**

- [ ] Add failing gateway tests for every enumerated success path plus proof that every denial/error
      path attaches no result.
- [ ] Add failing rendering tests for visible executed/denied/error rows and absence from “Behind
      the scenes.”
- [ ] Add a history-reload test proving the short terminal outcome survives while structured
      result data does not.
- [ ] Add Job Search handler tests for accurate `statusText`.
- [ ] Run the focused unit suites and `tests/e2e/chat-drawer.spec.ts`.
- [ ] Commit core and module files together because the wire change is not useful half-landed.

---

## Task 4 — Share board buckets and add compact client-side filters

**Files:**

- Modify: `external-modules/job-search/src/web/board-types.ts`
- Add: `external-modules/job-search/src/web/screens/board-filters.tsx`
- Modify: `external-modules/job-search/src/web/screens/board.tsx`
- Modify: `external-modules/job-search/src/web/styles-board.css`
- Test: `tests/unit/job-search-web-board.test.tsx`
- Test: `tests/unit/job-search-overview.test.tsx`

**Behavior:**

- Move bucket membership to one exported helper:
  unreviewed = unscored/new, saved = seen, passed = dismissed.
- Rename the New bucket to Unreviewed.
- Add one filter component containing title/company search, location, posting age, Fit band, and
  source. Filtering is client-side over the already-loaded whole board.
- Filters combine with bucket and existing one-axis sort. Show active-filter count and Clear.
- Posted-age comparison uses one captured `Date.now()` value passed into the pure filter function;
  rendering remains free of ambient relative-date copy.
- If `readWholeBoard` reports `truncated: true`, keep filtering the loaded rows but show a plain
  notice that filters and counts apply only to those loaded roles.
- Extract the filter component rather than pushing `board.tsx` past 1000 lines.

**Checks:**

- [ ] Add failing pure-filter tests for each field, combined filters, unknown dates, unscored Fit,
      Clear, and a fixture larger than the 25-row page size.
- [ ] Add a failing truncated-board test proving the limitation is visible and never described as
      the whole board.
- [ ] Add failing count tests proving Matches and Overview use the same Unreviewed helper.
- [ ] Implement the helper/component and minimal layout CSS.
- [ ] Run:
      `pnpm vitest run tests/unit/job-search-web-board.test.tsx tests/unit/job-search-overview.test.tsx`
- [ ] Commit explicitly.

---

## Task 5 — Add row decisions and preserve board position

**Files:**

- Modify: `external-modules/job-search/src/web/screens/match-row.tsx`
- Modify: `external-modules/job-search/src/web/screens/board.tsx`
- Modify: `external-modules/job-search/src/web/styles-board.css`
- Test: `tests/unit/job-search-web-board.test.tsx`
- Test: `tests/unit/job-search-web-board-inspector.test.tsx`
- Test: `tests/uat/specs/job-search-board.uat.spec.ts`

**Behavior:**

- Add Save and Pass buttons to each undecided row with a real match id, using the existing
  match-state queue and reconciliation callbacks. Synthetic `unscored` rows render neither action.
- Button activation must stop row-open activation. Accessible names include the role title.
- Before opening the inspector, retain scroll position, row id, and focused element.
- Back restores scroll and focus. Save/Pass from the inspector restores the nearest valid row when
  the original moved buckets or disappeared.
- Use browser-native focus/scroll APIs and refs; no navigation store or router abstraction.

**Checks:**

- [ ] Add failing unit tests for row-action event isolation, callback shape, and absence on
      synthetic `unscored` rows.
- [ ] Add failing browser/UAT coverage for opening deep in the list, Back restoration, inspector
      Save/Pass restoration, and keyboard focus.
- [ ] Implement with the smallest refs/effect state in `BoardScreen`.
- [ ] Run both unit suites and the focused UAT spec.
- [ ] Commit explicitly.

---

## Task 6 — Rebuild the inspector around the description and evidence

**Files:**

- Modify: `external-modules/job-search/src/web/screens/inspector.tsx`
- Modify: `external-modules/job-search/src/web/styles-board.css`
- Test: `tests/unit/job-search-web-board-inspector.test.tsx`

**Behavior:**

- Remove the old “doesn’t store the full posting text” paragraph.
- Render one readable column: identity/link, Job description, axis definition, Fit/reason,
  Want/reason, scored time, decisions.
- Render `Job description unavailable` only when `body` is empty.
- Keep the original link in the header as a secondary source link.
- Keep company, source, posting date, and location sourced from the selected `BoardMatch` row; do
  not widen the detail payload for metadata already present there.
- Render Want as `N/100`; retain the Fit band and separate reasons.
- Make the role title `h2`.
- At mobile widths, account for the fixed shell header so Back and metadata are visible.

**Checks:**

- [ ] Add failing tests for stored body, unavailable fallback, absence of the old blurb, `N/100`,
      scored time, heading level, and unchanged queued copy.
- [ ] Replace the two-column/empty-column CSS; do not add a rich-HTML renderer.
- [ ] Run `pnpm vitest run tests/unit/job-search-web-board-inspector.test.tsx`.
- [ ] Commit explicitly.

---

## Task 7 — Make Overview operational and counts coherent

**Files:**

- Modify: `external-modules/job-search/src/web/screens/overview.tsx`
- Modify: `external-modules/job-search/src/web/root.tsx`
- Modify: `external-modules/job-search/src/web/styles-screens.css`
- Test: `tests/unit/job-search-overview.test.tsx`
- Test: `tests/unit/job-search-web-root.test.tsx`

**Behavior:**

- Delete the completed-setup hero, readiness-gate aside, and full checkpoint rail from active
  Overview.
- Lead with Unreviewed, scored, queued, last successful source check, and source issues.
- Add one Review unreviewed roles action that switches the parent view to Matches.
- Reduce completed setup to one quiet status line. Keep actionable blockers only.
- Use `Checks automatically`; do not invent next-run time or cadence.

**Checks:**

- [ ] Rewrite tests first to assert operational facts and the shared Unreviewed count.
- [ ] Test the Review action switches views without a second navigation system.
- [ ] Assert setup ceremony and “ready to run” copy are absent in active and paused states while
      actionable blockers remain.
- [ ] Run both focused suites.
- [ ] Delete now-unused helpers/CSS in the same commit.

---

## Task 8 — Make Profile field-led with an explicit correction path

**Files:**

- Modify: `external-modules/job-search/src/web/screens/profile.tsx`
- Modify: `external-modules/job-search/src/web/root.tsx`
- Modify: `external-modules/job-search/src/web/styles-screens.css`
- Test: `tests/unit/job-search-profile.test.tsx`
- Test: `tests/unit/job-search-web-root.test.tsx`

**Behavior:**

- Remove the repeated eyebrow/display-title/strap hero.
- Lead with criteria fields and résumé state.
- Add `Change in chat` beside criteria. It uses the existing profile-scoped assistant handle,
  seeds a plain editable composer prompt, and does not auto-send.
- Keep résumé replacement and briefing-detail controls.
- No new criteria form, queue, or permission path.

**Checks:**

- [ ] Add failing tests for field-first ordering, Change in chat composer seeding, and no automatic
      submission.
- [ ] Assert the old hero structure is absent.
- [ ] Run focused Profile/root tests.
- [ ] Commit explicitly.

---

## Task 9 — Make Monitors control-led and accessible

**Files:**

- Modify: `external-modules/job-search/src/web/screens/settings.tsx`
- Modify: `external-modules/job-search/src/web/styles-screens.css`
- Test: `tests/unit/job-search-web-settings.test.tsx`

**Behavior:**

- Remove the repeated ceremonial hero and lead with watched-board controls.
- Replace “every morning” with `Checks automatically`.
- Keep Run now as a conventional button in a separate group.
- Give the switch visible `{label} monitoring` text and accessible name
  `Enable {label} monitoring`.
- Keep Enabled/Paused/Disabled as status, separate from the switch label.

**Checks:**

- [ ] Add failing accessible-name and copy tests.
- [ ] Assert Run now and the switch are separate labelled controls.
- [ ] Preserve optimistic toggle and structured cause behavior.
- [ ] Run the focused settings suite.
- [ ] Commit explicitly.

---

## Task 10 — Make navigation and headings honest

**Files:**

- Modify: `external-modules/job-search/src/web/root.tsx`
- Modify: `external-modules/job-search/src/web/screens/board.tsx`
- Modify: `external-modules/job-search/src/web/screens/overview.tsx`
- Modify: `external-modules/job-search/src/web/screens/profile.tsx`
- Modify: `external-modules/job-search/src/web/screens/settings.tsx`
- Test: affected Job Search web suites

**Behavior:**

- Remove `tablist`/`tab` roles from profile, view, and bucket navigation.
- Use ordinary buttons with `aria-current` for the selected destination.
- Keep Job Search as the only `h1`; screen and inspector titles begin at `h2`.
- Do not add roving-focus state.

**Checks:**

- [ ] Add failing semantic tests before markup changes.
- [ ] Run all Job Search web unit suites.
- [ ] Run the repository accessibility check if available.
- [ ] Commit explicitly.

---

## Task 11 — Integrated verification and live dev proof

**Automated gate:**

- [ ] `pnpm prettier --check` for every changed TS/TSX/JSON/Markdown file.
- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] All Job Search unit suites.
- [ ] Focused gateway/chat unit and e2e suites.
- [ ] Job Search integration tests against an isolated database.
- [ ] `pnpm verify:foundation`
- [ ] `git diff --check`
- [ ] Confirm module CSS contains no new `var(--...)` and all edited files are below 1000 lines.

**Browser proof:**

- [ ] Build, restage, restart API, re-enable, and restart the worker using the established external
      module redeploy procedure.
- [ ] Before and after redeploy, verify exactly one worker process group.
- [ ] At 1280 × 1800, prove description text, filters, row Save/Pass, operational Overview,
      field-led Profile, control-led Monitors, and visible chat outcomes.
- [ ] At 390 × 844, prove inspector fixed-header clearance, no horizontal overflow, and labelled
      controls.
- [ ] Open a match from deep in the list and prove Back restores scroll and focus.
- [ ] Enable/disable a source through chat and prove the terminal result agrees with Monitors after
      reload.
- [ ] Open an existing empty-body LinkedIn match and prove the description is fetched, displayed,
      persisted, and reused on the second open.
- [ ] Prove a failed LinkedIn detail fetch is suppressed for 24 hours and does not change the
      portal's health.
- [ ] Prove a pre-existing contradictory match is invalidated, enters the existing `unfitted`
      backlog, and returns with a coherent Fit band while Want is unchanged.

**Closeout:**

- [ ] Record commands, exit codes, assertions, and bounded live observations in the issue/PR.
- [ ] Update relevant Job Search docs if implementation changes a named contract.
- [ ] Commit any verification documentation explicitly.
- [ ] Push the build branch and open/update the PR only after all required gates are green.

## Completion boundary

The slice is complete only when every success criterion in the approved spec is proven. A visually
improved screen with contradictory scores, stale action status, missing descriptions, broken
continuity, or inaccessible controls is not a partial completion of this issue.
