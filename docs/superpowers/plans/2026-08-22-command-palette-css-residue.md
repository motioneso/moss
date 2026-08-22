# Plan: #1498 / #1427-B — extract command-palette visual CSS into @moss/ui

Spec: `docs/superpowers/specs/2026-08-10-css-guard-residue.md`, child B row (line 142) and
"Other residue" section (line 89). Issue: #1498, part of #1427/#1470.

## Seams check

- Source file `apps/web/src/styles/command-palette.css` exists, 211 lines, re-measured at 48
  banned declarations via `checkBannedProperties` with the file passed explicitly — matches the
  spec's baseline exactly. Confirmed 2026-08-22, this session.
- No `.kbar*` selector exists anywhere under `packages/ui/src/styles/*.css` today (grepped, zero
  hits) — no collision to resolve on the move.
- `packages/ui/src/styles.css:1-17` is the UI package's style entry; it `@import`s one file per
  section, alphabetically-unordered but grouped by ownership. No existing rule there orders by
  cascade need — new entries are appended.
- `apps/web/src/styles/index.css:8-18` is the app's global cascade. `@import "@moss/ui/styles.css"`
  (line 9) loads before `@import "./command-palette.css"` (line 12). Because no other package
  sheet defines a `.kbar*` selector, insertion position inside `packages/ui/src/styles.css` does
  not affect computed output — confirmed by the grep above, not assumed.
- `scripts/check-design-tokens.ts:78-107` — `MIGRATED_SECTION_CSS_FILES` is the registration
  array. Adding `apps/web/src/styles/command-palette.css` here is the "temporary registration"
  named in scope.
- No `jds-*` class names are used by command-palette selectors (spec line 111, confirmed by
  reading the file — all selectors are `.kbar*`), so `check:ui-classes` needs no change here.

## Task 1 — create the package stylesheet and move declarations

Create `packages/ui/src/styles/components-command-palette.css`. For each rule below, move only the
banned properties (color, background, background-color, background-image, border, border-color,
border-radius, font-family, font-size, font-weight, box-shadow, outline, fill, stroke, filter),
verbatim value, same selector, same declaration order relative to each other. Leave every other
property (layout: position, display, flex/grid, spacing, sizing, animation, z-index, cursor,
overflow) in the app file.

Selectors touched (from the 48-line measurement, source line numbers as of this plan):
`.kbar-scrim`, `.kbar`, `.kbar__input input`, `.kbar__input input:focus`,
`.kbar__input input::placeholder`, `.kbar__input .ic`, `.kbar__esc`, `.kbar__group`, `.kbar__item`,
`.kbar__item.is-active`, `.kbar__item.is-active .ic`, `.kbar__item .ic`, `.kbar__item .lbl .t`,
`.kbar__item .lbl .d`, `.kbar__item .sc`, `.kbar__empty`, `.kbar__foot`, `.kbar__foot kbd`.

No shorthand/longhand coupling exists in this file (no `font: inherit` present) — the spec's
coupling rule (line 74) applies to child A/F only, not B.

Empty selectors: if removing the banned properties leaves a rule with zero declarations, delete
the whole rule from the app file (e.g. do not leave `.kbar__input input:focus {}` behind).

Register the new sheet: append `@import "./styles/components-command-palette.css";` to
`packages/ui/src/styles.css` (after the existing last entry, matching the file's append-only
convention).

Register the app source for the guard: append `"apps/web/src/styles/command-palette.css"` to
`MIGRATED_SECTION_CSS_FILES` in `scripts/check-design-tokens.ts`.

Verification:

```bash
pnpm exec tsx /tmp/measure-cp.mjs > /tmp/cp-count.log 2>&1; echo "EXIT=$?"; cat /tmp/cp-count.log
```

Expect `count: 0`, `EXIT=0`. (Script already exists at `/tmp/measure-cp.mjs` from this session's
pre-plan measurement; re-usable as-is since it takes no arguments beyond cwd.)

```bash
pnpm check:design-tokens > /tmp/cdt.log 2>&1; echo "EXIT=$?"
pnpm check:ui-classes > /tmp/cuc.log 2>&1; echo "EXIT=$?"
pnpm check:file-size > /tmp/cfs.log 2>&1; echo "EXIT=$?"
pnpm exec vitest run tests/unit/check-design-tokens.test.ts > /tmp/vt.log 2>&1; echo "EXIT=$?"
```

Expect `EXIT=0` on all four.

## Task 2 — browser proof

Command palette open (Ctrl/Cmd+K) on the live dev instance, light and dark mode, screenshotted
before this change (from `main`) and after, compared for pixel-identical result. This is the
spec's required child-B proof (line 178). No Playwright spec exists for the command palette today
(grepped `tests/e2e` and `tests/uat` for "command-palette" and "kbar" — zero hits) — proof is
manual screenshot comparison, not an automated e2e run, and the PR will say so plainly rather than
claim UAT coverage it does not have.

## Kill gate

If the post-move screenshot differs from the pre-move screenshot in any way other than
antialiasing noise, stop before opening the PR, revert the CSS move, and escalate to the
coordinator with the specific selector and property that changed. Call made by this build agent;
escalation is mandatory, not optional, since child B explicitly disclaims any intentional pixel
change (spec line 182).

## Non-goals

No selector rename, no markup change, no token value change, no touching `styles.css`,
`kit-today*.css`, `assistant-surface.css`, or any other child's files. No change to
`check-ui-classes.ts` (that is child E). No guard graduation (child G).
