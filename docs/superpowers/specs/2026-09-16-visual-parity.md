# Visual parity spec: Today and the daily briefings match the approved mockups 1:1

Revision: VP-SPEC-R3 (2026-09-17; R1 corrected the mockup count to 32; R2 added the collapsible desktop sidebar; R3 records the approved session-sized regional acceptance amendment). Feature: #2521. Plan: `../plans/2026-09-16-visual-parity.md` (VP-PLAN-R2). Predecessor: #2453 (closed; behaviour complete).
Status: approved by Ben on 2026-09-16; the R3 staging amendment was approved on 2026-09-17. Plan required before code.

## 1. Governing rule

1.1 Every approved mockup is the visual source of truth for its screen and state. The real page,
populated with real data, must be indistinguishable from the mockup except for the variances
in section 6. Nothing else may differ.
1.2 Generated text is the only blanket variance. Its font, size, weight, line height, colour,
container, spacing and position must still match. Longer or shorter text may change how many
lines a block occupies; it may not change anything else.
1.3 Legacy styles and markup that conflict with a mockup are removed or replaced, not preserved.
"Unchanged from base" is no longer a defence for a visible difference.
1.4 Product behaviour, data ownership, authorisation, accessible names, keyboard reach and the
saved-plan flows stay as they are unless the mockup requires a presentation change. The
T01 to T22 unit, e2e and UAT suites stay green throughout.
1.5 During the approved intermediate stage, a product task may be accepted only against its
named owned region while it retains a populated full capture and the unchanged base/head guards
for every affected mockup. Regional acceptance is not full-image acceptance: the named
full-image owner is the only task that may accept that image's completed parity.
1.6 The final state still obeys 1.1–1.4 for all 32 mockups. Previously accepted regions must not
regress, and unfinished sibling regions remain explicit guards rather than mockup passes.

## 2. Sources of truth, in precedence order

2.1 The mockup images under `docs/superpowers/specs/assets/2026-09-10-*/` on origin/main
(32 PNG files, listed in section 4). A visible difference from the image is a defect.
2.2 The approved study that produced them, `~/Jarv1s/.superpowers/brainstorm/today-briefings-20260909/`
(`study.css` 416 lines, `morning-briefing.css` 81, `evening-plan.css` 163, `tokens.css` 11).
It supplies exact measurements (sizes, gaps, radii, weights, colours) when the image is
ambiguous. It is a reference for numbers, never copied wholesale into the product.
2.3 The three approved flow specs on origin/main, `docs/superpowers/specs/2026-09-10-today-briefings-design.md`,
`-morning-briefing-flow.md`, `-evening-planning-flow.md`, for states and behaviour.
2.4 The V0 token mapping table in `workspace/moss-v0-task-record.md` decides which product token
carries each study colour. Where the table and the mockup disagree in the default light theme,
the mockup wins and the table is corrected in the plan.

## 3. How the mockups were captured, and how the real page is captured to match

3.1 The study captured with a 1000 px tall viewport. Today captures are viewport clips; the two
dialogs are element screenshots. The parity probe reproduces exactly these clips on the real app:

| Surface                   | Viewport                   | Captured region                                                                        |
| ------------------------- | -------------------------- | -------------------------------------------------------------------------------------- |
| Today opening, 1440       | 1440 x 1000                | clip x 194, y 64, width 1246, height 850 (content right of the nav, below the top bar) |
| Today news, 1440          | 1440 x 1000                | scrolled so the News section top is at y 0; clip x 0, y 0, width 1440, height 850      |
| Today sports, 1440        | 1440 x 1000                | scrolled to Sports; clip x 194, y 0, width 1246, height 850                            |
| Today, 375 (all three)    | 375 x 1000                 | clip x 0, y 0, width 375, height 850                                                   |
| Morning reader and review | 1440 x 1000 and 375 x 1000 | element screenshot of the briefing dialog                                              |
| Evening planning steps    | 1440 x 1000 and 375 x 1000 | element screenshot of the planning dialog                                              |

3.2 A capture counts only when the real page is populated through the disposable stack with the
seed in section 5 and the PR body names every widget that was populated. Empty or mocked
data proves nothing (room rule).
3.3 Captures are taken in the default light theme, at device scale factor 1, with animations
disabled, after fonts are loaded, with every dialog closed by its Close control except the one
being captured. File names equal the mockup file names, under
`workspace/evidence/visual-parity/<slice>/<mockup-name>.png`, with `<mockup-name>.diff.png`
beside each (pixel difference against the mockup, generated-text regions masked).

## 4. The approved mockups: every screen and state

Today page (`assets/2026-09-10-today-briefings/`, 10 files):

| File                                                              | State to seed                                                                                        |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| morning-1440-opening.png, morning-375-opening.png                 | Morning mode, briefing prepared, weather present, timeline with meetings, tasks and preparation rows |
| morning-1440-opening-weather.png, morning-375-opening-weather.png | Same, weather row prominent (weather variant crop)                                                   |
| morning-1440-news.png, morning-375-news.png                       | Scrolled to News: lead photo and story, secondary stories                                            |
| morning-1440-sports.png, morning-375-sports.png                   | Scrolled to Sports: four compact scores with followed teams first, photo recap, Tonight              |
| evening-1440-opening.png, evening-375-opening.png                 | Evening mode: recap, unresolved commitments, tomorrow's shape, Plan tomorrow entry                   |

