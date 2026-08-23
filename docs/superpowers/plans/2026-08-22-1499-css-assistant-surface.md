# Plan: #1499 / #1427-C — finish assistant-surface CSS registration

Spec: `docs/superpowers/specs/2026-08-10-css-guard-residue.md`, child C row (line 143) and
"Other residue" section (line 86). Issue: #1499, part of #1427/#1470.

## Seams check

- Source file `apps/web/src/chat/assistant-surface/assistant-surface.css` exists, 90 lines,
  re-measured at 9 banned declarations via `checkBannedProperties` with the file passed
  explicitly — matches the spec's baseline exactly. Confirmed 2026-08-22, this session.
- The 9 declarations, by selector (source lines as of this plan):
  - `.assistant-surface__identity` (31-40): `color`, `font-size`, `font-weight`
  - `.assistant-surface__composer textarea` (74-85): `border`, `border-radius`, `background`,
    `color`
  - `.assistant-surface__composer textarea:focus-visible` (87-90): `outline`, `box-shadow`
- `packages/ui/src/styles/components-chat.css` already exists (686 lines, well under the 1000-line
  gate), is already imported at `packages/ui/src/styles.css:5`, and already uses the file's
  established convention of `/* from apps/web/src/X.css */` comment blocks grouping declarations
  by source file (e.g. lines 3, matching entries for kit-chat.css etc.) — new block appends the
  same way, no new import needed.
- No selector under `packages/ui/src/styles/components-chat.css` matches `.assistant-surface*`
  today (grepped, zero hits) — no collision, no cascade-order dependency to resolve on the move.
- No `font: inherit` shorthand is among the 9 moved declarations (`.assistant-surface__composer
  textarea` has `font: inherit` but that property name is not in `BANNED_VISUAL_PROPERTIES` and
  stays in the app file) — the spec's shorthand-coupling rule (line 75) applies to children A/F
  only, not C.
- `scripts/check-design-tokens.ts:89-` — `MIGRATED_SECTION_CSS_FILES` is the registration array.
  Adding `apps/web/src/chat/assistant-surface/assistant-surface.css` here is the "temporary guard
  registration" named in scope.
- No `jds-*` class names are used by assistant-surface selectors (all are `.assistant-surface__*`
  or bare `textarea`) — `check:ui-classes`' `DEFINITION_FILES` guard only covers literal `jds-*`
  usage, so it needs no change here (confirmed by reading `scripts/check-ui-classes.ts:4-16`).
- `tests/e2e/assistant-surface.spec.ts` exists (115 lines) and already renders `.assistant-surface`
  through a real browser with real CSS cascade (mocked API only) — this is the proof mechanism the
  spec names for child C (line 190), not a new test file.

## Task 1 — move the 9 banned declarations into components-chat.css

Append a new block to the end of `packages/ui/src/styles/components-chat.css`:

```css
/* from apps/web/src/chat/assistant-surface/assistant-surface.css */
.assistant-surface__identity {
  color: var(--text-muted);
  font-size: var(--text-2xs);
  font-weight: 700;
}

.assistant-surface__composer textarea {
  border: var(--border-w) solid var(--border-strong);
  border-radius: var(--radius-md);
  background: var(--surface-2);
  color: var(--text);
}

.assistant-surface__composer textarea:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px var(--focus-ring);
}
```

Remove the same 9 declarations (and only those) from
`apps/web/src/chat/assistant-surface/assistant-surface.css`, keeping every other property
(`display`, `flex`, `align-items`, `gap`, `padding-top`, `min-width`, `resize`, `font: inherit`,
`line-height`, `padding`) in place at their existing selectors.

`.assistant-surface__composer textarea:focus-visible` has only these 2 declarations, so removing
them leaves it empty — delete the whole rule from the app file per the spec's empty-rule
instruction (line 160).

## Task 2 — register the guard

Append `"apps/web/src/chat/assistant-surface/assistant-surface.css"` to
`MIGRATED_SECTION_CSS_FILES` in `scripts/check-design-tokens.ts`, keeping the array's existing
one-per-line style.

## Verification

```bash
pnpm exec tsx /tmp/check-assistant.mjs > /tmp/ac-count.log 2>&1; echo "EXIT=$?"; cat /tmp/ac-count.log
```

(Same throwaway script used in this session's pre-plan measurement — calls `checkBannedProperties`
against the assistant-surface path alone.) Expect `count: 0`, `EXIT=0`.

```bash
pnpm check:design-tokens > /tmp/cdt.log 2>&1; echo "EXIT=$?"
pnpm check:ui-classes > /tmp/cuc.log 2>&1; echo "EXIT=$?"
pnpm check:file-size > /tmp/cfs.log 2>&1; echo "EXIT=$?"
pnpm exec vitest run tests/unit/check-design-tokens.test.ts > /tmp/vt.log 2>&1; echo "EXIT=$?"
```

Expect `EXIT=0` on all four.

```bash
pnpm exec playwright test tests/e2e/assistant-surface.spec.ts > /tmp/e2e-as.log 2>&1; echo "EXIT=$?"
```

Expect `EXIT=0` — this is child C's designated functional/browser proof per the spec.

## Task 3 — browser proof (light and dark)

The embedded assistant surface, screenshotted before this change (from `main`, using the same
mocked page state the e2e spec sets up) and after, in light and dark mode, compared for
pixel-identical result. Record both screenshots in the PR. No new Playwright spec is added — the
existing `tests/e2e/assistant-surface.spec.ts` run above is the automated proof; the screenshots
are the manual visual-diff proof the spec requires on top of it (line 178).

## Kill gate

If the post-move screenshot differs from the pre-move screenshot in any way other than
antialiasing noise, stop before opening the PR, revert the CSS move, and escalate to the
coordinator with the specific selector and property that changed. Call made by this build agent;
escalation is mandatory since child C explicitly disclaims any intentional pixel change (spec line
182).

## Non-goals

No selector rename, no markup change, no token value change, no touching `styles.css`,
`kit-today*.css`, `command-palette.css`, or any other child's files. No change to
`check-ui-classes.ts` (that is child E). No guard graduation (child G).
