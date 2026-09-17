# Visual parity plan: Today and the daily briefings, 1:1 with the approved mockups

Revision: VP-PLAN-R1 (2026-09-16; approved by Ben with the collapsible-sidebar amendment, now in P1). Feature: #2521. Spec: `../specs/2026-09-16-visual-parity.md` (VP-SPEC-R2).
Status: approved by Ben on 2026-09-16. P0 merged via PR #2522; P1 is next.

Correction carried into the spec (R1): the assets folders hold 32 mockup PNGs, not 34 (the
other two files are the study's `checks.json` manifests). All 32 are assigned exactly once below.

## 1. Shape of the work

1.1 Nine sequential slices P0 to P8. P0 builds the measuring tools; P1 to P8 each own one visual
surface and every mockup that shows it. A slice merges only when its captures pass the spec's
pixel-diff acceptance (section 8 of the spec) and the shared-page guards show no drift.
1.2 Order follows shared ownership. The nav frames every Today capture, so it lands first. The
Today page frames the two dialogs' entry points. The morning reader shell frames the review
tab. The evening frame frames its steps.
1.3 One record per slice, one PR per record, same gates as before (review, CI, static, Chromium,
UAT) plus the new visual leg from P0 onward.

## 2. Slices

| Slice | Surface                                                                        | Mockups owned                                                                                                             | Count |
| ----- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ----- |
| P0    | Parity tooling and shared fixture                                              | none (baseline diff report of all 32)                                                                                     | 0     |
| P1    | App-wide shell navigation                                                      | none in full; the nav strip region of morning-1440-news and the top bar region of every 375 Today capture                 | 0     |
| P2    | Today morning frame: hero, weather, section links, timeline, quick-action rail | today: morning-1440-opening, morning-375-opening, morning-1440-opening-weather, morning-375-opening-weather               | 4     |
| P3    | Today evening state                                                            | today: evening-1440-opening, evening-375-opening                                                                          | 2     |
| P4    | News and Sports sections                                                       | today: morning-1440-news, morning-375-news, morning-1440-sports, morning-375-sports                                       | 4     |
| P5    | Morning reader shell and Read tab                                              | morning: 1440-automatic-read, 375-automatic-read, 1440-proposed-read, 375-proposed-read, 1440-news, 375-sports            | 6     |
| P6    | Morning Review tab                                                             | morning: 1440-automatic-review, 375-automatic-review, 1440-proposed-review, 375-proposed-review, partial-review           | 5     |
| P7    | Evening planning frame and step 1                                              | evening: 1440-0, 375-0                                                                                                    | 2     |
| P8    | Evening steps 2 to 4 and saved states                                          | evening: 1440-1, 1440-2, 1440-3, 375-1, 375-2, 375-3, changed-plan-review, changed-plan-saved, changed-plan-handoff-phone | 9     |

Total 32.

## 3. Common to every slice P1 to P8

3.1 Captures: every owned mockup gets a populated capture and diff at
`workspace/evidence/visual-parity/<slice>/<mockup-name>.png` and `.diff.png`, taken by the
P0 probe with the P0 fixture, in the light theme, and the PR body lists each pair by path.
3.2 Acceptance: Reviewer walks the spec's eleven-point checklist per pair; Prover reports the
diff percentage per file (at most 0.5 percent outside masked text, positions within 2 px).
Any visible difference outside spec section 6 is blocking.
3.3 Guard captures: one populated capture of each shared page the slice's files serve, at 1440
and 375, compared with the same capture on the slice's base. Pages: Tasks, Calendar,
Settings, Chat for shell files; every other Today state for Today files; the other tab for
dialog files. A guard diff above 0.5 percent that the PR body does not explain is blocking.
3.4 Dark and canyon: Today opening and each dialog at 1440, contrast of body and lede text at
least 4.5, one capture each.
3.5 Behaviour regressions: the T01 to T22 unit and e2e suites in the V8 static command stay
green; the T20/T21 UAT copies rerun unchanged for any slice touching a dialog; every
accessible name, role and keyboard path named in the V1 to V8 records survives, and the
slice's record lists them.
3.6 Legacy removal: rules and markup that the mockup contradicts are deleted in the slice, the
ui-classes scan list is updated, and the PR body names each deleted class.
3.7 Static command: the V8 one (`moss-v8-task-record.md` lines 172 to 186) plus the slice's
new unit test and `tests/e2e/visual-parity.spec.ts`.
3.8 Proof legs: review, ci, static, chromium, uat (where 3.5 applies) and visual. The visual leg
is the P0 probe run by Prover with receipts under `proofs/<slice>/`.

## 4. Slice detail

P0 Parity tooling and shared fixture

- Delivers: (a) `tests/e2e/visual-parity.spec.ts` plus a helper that reproduces the study's
  capture regions exactly (spec section 3.1), masks generated-text regions by data attribute,
  writes the capture and the diff, and fails above the tolerance; (b) one fixture seed for all
  surfaces (spec section 5), built on the existing e2e fixture fetch seam
  (`resolveE2eFetchOverride`, `createE2eFixtureFetch` in
  `apps/worker/src/external-module-job-handler.ts`) and the API-side `fetchFn` added in V4 R4,
  with fixed clocks 08:00 and 20:00 local; (c) light-theme token corrections in
  `apps/web/src/styles/tokens.css` where the V0 mapping table and the study's `tokens.css`
  disagree, with the table corrected in the record; (d) Archivo Black if the study's display
  weight is not covered by the self-hosted 900 weight.
- Evidence: a baseline diff report of all 32 mockups on the P0 head, expected red, proving the
  probe measures. Guard: Tasks, Calendar, Settings at 1440 and 375 unchanged.
- Files: the new spec and helper under `tests/e2e/`, fixture files under `tests/fixtures/`,
  `tokens.css`, `apps/web/public/fonts/archivo/` if (d) applies, `scripts/check-design-tokens.ts`
  only if a new token needs registering.
- Regressions: all suites green; the V4 seam unit test still proves the seam is opt-in and
  host-scoped.

P1 App-wide shell navigation

- Target: study `.app-nav` (194 px, pale sage, 1 px right line, 31/17 padding, item list with
  5 px gap, selected item forest on bone with 3 px radius, 168 px below 1180, hidden below 920
  behind the phone top bar). Keep the V1 phone top bar behaviour. The sidebar stays collapsible
  (spec 9.2): a `<<` control beside the logo area collapses it to the V1 icon rail restyled in
  the same pale palette, the control becomes `>>`, names stay "Collapse navigation" and
  "Expand navigation", the preference is remembered. P1 owns the collapsed look, derived from
  the study nav (same colours and selected treatment at rail width), since no mockup shows it.
- Mockup regions: x 0 to 194 of morning-1440-news; y 0 to 64 of every 375 Today capture.
- Files: `apps/web/src/shell/shell-nav.tsx` (290), `app-shell.tsx` (515), `kit-shell-nav.css`
  (70), nav storage, `tokens.css` for `--nav-w`. Also fixes the Tasks toolbar 5 px overflow at
  375 in the Tasks kit stylesheet (named extra file).
- Guard: Tasks, Calendar, Settings, Chat, Today at 1440 expanded, 1440 collapsed, 1180, 920, 375. Regressions: V1 nav unit and e2e tests; keyboard order through the nav unchanged;
  collapse, reload, expand round trip.

P2 Today morning frame

- Target: hero band, headline and summary, prepared-time line, weather row, section jump row,
  preparation timeline rows, quick-action rail, in the study's `.hero`, `.briefing-grid`,
  timeline and rail rules. Includes the Meds dialog Escape-close and focus return (opened from
  the rail) and the extra section headings the mockup lacks.
- Files: `today-page.tsx` (654, split allowed), `today-hero.tsx`, `today-rail.tsx`,
  `module-today-widgets.tsx`, `day-plan.tsx` (timeline rows), `kit-today.css`,
  `kit-today-hero.css`, `kit-today-timeline.css`, `kit-today-misc.css`,
  `packages/ui/src/styles/components-moss-today.css` (757; delete superseded rules).
- Guard: the evening Today state, News and Sports at 1440 and 375 (P3 and P4 not yet done, so
  compared with base). Regressions: V2 and V3 unit and e2e tests, T22 surfaces after reload.

P3 Today evening state

- Target: recap, unresolved commitments, tomorrow's shape, Plan tomorrow entry, as in the
  study's evening mode of the same frame.
- Files: `evening-mode.tsx` (376), `today-page.tsx`, `kit-today-misc.css`, `today-labels.ts`.
- Guard: morning Today state unchanged from P2's accepted captures. Regressions:
  `today-evening-mode.test.tsx`, `evening-prep.spec.ts`.

P4 News and Sports sections

- Target: lead photo and story, secondary stories, four compact scores with followed teams
  first, photo recap, Tonight, section rules and eyebrows, per study revision 2 rules
  (`study.css` line 307 onward). Fixes the followed-team card image 404.
- Files: the two module `today-widget.tsx` files, `news-desk.tsx` (68, delete if dead),
  `kit-today-feeds.css`, `kit-today-desks.css`, `packages/sports/src/web/today-scores.tsx`.
- Guard: P2 and P3 captures unchanged. Regressions: V4 tests, seam unit test, `sports` and
  `news` opt-out e2e cases.

P5 Morning reader shell and Read tab

- Target: green branded header, title, tabs, prepared-at line, narrative lead, overnight
  callout, two-column report with schedule rail, phone disclosure, footer with status strip,
  news and sports link treatment, per `morning-briefing.css` and the shared dialog rules in
  `evening-plan.css`. Fixes the reader footer back slot at 200 percent zoom, the V5 rail
  heading follow-up and the shared phone viewport cap.
- Files: `morning-briefing.tsx` (419), `briefing-report-shell.tsx` (237),
  `kit-briefing-reader.css` (306), `today-page.tsx` for the open path only.
- Guard: Review tab at 1440 and 375 compared with base; evening dialog unchanged. Regressions:
  `briefing-report-shell` unit and e2e, `morning-briefing.test.tsx`, T22 UAT surfaces.

P6 Morning Review tab

- Target: proposed rows, accept controls, checked and pending states, partial status strip,
  bulk accept, per the review mockups.
- Files: `day-plan-review.tsx` (285), `day-plan-review-row.tsx` (176),
  `kit-day-plan-review.css` (156), `briefing-action-rows.tsx`.
- Guard: Read tab unchanged from P5. Regressions: `day-plan-review.test.tsx`,
  `briefing-action-rows.spec.ts`, T20/T21 UAT.

P7 Evening planning frame and step 1

- Target: header with eyebrow and message, numbered step navigation, Moss prompt line,
  reflection choices, tomorrow rail, persistent footer, per `evening-plan.css`. Removes the
  section headings the mockup lacks (the V7 and V8 F3 question, settled by the spec: no
  heading). Adds the day selector so the rail shows tomorrow's events, with a regression test
  that fails on base.
- Files: `evening-planning.tsx` (241), `evening-planning-sections.tsx` (356, split allowed),
  `kit-evening-planning.css` (316, split allowed), `day-plan-view-model.ts` for the day
  selector, `today-labels.ts`.
- Guard: steps 2 to 4 at 1440 and 375 compared with base; morning dialog unchanged.
  Regressions: `evening-planning.test.tsx`, `evening-planning-frame.test.tsx`, T20/T21 UAT.

P8 Evening steps 2 to 4 and saved states

- Target: choice cards, capacity and primary task controls, Changes / Keep as they are /
  No change groups, save action, saved status strip, phone handoff state.
- Files: `evening-planning-sections.tsx`, `evening-planning-review.tsx` (225),
  `kit-evening-planning.css`, `today-labels.ts`. Closes the remaining V7 F1 to F5 and V8 F1
  to F5 ledger follow-ups or records each as fixed or out of scope in the PR body.
- Guard: step 1 unchanged from P7; morning dialog unchanged. Regressions: same as P7 plus
  the morning handoff (T21).

## 5. Completion

5.1 The feature is complete when all 32 mockups have an accepted capture on origin/main, the
guard captures of every shared page match their pre-P1 baseline except for the nav, and
every checkbox in #2521 is checked with a merge commit beside it. Architect posts the
statement after reading the ledger for all nine merges.

## 6. Decisions already made, no question for Ben

6.1 App-wide pale nav (spec 9.1, approved). Extra section headings go (spec 6.7). Light theme
is the parity theme; dark and canyon are contrast-checked only (spec 6.3).
