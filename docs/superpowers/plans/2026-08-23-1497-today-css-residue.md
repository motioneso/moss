# Plan: #1497 / #1427-A — extract Today residue into @moss/ui

Spec: `docs/superpowers/specs/2026-08-10-css-guard-residue.md`, child A row (line 141), per-child
contract (lines 152-167), Child A acceptance + browser proof (lines 171-187), font-shorthand trap
(line 156-159). Issue: #1497, part of #1427. Predecessor children B-E already merged and are
ancestors of this branch (`origin/main` = `2996f6cf6`, #1501/#1878).

## Baseline re-measurement (spec contract item 1)

Re-measured 2026-08-23 in this worktree by calling the exported `checkBannedProperties` with the
three files passed explicitly:

```
apps/web/src/styles/kit-today.css: 34 violations
apps/web/src/styles/kit-today-feeds.css: 25 violations
apps/web/src/styles/kit-today-misc.css: 93 violations
total: 152
```

Matches the count already recorded on #1497 by the previous session (152, not the spec's original
147 — the +5 traced to unrelated fix #1594, ruled in-scope by Fable already; not re-litigated
here). No further drift since that comment — baseline for this build is confirmed **152 → 0**.

## Seams check (verified in this worktree, 2026-08-23)

- **The three owned files**, read in full:
  - `apps/web/src/styles/kit-today.css` (188 lines) — `.today-feedback` + `__status` (+ coupled
    `.today-feedback__status button { font: inherit; }`), `.evening-prep__btn`, `.top3`, the
    command-center block (`.cmd-wrap`, `.cmd-next*`, `.cmd-glance*`, `.cmd-grid`, `.cmd-aside*`),
    the "walking the day" meeting list (`.day-list`, `.day-ev*`).
  - `apps/web/src/styles/kit-today-feeds.css` (121 lines) — `.loose*` (loose-ends action rows,
    including `.loose-row__main { font: inherit; ... }` — a second, unrelated shorthand, see Task 1
    note), `.briefing-catchup`, `.well*` (wellness rail card).
  - `apps/web/src/styles/kit-today-misc.css` (328 lines) — `.np-*` (newspaper hero + list rows),
    `.overnight*`, `.agenda-clear`, `.well__btn--meds` / `.well__ct` / `.well__nudge*` (wellness
    meds card), `.bfresh*` (briefing freshness list).
- **No collisions:** grepped every one of the ~65 classes defined across the three files against
  every other `*.css` under `apps/web/src` and `packages/ui/src` — zero other definitions of any of
  them exist anywhere. Confirmed sole TSX consumers:
  `apps/web/src/today/{briefing-action-rows,briefing-feedback-menu,briefing-freshness,news-desk,
overnight-section,proactive-cards,evening-mode,today-page}.tsx`. No rename needed.
- **Destination confirmed:** `packages/ui/src/styles/components-moss-today.css` exists (282 lines),
  already imported at `packages/ui/src/styles.css:3` (first import, before
  `components-command-palette.css:18`). It currently holds unrelated `jds-*` primitives (masthead,
  stat-tile, agenda-row, card-header, menu, weather-chip) — no naming collision with the
  screen-local classes this task moves. Plan appends a new section, does not touch existing content.
