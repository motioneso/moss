# Plan: #1501 / #1427-E — move keyline and global texture visuals under @moss/ui

Spec: `docs/superpowers/specs/2026-08-10-css-guard-residue.md`, child E row (line 144), "Other
residue" keyline bullet (line 93-94), the `check:ui-classes` discovery paragraph (line 102-113),
the `components-web.css` destination for `texture.css` (line 57-60), the import-order rule and
escape hatch (line 97-100), per-child contract (line 152-167), Child E acceptance (line 171-201,
browser proof line 190), risks (line 230-243). Issue: #1501, part of #1427/#1470. Predecessor
child D merged as `81205868d` (#1873) and is an ancestor of this branch.

## Baseline re-measurement — STOP-AND-RESCOPE NOTE (spec contract item 1)

The spec's child E row says **23 → 0** (22 in `components-keyline.css` + 1 in `texture.css`,
audited 2026-08-10). Re-measured 2026-08-22 in this worktree by calling the exported
`checkBannedProperties` with the two files passed explicitly: **31 violations** —
**30** in `apps/web/src/styles/components-keyline.css`, **1** in `apps/web/src/styles/texture.css`.

The growth is fully explained: commit `bfa2fcf95` (#1744, merged 2026-08-19, after the audit)
added 29 lines to `components-keyline.css` — the `.jds-rail--danger` / `--morning` / `--afternoon`
/ `--evening` rail variants (4 × `background`) and `.jds-instrument__value` (`font-family`,
`font-size`, `font-weight`, `color`), i.e. exactly +8. Same file, same idiom, same treatment; no
new file entered scope.

Per the contract ("stop and update the child issue rather than silently absorbing new scope"),
**Task 0 below updates #1501 before any edit**. The re-scoped baseline for this child is
**31 → 0** across the same two owned sheets. Per-property breakdown of the 31 (tool output,
cross-checked by hand against every selector): `background` 13, `font-size` 6, `color` 4,
`font-family` 3, `font-weight` 3, `border-radius` 1, `background-image` 1 (texture).

## Seams check (verified in this worktree, 2026-08-22)

- `apps/web/src/styles/components-keyline.css`: 203 lines, defines only `jds-*` primitives
  (`.jds-display` + 4 size modifiers + `__accent`, `.jds-hairline-row`, `.jds-rail` + 11 modifiers,
  `.jds-rail-row`, `.jds-meta-sep`, `.jds-section-head` + `__rule`, `.jds-instrument` +
  `--unruled` + `__value` + `__label`). No `font:` shorthand anywhere in either owned file
  (grepped), so the spec's shorthand-coupling rule (children A and F only) does not apply here.
- `apps/web/src/styles/texture.css`: 17 lines, a single `body::after` rule; only its
  `background-image` (the feTurbulence data-URI) is banned. `background-repeat`, `opacity`,
  `mix-blend-mode` are not banned and stay. `background-image` and `background-repeat` are
  independent longhands with no shorthand present, so splitting them across files cannot change
  the computed style. No other sheet in `apps/web/src` or `packages/ui/src` styles `body::after`
  (grepped, zero hits).
- **Cascade-order check (the spec's named risk):** the web keyline sheet loads at
  `apps/web/src/styles/index.css:12` and `texture.css` at line 18, both _after_ the whole
  `@moss/ui/styles.css` bundle (line 10). Moving the visuals into package sheets hoists them
  earlier, ahead of the web sheets at index lines 11–18 (`components-forms.css`, the now
  layout-only `command-palette.css`, `../styles.css`, three onboarding sheets, `texture.css`).
  Grepped every one of those, every `packages/ui/src/styles/*.css`, and
  `assistant-surface.css` for all the keyline class names: **zero other definitions exist**. The
  Job Search and Food module CSS only _extend_ these classes with layout-only declarations on
  their own `jsm-*` selectors (module CSS contract), never re-declare a banned property on a
  keyline class. So no equal-or-lower-specificity competitor exists anywhere; the
  narrower-import escape hatch (spec line 99-100) is **not needed**.
- `packages/ui/src/styles.css` is 18 `@import` lines ending at
  `components-command-palette.css`. Neither destination file exists yet; both are new.
- `scripts/check-design-tokens.ts:89-130` — `MIGRATED_SECTION_CSS_FILES` ends with the #1427-D
  entry `apps/web/src/styles/components-forms.css`; our two registrations append after it.
- `scripts/check-ui-classes.ts:21-53` — `DEFINITION_FILES` statically lists 7 `packages/ui`
  sheets and 25 web files. The static list already has holes (e.g.
  `packages/ui/src/styles/components-command-palette.css`, `components-chat.css`,
  `components-calendar.css` are imported by the bundle but absent from the list) — exactly the
  hole child E's discovery change closes. The script already has a reusable recursive
  `walk()` (line ~175) used for usage scanning; discovery reuses it, no new dependency.
- `tests/unit/check-ui-classes.test.ts` builds its fixture tree from the exported
  `DEFINITION_FILES` (deliberately, see the #1393 comment at line 37-40), so the Task 4 refactor
  must keep the fixture derivable from exports.
- Rules left truly empty by the move (and therefore deleted from the web sheet, classes kept
  defined by the package sheet): `.jds-display__accent`, `.jds-hairline-row:hover`, and all nine
  `.jds-rail--*` colour modifiers. Every other selector retains layout declarations and stays.

## Task 0 — update the child issue baseline (before any edit)

Comment on #1501: baseline re-measured at 31 (30 keyline + 1 texture), was 23 at audit time;
growth is the 8 declarations `bfa2fcf95` (#1744) added on 2026-08-19; same two files, treatment
unchanged, completion criterion becomes 31 → 0. No title/body scope change needed.

## Task 1 — extract the 30 keyline visual declarations

Create `packages/ui/src/styles/components-keyline.css` (new file). For each selector in the web
sheet's existing order, re-declare the selector and move only the banned declarations, verbatim —
values, custom-property references, and the explanatory comments that travel with a visual rule
(e.g. the rail-idiom comment, the `--bucket-*` time-of-day comment, the display-size px notes):

- `.jds-display` → `font-family`, `font-weight`, `color`
- `.jds-display--xl` / `--lg` / `--md` / `--sm` → each `font-size` (the `clamp(...)` values,
  verbatim; `letter-spacing` and `line-height` are not banned and stay in the web sheet)
- `.jds-display__accent` → `color`
- `.jds-hairline-row:hover` → `background`
- `.jds-rail` → `border-radius`, `background`
- `.jds-rail--accent`, `--gold`, `--steel`, `--line-strong`, `--line`, `--danger`, `--morning`,
  `--afternoon`, `--evening` → each `background`
- `.jds-meta-sep` → `background`
- `.jds-section-head__rule` → `background`
- `.jds-instrument__value` → `font-family`, `font-size`, `font-weight`, `color`
- `.jds-instrument__label` → `font-family`, `font-size`, `font-weight`, `color`

Then edit `apps/web/src/styles/components-keyline.css`: delete exactly those declarations, delete
the eleven now-empty rules listed in the seams check, keep every layout declaration
(`display`, grid, `width`, `border-top` — not a banned property — `transition`, `margin`,
`padding-top`, `letter-spacing`, `line-height`, `text-transform`, `text-wrap`,
`font-variant-numeric`, `white-space`, `opacity`, flex properties, etc.) at its existing path.
Do not rename any selector, change any value, or touch markup. Keep the file-head comment,
amended with one line noting the visual half now lives in the package sheet (#1427-E).

## Task 2 — extract the texture background-image

Create `packages/ui/src/styles/components-web.css` (new file — the spec names this file as the
shared destination that child F will extend with the `styles.css` split; keep it minimal):

```css
/* #1427-E/F destination for app-global visual declarations (spec: css-guard-residue).
   Park Press riso grain: the tile itself is visual identity, so it lives in @moss/ui;
   the body::after plumbing (position, z-index, opacity/blend tokens) stays in
   apps/web/src/styles/texture.css, which still owns the overlay's layout. */
body::after {
  background-image: url("data:image/svg+xml,..."); /* moved verbatim from texture.css */
}
```

Edit `apps/web/src/styles/texture.css`: remove only the `background-image` declaration; the rule
keeps `content`, `position`, `inset`, `z-index`, `pointer-events`, `background-repeat`,
`opacity`, `mix-blend-mode` and its comment block (amend the comment's data-URI sentence to point
at the package sheet).

## Task 3 — register the sheets

- `packages/ui/src/styles.css`: append, after the existing final import
  (`components-command-palette.css`), in this order:
  `@import "./styles/components-keyline.css";` then `@import "./styles/components-web.css";`.
  This preserves the current web relative order (keyline at index.css:12 loads before texture at
  index.css:18) and, per the seams check, no other ordering constraint exists.
- `scripts/check-design-tokens.ts`: append to `MIGRATED_SECTION_CSS_FILES`, after the #1427-D
  entry, with a comment matching the neighbours' style:
  `// #1427-E: keyline primitives + global texture, moved to packages/ui/src/styles/components-keyline.css and components-web.css.`
  then `"apps/web/src/styles/components-keyline.css",` and `"apps/web/src/styles/texture.css"`.

## Task 4 — package style discovery in check:ui-classes (owned by E per spec line 102-113)

Edit `scripts/check-ui-classes.ts`:

- Split the current `DEFINITION_FILES` into an exported
  `WEB_DEFINITION_FILES` (all 25 current `apps/web/src/...` entries, unchanged — the web keyline
  entry is retained because the file still defines layout-only `jds-*` selectors) and delete the
  7 static `packages/ui/...` entries.
- Add `PACKAGE_STYLE_ROOT = "packages/ui/src/styles"` and, inside `collectDefinedClasses(root)`,
  discover every `*.css` file below `join(root, PACKAGE_STYLE_ROOT)` using the script's existing
  `walk()` generator (filter `extname === ".css"`), then scan discovered files plus
  `WEB_DEFINITION_FILES`. Sort discovered paths for deterministic output. Missing directory =
  walk yields nothing (the existing `walk` already swallows ENOENT) — fine for fixtures.
- Keep exporting `DEFINITION_FILES` only if something still imports it; otherwise remove it and
  update the test import. Grep confirms the unit test is the only importer.

Edit `tests/unit/check-ui-classes.test.ts`:

- Fixture builder: derive dirs/files from `WEB_DEFINITION_FILES` and additionally
  `mkdir packages/ui/src/styles` (recursive) so discovery has a root.
- Add the spec-required focused case: write a **new, never-registered**
  `packages/ui/src/styles/components-discovery-probe.css` into the fixture defining
  `.jds-discovery-probe`, use `jds-discovery-probe` in a fixture `.tsx`, and assert zero
  undefined-class violations — proving a new package sheet contributes definitions with no
  registration edit. Keep the existing "fails on an undefined class" case as the negative control
  (it already proves discovery doesn't over-collect, since the fixture's package dir is empty
  there).
- The final "passes against the real repo tree" case needs no change and now also exercises
  discovery over the real package sheets, including the new `components-keyline.css`.

## Verification (focused checks, spec "Every child" + child E extra)

1. Re-measure: `checkBannedProperties` with the two owned files passed explicitly → **0**.
2. `pnpm check:design-tokens` — green (the two newly registered app files are layout-only).
3. `pnpm check:ui-classes` — green (package discovery finds every bundle sheet; web keyline still
   listed; no `jds-*` class lost its definition).
4. `pnpm check:file-size` — green (new package sheets ~120 and ~15 lines; web keyline shrinks).
5. `pnpm exec vitest run tests/unit/check-design-tokens.test.ts` — green.
6. `pnpm exec vitest run tests/unit/check-ui-classes.test.ts` — green, including the new
   discovery case (child E's extra required run, spec line 176-177).
7. Full gate at wrap-up only via the `verify-gate` skill, never bare.

## Task 5 — browser proof (desktop + mobile, light + dark; spec line 190)

On the dev instance (http://192.168.50.36:5173, login per memory; never :1533):

- **Keyline surface:** open Job Search from the app navigation (module surface; its board and
  overview screens use `.jds-display--xl/--lg`, `.jds-hairline-row`, `.jds-rail`, `.jds-rail-row`,
  `.jds-meta-sep`, `.jds-section-head`, `.jds-instrument`). Capture before/after screenshots at a
  desktop width and a mobile width, in light and dark mode. Every hairline, rail colour, display
  heading size/weight, and instrument label/value must be pixel-identical; any drift is a blocker
  per the spec's cascade-drift rule — do not tweak values to approximate.
- **Texture:** one full-page grain check on a content route (e.g. Today) and on the auth screen
  (texture deliberately covers pre-login), light and dark. The riso grain overlay must be present
  and unchanged.
- Record all shots on the PR. Screenshots go to disk; compare cropped regions, never pull
  full-page images into context.

Live-path gate applies: without this recorded proof the honest status is code-complete,
unverified.

## Kill gate

Stop and report to the coordinator (do not improvise) if:

- re-measurement at build time differs from **31** (scope moved again under us);
- any computed-style or screenshot drift appears after the move (cascade drift = blocker, not a
  tuning invitation);
- `check:ui-classes` discovery turns up a package sheet whose classes collide with a web
  definition in a way that flips a computed value (escape hatch decision belongs to the
  coordinator per spec line 97-100);
- the branch no longer fast-forwards from `81205868d` (a later child landed out of order).

## Collision boundaries

- **#1500 / child D (merged, `81205868d`, ancestor of this branch):** touched the two
  `components-forms.css` files and the tail of `MIGRATED_SECTION_CSS_FILES`. Our only overlap is
  appending after its registration entry — no file-content conflict.
- **#1502 / child F (next, not started):** owns `apps/web/src/styles.css`, the coupled
  `button.module-link` font shorthand, and will **extend the `components-web.css` this child
  creates**. E must merge before F is dispatched (spec ordering rule). E therefore must not touch
  `apps/web/src/styles.css` or move anything from it.
- **#1503 / child G:** owns guard 4's app-scope graduation in `check-design-tokens.ts`. E's
  script change is confined to `check-ui-classes.ts` + its test; E must not alter
  `checkTokens`/`checkBannedProperties` scope logic, only the registration array.
- Shared seams touched by E: `packages/ui/src/styles.css` (import tail),
  `MIGRATED_SECTION_CSS_FILES` (array tail), `scripts/check-ui-classes.ts` (E-exclusive per
  spec). No other in-flight issue touches these today.

## Non-goals

- No selector rename, token/value change, markup/TSX change, or new component.
- No repo-wide CSS classifier; discovery is `packages/ui/src/styles` only, web stays explicit
  (that graduation is child G's, and only for guard 4).
- No change to `BANNED_VISUAL_PROPERTIES`, no CSS parser, no new dependency.
- No cleanup of non-banned visual-ish properties (`transition`, `letter-spacing`,
  `line-height`, `opacity`, `mix-blend-mode` stay where they are).
- Release note: Category N/A — visually inert by acceptance; nothing user-visible.