Morning briefing reader and review (`assets/2026-09-10-morning-briefing/`, 11 files):

| File                                                | State to seed                                                                                                         |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 1440-automatic-read.png, 375-automatic-read.png     | Automatic placement, Read tab, prepared-at line, overnight callout, schedule rail (phone: schedule behind disclosure) |
| 1440-automatic-review.png, 375-automatic-review.png | Automatic placement, Review tab                                                                                       |
| 1440-proposed-read.png, 375-proposed-read.png       | Proposed placement, Read tab                                                                                          |
| 1440-proposed-review.png, 375-proposed-review.png   | Proposed placement, Review tab with proposed rows and accept controls                                                 |
| partial-review.png                                  | Some rows accepted, some pending, status strip visible                                                                |
| 1440-news.png, 375-sports.png                       | Reader's news and sports links treatment                                                                              |

Evening planning (`assets/2026-09-10-evening-planning/`, 11 files):

| File                           | State to seed                                                                          |
| ------------------------------ | -------------------------------------------------------------------------------------- |
| 1440-0.png, 375-0.png          | Step 1: header, numbered steps, Moss prompt, reflection choices, tomorrow rail, footer |
| 1440-1.png, 375-1.png          | Step 2: open commitments as choice cards                                               |
| 1440-2.png, 375-2.png          | Step 3: capacity and primary task, tomorrow rail                                       |
| 1440-3.png, 375-3.png          | Step 4: Changes, Keep as they are, No change groups, save action                       |
| changed-plan-review.png        | Step 4 after choices that change the plan                                              |
| changed-plan-saved.png         | Saved state with status strip                                                          |
| changed-plan-handoff-phone.png | Phone saved state before the morning handoff                                           |

**Approved capacity variance (#2521, 2026-09-25):** The Step 3 mockups show two cards: A steady
day (“The main task, with room for follow-through”) and A lighter day (“One work block. Leave the
rest available”). Ben ruled that the Full day option must remain selectable and guide how much
Moss blocks on the calendar. Keep the third Full day card even though it is absent from the pictured
two-card layout. For implementation, Light considers one priority task, Steady considers the main
task plus one follow-through task, and Full day considers all selected commitments while using open
time; commitments that do not fit remain without a time block.

4.1 Each file above is one final acceptance item. Every one must have a populated capture and a
Reviewer verdict, with exactly one named full-image completion owner in 4.3. An intermediate
task that touches a file retains its full capture and guards but may report only its owned region.
A slice that ships without a capture for a file it touches is not done.
4.2 Element-level states that appear inside these images are part of the same item and are
checked in the same capture: hover is not captured; focus ring, selected card, checked row,
disabled or busy button, and status strip are captured where the mockup shows them.

4.3 Full-image completion ownership is explicit and unique: Today opening/weather images belong
to `p2-action-rail`; Today evening opening images to `p3-tomorrow-entry`; Today news images to
`p4-news`; Today sports images to `p4-sports-recap`. Morning automatic-read images belong to
`p5-automatic-read`; proposed-read to `p5-proposed-read`; 1440-news to `p5-reader-news`;
375-sports to `p5-reader-sports`; automatic-review to `p6-automatic-review`;
proposed-review to `p6-proposed-review`; and partial-review to `p6-partial-review`. Evening
step 0 images belong to `p7-reflection`; step 1 to `p8-commitments`; step 2 to `p8-capacity`;
step 3 to `p8-review`; changed-plan-review to `p8-changed-review`; changed-plan-saved to
`p8-saved`; and changed-plan-handoff-phone to `p8-phone-handoff`. These owners cover exactly
10 Today, 11 morning and 11 evening images, all 32 files once.

## 5. Populated seed

5.1 One fixture seeds all surfaces: fixed clock 08:00 local for morning, 20:00 for evening; three
meetings, two events, six tasks (two unscheduled with deadlines), one carry-over commitment,
news feed with a lead photo and three secondary stories, sports with two followed teams,
two other scores and one Tonight fixture, weather present. The plan names the fixture file;
it extends the existing T22 and V4 fixture seams rather than adding a third path.
5.2 Photos come from the fixture, not live feeds, so captures are stable.

## 6. Allowed variances (the complete list; anything not here is a defect)

6.1 Generated text content and its line count (section 1.2).
6.2 Dates, times, names, counts and photos supplied by the fixture, in place of the study's
example content.
6.3 Colour resolves through the app theme. In the default light theme every colour equals the
mockup value. Dark and canyon themes are derived by the existing tokens and are checked for
contrast, not for parity.
6.4 Accessibility additions that do not change what is seen: accessible names, roles, live
regions, keyboard handlers, hidden skip links. A visible focus ring must match the study's.
6.5 Browser-native controls (select arrows, checkbox glyphs, scrollbars) may differ by platform;
their size, position and surrounding styling may not.
6.6 The known defects listed in #2521 (Tasks toolbar overflow, Meds dialog focus, followed-team
image 404, rail heading, phone viewport cap, tomorrow events in the evening rail, reader
footer at 200 percent zoom, V7 and V8 review follow-ups) are fixed inside the slice that
owns that surface; none is a variance.
6.7 Nothing else. In particular, these are not variances: an extra section heading, a border or
shadow the mockup lacks, a different nav width or colour, a control rendered as a legacy pill
or button, a different font weight, dashboard metric cards, or a dialog frame the mockup
does not show.