- **Cascade-order check (the spec's named risk, and why the font: inherit trap is real):**
  `apps/web/src/main.tsx:9` imports `./styles/index.css` first, which imports `@moss/ui/styles.css`
  (`apps/web/src/styles/index.css:10`) — pulling in `components-moss-today.css` at app-entry time.
  The three `kit-today*.css` files are imported directly by
  `apps/web/src/today/today-page.tsx:86-88`, which only loads when the Today route module loads —
  strictly after the main-entry CSS bundle in the final stylesheet order. So today-page's rules win
  any equal-specificity conflict with the package sheet. This is harmless for split longhand
  properties (banned half moves, layout half stays, no overlap), but for a `font` shorthand left
  behind in the app file, that later-cascade rule would silently reset the package file's split-out
  `font-size`/`font-family`/`font-weight` back to `inherit`. Two such couplings exist here (spec
  cites the first only):
  - `.today-feedback__status button { font: inherit; ... font-size: 11px; }` (kit-today.css:22-30) —
    named explicitly in the spec's per-child contract.
  - `.loose-row__main { font: inherit; color: inherit; ...}` (kit-today-feeds.css:27-38) — same
    idiom, not named in the spec text but present in the actual file; `font: inherit` here sits
    alongside `color: inherit` (not banned — `inherit` is a value, not one of the tracked colour
    properties... but `color` itself IS in `BANNED_VISUAL_PROPERTIES`, so `color: inherit` also
    moves). Both `font: inherit` and `color: inherit` move together to the package file in the same
    rule, for the same clobber reason as the named case.
- `scripts/check-design-tokens.ts:89-130` — `MIGRATED_SECTION_CSS_FILES` ends with the #1427-E
  entry `apps/web/src/styles/texture.css` (line 130). Our three registrations append after it.
- `packages/ui/src/styles.css` — 20 `@import` lines; `components-moss-today.css` is already the
  first import (line 3). No new import needed; only the existing destination file's content grows.
- File-size gate (`scripts/check-file-size.ts:6`, 1000-line default): `components-moss-today.css`
  is 282 lines today; the move adds roughly 165 lines of the ~230 non-comment lines currently in the
  three source files (banned declarations only, not layout) — landing well under 500. No source
  file is within reach of the ceiling either.

**Every selector/property pair below is taken directly from a throwaway script's call to the
exported `checkBannedProperties(root, [the three files])`, not hand-derived from re-reading the
CSS** — this is the exact, tool-verified 152, grouped into rules. Re-running that call after each
task's edit is how "the file returns zero" is checked (Verification step 1), not a re-read.

## Task 1 — extract kit-today.css's banned declarations (34, tool-verified)

Edit `packages/ui/src/styles/components-moss-today.css`: append a new section (head comment
`/* Today residue (#1427-A) */`) re-declaring each selector below in file order, moving only the
banned declarations verbatim (values, custom-property references, explanatory comments that travel
with the rule):

- `.today-feedback__status` (line 14) → `color` (18), `font-size` (19)
- `.today-feedback__status button` (line 22) → `border` (23), `background` (24), `font` (25 — the
  coupled shorthand, not itself banned but must move with `font-size` in the same rule per the
  spec's named trap), `color` (27), `font-size` (28)
- `.cmd-next` (57) → `background` (58), `color` (59), `border-radius` (60)
- `.cmd-next__k` (63) → `font-family` (64), `font-size` (65), `color` (68)
- `.cmd-next__v` (70) → `font-family` (71), `font-size` (72)
- `.cmd-next__what` (77) → `font-family` (78), `font-size` (79), `font-weight` (80), `color` (82)
- `.cmd-glance__title` (88) → `font-family` (89), `font-size` (90), `color` (93)
- `.day-ev__t` (159) → `font-family` (160), `font-size` (161), `color` (163)
- `.day-ev__t .ap` (166) → `font-size` (167), `color` (168)
- `.day-ev__title` (170) → `font-family` (171), `font-size` (172), `color` (173)
- `.day-ev__where` (176) → `font-size` (177), `color` (178)
- `.day-ev__who` (181) → `font-family` (182), `font-size` (183), `color` (184)

Then edit `apps/web/src/styles/kit-today.css`: delete exactly those declarations from each rule
above. No rule becomes empty (every one retains a layout declaration — `display`, `gap`,
`white-space`, `margin-top`, `padding`, `text-align`, etc.). Keep every other rule
(`.evening-prep__btn`, `.top3`, `.cmd-wrap`, `.cmd-glance__grid`, `.cmd-grid` + its two
media-query blocks, `.cmd-aside`, `.cmd-aside__inner`, `.day-list`, `.day-ev`,
`.day-ev:first-child`) untouched — none of them declare a banned property. Keep the file-head
comment, amended with one line noting the visual half now lives in the package sheet.

## Task 2 — extract kit-today-feeds.css's banned declarations (25, tool-verified)

Append to the same new `components-moss-today.css` section:

- `.loose-row__main` (27) → `color` (34 — coupled with `font` in the same rule, same clobber
  reason as Task 1's named trap), `background` (35), `border` (36)
- `.loose-row__meta` (43) → `color` (46), `font-size` (47)
- `.well` (61) → `background` (62), `border` (63), `border-radius` (64)
- `.well__head .ic` (73) → `color` (74)
- `.well__title` (77) → `font-size` (78), `font-weight` (79), `color` (82)
- `.well__line` (84) → `font-family` (85), `font-size` (86), `color` (87)
- `.well__line b` (91) → `font-weight` (92)
- `.well__btn` (99) → `border-radius` (105), `border` (106), `background` (107), `color` (108),
  `font-family` (109), `font-size` (110), `font-weight` (111)
- `.well__btn:hover` (115) → `border-color` (116), `background` (117)

Then edit `apps/web/src/styles/kit-today-feeds.css`: delete exactly the declarations above. No
rule becomes empty. Keep `.loose`, `.loose-row`, `.loose-row + .loose-row`, `.loose-row:hover`,
`.loose-row__ic`, `.loose-row__title`, `.loose-row__act`, `.briefing-catchup`, `.well__head`,
`.well__actions`, `.well__btn .ic` untouched.

## Task 3 — extract kit-today-misc.css's banned declarations (93, tool-verified)

Append to the same section, selector by selector in file order:

- `.np-photo` (14) → `border-radius` (16), `background` (19 — `linear-gradient(...)`, verbatim;
  the guard bans the whole `background` property, gradients included), `border` (20)
- `.np-photo--news` (22) → `background` (23 — `linear-gradient(...)`, verbatim)
- `.np-photo__ph` (25) → `color` (33)
- `.np-photo__cap` (35) → `font-family` (36), `font-size` (37)
- `.np-photo__crest` (41) → `border-radius` (47), `color` (48), `font-family` (52), `font-size`
  (53), `font-weight` (54)
- `.np-kicker` (62) → `font-family` (66), `font-size` (67), `color` (69)
- `.np-kicker .out` (71) → `font-weight` (72)
- `.np-headline` (74) → `font-family` (75), `font-size` (76), `font-weight` (77), `color` (80)
- `.np-dek` (84) → `font-family` (85), `font-size` (86), `color` (88)
- `.np-meta` (92) → `font-size` (93), `color` (94)
- `.np-row__lead` (108) → `border-radius` (112)
- `.np-row__lead.crest` (118) → `color` (119), `font-family` (120), `font-size` (121),
  `font-weight` (122)
- `.np-row__lead.src` (124) → `background` (125), `color` (126)
- `.np-row__title` (132) → `font-family` (133), `font-size` (134), `color` (135)
- `.np-row__sub` (138) → `font-size` (139), `color` (140)
- `.np-row__sub .src` (143) → `color` (144), `font-family` (145), `font-size` (146)
- `.np-row__out` (148) → `border-radius` (152), `font-family` (156), `font-size` (157),
  `font-weight` (158)
- `.np-row__out.w` (161) → `background` (162), `color` (163)
- `.np-row__out.d` (165) → `background` (166), `color` (167)
- `.np-row__out.news` (169) → `background` (170), `color` (171)
- `.np-topic` (173) → `font-size` (177), `font-weight` (178), `color` (179)
- `.np-topic .ic` (181) → `color` (182)
- `.overnight__row .tx` (198) → `font-family` (199), `font-size` (200), `color` (201)
- `.overnight__row .tx b` (204) → `color` (205), `font-weight` (206)
- `.agenda-clear` (210) → `font-size` (211), `color` (212)
- `.agenda-clear b` (216) → `color` (217), `font-weight` (218)
- `.well__ct` (232) → `font-family` (233), `font-size` (234), `font-weight` (235), `color` (236)
- `.well__ct.is-done` (239) → `color` (240)
- `.well__nudge` (244) → `border-radius` (250), `background` (251), `border` (252)
- `.well__nudge-x` (254) → `border` (261), `border-radius` (262), `background` (263), `color`
  (264)
- `.well__nudge-x:hover` (269) → `background` (271)
- `.bfresh__label` (280) → `font-family` (281), `font-size` (282), `color` (285)
- `.bfresh__item` (297) → `font-size` (301), `color` (302)
- `.bfresh__source` (304) → `font-weight` (305), `color` (306)
- `.bfresh__age` (308) → `font-family` (309), `font-size` (310), `color` (311)
- `.bfresh__age--live` (313) → `color` (314)
- `.bfresh__age--unknown` (316) → `color` (317)
- `.bfresh__stale` (320) → `font-size` (322), `color` (323), `border-radius` (325), `background`
  (326), `border` (327)

Then edit `apps/web/src/styles/kit-today-misc.css`: delete exactly the declarations listed, for
every selector above. No rule becomes empty (every selector above also carries at least one
layout/structural declaration — `position`, `display`, `padding`, `margin`, `gap`, `opacity`,
`transition`, sizing, or `flex`/`grid` properties — that stays). Keep every other rule
(`.np-hero`, its media query, `.np-hero__body`, `.np-kicker .out`'s sibling declarations not
listed, `.np-list`, `.np-row`, `.np-row__main`, `.overnight`, `.well__btn--meds` + `.lead`,
`.bfresh`, `.bfresh__list`) untouched.

## Task 4 — register the three app sheets

Edit `scripts/check-design-tokens.ts`: append to `MIGRATED_SECTION_CSS_FILES`, after the #1427-E
entries, matching the existing comment style:

```
// #1427-A: Today residue, moved to packages/ui/src/styles/components-moss-today.css.
"apps/web/src/styles/kit-today.css",
"apps/web/src/styles/kit-today-feeds.css",
"apps/web/src/styles/kit-today-misc.css"
```

No change to `packages/ui/src/styles.css` (the destination file is already imported at line 3).

## Verification (focused checks, spec "Every child")

1. Re-measure: `checkBannedProperties` with the three owned files passed explicitly →
   expect **0**. Run via a throwaway script the same way the 152 baseline above was produced.
2. `pnpm check:design-tokens > /tmp/cdt.log 2>&1; echo "EXIT=$?"` — expect `EXIT=0` (the three
   newly registered app files are now layout-only; nothing else in scope).
3. `pnpm check:ui-classes > /tmp/cuc.log 2>&1; echo "EXIT=$?"` — expect `EXIT=0` (no class renamed,
   package discovery already covers `components-moss-today.css` per child E's discovery change).
4. `pnpm check:file-size > /tmp/cfs.log 2>&1; echo "EXIT=$?"` — expect `EXIT=0`.
5. `pnpm exec vitest run tests/unit/check-design-tokens.test.ts > /tmp/vt1.log 2>&1; echo "EXIT=$?"`
   — expect `EXIT=0` (fixture-based test, unaffected by the real-tree registration change).
6. Full gate at wrap-up only via the `verify-gate` skill, never bare.

## Task 5 — browser proof (light + dark; spec line 187)

On the dev instance (http://192.168.50.36:5173, login per memory; never :1533):

- Navigate to `/today`. Capture before/after screenshots covering: the command-center masthead rail
  and "walking the day" meeting list (kit-today.css surfaces), the loose-ends action rows and
  wellness rail card (kit-today-feeds.css surfaces), the newspaper hero + list rows, overnight
  changes, agenda-clear empty state, wellness meds card, and briefing freshness list
  (kit-today-misc.css surfaces) — in both light and dark mode, switched via the real Settings
  appearance pane (`apps/web/src/settings/settings-appearance-pane.tsx`), not a forced
  `data-theme` attribute.
- Every colour, font, border, radius, and shadow across these regions must be pixel-identical to
  the pre-move screenshot. Any drift is a blocker per the spec's cascade-drift rule — do not tweak
  values to approximate; find and fix the cascade cause (most likely the two `font: inherit`
  couplings above, if either one is split incorrectly).
- Add the UAT spec: `tests/uat/specs/1497-today-css-residue.uat.spec.ts`, following the pattern of
  `tests/uat/specs/1112-today-masthead-oneline.uat.spec.ts` (real login, no fixture mocking, reads
  `JARVIS_UAT_BASE_URL`). Add a row to `.claude/skills/coordinate/uat-trigger-map.tsv` covering
  `apps/web/src/today/**` and the three CSS files, in this same PR.
- Record all shots + the UAT run's exit code and output on the PR. Screenshots go to disk; compare
  cropped regions, never pull full-page images into context.

Live-path gate applies: without this recorded proof the honest status is code-complete, unverified.

## Kill gate

Stop and report to the coordinator (do not improvise) if:

- re-measurement at build time differs from **152** (scope moved again under us since 2026-08-23);
- any rule listed above turns out already empty after the banned declarations are removed (would
  mean a markup consumer lost a class the plan didn't account for — re-check TSX usage before
  deleting);
- any property listed above turns out not to actually be in `BANNED_VISUAL_PROPERTIES` when
  re-checked at build time — leave it in place, don't move it, and don't treat the mismatch as a
  reason to touch the guard's property list;
- any computed-style or screenshot drift appears after the move — cascade drift is a blocker, not a
  tuning invitation; the two `font: inherit` couplings are the most likely cause and must be
  re-checked first;
- the branch no longer fast-forwards from `2996f6cf6` (a later child landed out of order).

## Collision boundaries

- **Children B-E (merged, ancestors of this branch):** touched `command-palette.css`,
  `assistant-surface.css`, `components-forms.css`, `components-keyline.css`/`texture.css`, and the
  tail of `MIGRATED_SECTION_CSS_FILES` up through the #1427-E entries. This child's only overlap is
  appending after those entries — no file-content conflict.
- **#1427-F (not started):** owns `apps/web/src/styles.css` and the second global `font: inherit`
  coupling (`button.module-link`) — different file, no overlap with this child's two
  `.today-feedback__status button` / `.loose-row__main` couplings.
- **#1427-G (not started):** owns guard 4's app-scope graduation — this child's only touch to
  `check-design-tokens.ts` is the registration array append, same idiom as every prior child.
- Shared seams touched by A: `packages/ui/src/styles/components-moss-today.css` (append only, no
  edit to existing masthead/stat-tile/card content), `MIGRATED_SECTION_CSS_FILES` (array tail). No
  other in-flight issue touches either today.

## Non-goals

- No selector rename, token/value change, markup/TSX change, or new component.
- No change to `BANNED_VISUAL_PROPERTIES`, no CSS parser, no new dependency.
- No cleanup of non-banned visual-ish properties (`transition`, `letter-spacing`, `line-height`,
  `text-transform`, `white-space`, `font-variant-numeric`, `text-wrap` stay where they are).
- No touching `packages/ui/src/styles.css` import order — the destination is already first.
- Release note: Category N/A — visually inert by acceptance; nothing user-visible.