## 7. Legacy that goes

7.1 The plan may delete or rewrite any of these when they conflict with a mockup, including
shared files, provided the PR body names the file and every other screen it serves:
`apps/web/src/shell/app-shell.tsx`, `shell-nav.tsx`, `kit-shell-nav.css` (the study nav is
pale, 194 px wide on desktop; see 9.1), `today-page.tsx`, `today-hero.tsx`, `today-rail.tsx`,
`module-today-widgets.tsx`, `morning-briefing.tsx`, `briefing-report-shell.tsx`,
`day-plan-review.tsx`, `day-plan-review-row.tsx`, `evening-planning*.tsx`, `evening-mode.tsx`,
`day-plan.tsx`, every `kit-today*.css`, `kit-briefing-reader.css`, `kit-day-plan-review.css`,
`kit-evening-planning.css`, and `packages/ui/src/styles/components-moss-today.css`.
7.2 Dead rules are deleted in the same slice that orphans them; the ui-classes scan list is kept
current. File-size limits still apply; splitting a file is allowed and named in the PR body.
7.3 Other product pages (Tasks, Calendar, Settings, Chat) keep their look except where the
shared nav changes (9.1). Each slice that touches a shared file captures one populated
screenshot of each other page it serves at 1440 and 375 and shows no unintended change.

## 8. Acceptance and proof

8.1 Reviewer opens each mockup and its populated capture side by side and the diff image, and
walks this checklist per final capture: typography (family, size, weight, line height, letter spacing),
spacing and rhythm, dimensions, alignment, colour, borders and radii, shadows, imagery,
control appearance, responsive stacking, visible state. For an intermediate task, the same
review is limited to its declared owned region and the remaining image is a base/head guard;
only the 4.3 owner can issue the final full-image verdict. Any visible difference outside
section 6 is blocking. Follow-up is reserved for defects invisible in the capture.
8.2 Prover produces the captures and diffs from the real disposable stack with the section 5 seed,
reports the diff pixel percentage per file and owned region with the masked regions named, and reruns the
T20/T21 UAT legs and the existing Chromium boundary probes unchanged.
8.3 Measured tolerances, in pixels at scale 1: element positions and sizes within 2 px of the
mockup; font sizes and line heights exact; colours exact after token resolution; diff
percentage outside masked text regions at most 0.5 percent per capture, and every diff
cluster explained in the PR body or fixed.
8.4 Dark and canyon: one capture each of the Today opening and each dialog at 1440, contrast
of body and lede text at least 4.5 against its ground.
8.5 The full static command stays the V8 one (`workspace/moss-v8-task-record.md` lines 172 to
186), extended per slice with the new visual test file.
8.6 Proof follows `workspace/workflow.md`: current proof per slice with review, CI, static,
Chromium, UAT and the new visual-parity leg on the same head.
8.7 The staging amendment changes ownership and intermediate reporting only. It does not relax
the <=0.5% comparable-pixel threshold, <=2px geometry, exact typography/colour requirements,
generated-text mask limits, populated-data requirement, contrast checks, actor/data safety,
fresh-pair identity, current-head proof or any required static/CI/review/Chromium/UAT/visual
leg. Regional tasks never claim final full-image or whole-feature completion.

## 9. Approved navigation decision

9.1 The mockups show a pale, 194 px wide desktop navigation with the Today content beside it.
The current shell nav is the app-wide dark nav with the V1 icon-rail option. 1:1 on Today
means the shell nav changes on every page. Approved: adopt the study nav app-wide
(pale, 194 px, same items), keep the phone top bar and the icon-rail preference from V1,
and capture Tasks, Calendar and Settings once to confirm nothing else moved.

9.2 Approved with one amendment. The 194 px sidebar stays collapsible on desktop. A simple
`<<` control sits beside the logo area; pressing it collapses the sidebar to the compact
icon rail from V1, restyled in the same pale palette, and the control becomes `>>`. The
choice is remembered per user as today. The accessible names stay "Collapse navigation"
and "Expand navigation"; the control is keyboard reachable and shows the study focus ring.
The mockups show the expanded state, so parity captures are taken expanded. Every shared
page is guard-captured in both states at 1440. The phone top bar is unchanged.

## 10. Out of scope

10.1 #2503 all-day calendar timezone handling.
10.2 New behaviour, new data, new settings. Hover states and animation timing.
10.3 Themes other than light, dark and canyon.
