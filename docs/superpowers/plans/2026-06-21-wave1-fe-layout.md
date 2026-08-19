# Wave 1 / Lane A — Mobile & Shell Layout Fixes Implementation Plan

> **For agentic workers:** This is a coordinated-build plan. The build agent drives it
> task-by-task inline (the subagent execution skills are disabled in this repo). Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix five mobile/shell layout defects (#389 #390 #384 #388 #391) in `apps/web` as one PR — responsive-polish scope only, no behavioural change.

**Architecture:** Pure CSS layout fixes (plus, where unavoidable, a class hook in TSX). Each surface gets a deliberate small-width layout. No new components, API, schema, or state. Verified by not regressing existing unit/e2e tests + visual capture at phone widths.

**Tech Stack:** React + Vite + bespoke `jds-*` / kit CSS design system. Verification: `pnpm lint/format:check/check:file-size/typecheck/build:web`, optional focused browser assertions.

## Global Constraints

- **Bug-fix / responsive-polish scope ONLY** — no new features, endpoints, migrations, or behavioural change. If a fix needs any of those → STOP, escalate to Coordinator.
- **File-size cap 1000 lines** (`pnpm check:file-size`, incl. CSS). Current near-cap files: `styles.css` (975), `kit-tasks.css` (962). **Do NOT add lines to those two.** Route additions to files with headroom: `components-jarvis.css` (794), `kit-calendar.css` (772), `settings.css` (310), `tasks/tasks.css` (487).
- **Do NOT touch wellness files** (`wellness-*.css`, `wellness-today.tsx`) — Lane B's surface.
- Stage only this lane's explicit paths (`git add <paths>`), never `git add -A`/`.`.
- Never edit `docs/coordination/`.
- Verify at phone widths (~375–430px) AND desktop (don't regress desktop).
- CSS cascade: `tasks.css` loads after `kit-tasks.css` (tasks-page.tsx L36 then L38) → overrides there win. `components-jarvis.css` houses all `jds-usermenu*` rules.

## File Structure

| File                                        | Responsibility                                                                    | Headroom |
| ------------------------------------------- | --------------------------------------------------------------------------------- | -------- |
| `apps/web/src/styles/components-jarvis.css` | `jds-usermenu` / `jds-miniswitch` — #390 alignment + #389 mobile sticky rail-foot | 794/1000 |
| `apps/web/src/styles/kit-calendar.css`      | calendar toolbar — #384 mobile breakpoint                                         | 772/1000 |
| `apps/web/src/tasks/tasks.css`              | `.tk-bar` — #388 mobile layout (override of kit-tasks base)                       | 487/1000 |
| `apps/web/src/styles/settings.css`          | `.set2*` — #391 phone-width tightening                                            | 310/1000 |

No TSX changes anticipated (all five are addressable in CSS). If a fix genuinely needs a markup/class hook, add the minimal `className` only.

---

### Task 1: #390 — Theme miniswitch contained & aligned in user menu (desktop + mobile)

**Files:**

- Modify: `apps/web/src/styles/components-jarvis.css` (`.jds-usermenu__tr`, `.jds-miniswitch` block ~L731–787)

**Root cause (verified by read):** `.jds-usermenu__tr { flex: none }` holds the 30px switch, but the trailing slot has no explicit alignment/box-sizing and the switch's knob is `position:absolute` inside a `position:relative` 30px track. On both platforms the switch can render visually outside the item's right edge because the slot isn't anchored to the row's end and the track has no flex/centering guard. Fix: make the trailing slot a right-aligned, centered, non-shrinking inline-flex box and harden the miniswitch box model so it stays within the popover bounds.

- [ ] **Step 1: Apply the fix** — set the trailing slot to anchor the control at the row end and harden the switch box model.

In `.jds-usermenu__tr` (currently `{ flex: none; }`) replace with:

```css
.jds-usermenu__tr {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  margin-left: auto;
}
```

And in `.jds-miniswitch` (the `width: 30px; height: 18px; ... flex: none;` block) add `box-sizing: border-box;` so the absolutely-positioned knob track keeps a fixed footprint:

```css
.jds-miniswitch {
  width: 30px;
  height: 18px;
  border-radius: var(--radius-pill);
  background: var(--border-strong);
  position: relative;
  flex: none;
  box-sizing: border-box;
  transition: var(--transition-control);
}
```

- [ ] **Step 2: Verify** — `pnpm build:web` succeeds. Visually (capture or manual at desktop + 390px): the Dark-mode switch sits flush at the right inside the popover, vertically centered, fully on-screen; toggling still flips it.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/styles/components-jarvis.css
git commit -m "fix(#390): contain theme miniswitch within user-menu trailing slot"
```

---

### Task 2: #389 — User quick-menu reachable without scrolling on mobile

**Files:**

- Modify: `apps/web/src/styles/components-jarvis.css` (add a mobile rule for `.rail-foot` containing the user menu)

**Root cause (verified by read):** At `≤880px` the sidebar becomes `position: fixed; inset: 0 auto 0 0` (full-height drawer) with `overflow-y: auto`. `.rail-foot` uses `margin-top: auto` to pin to the bottom — but when the nav list is tall enough to overflow the viewport, the foot follows the scrollable content and drops below the fold. Fix: on mobile make the rail-foot **sticky to the bottom of the scroll container** so the account trigger is always visible while the module list scrolls behind it. The popover already opens upward (`bottom: calc(100% + 10px)`), so a bottom-pinned trigger keeps the popover on-screen.

- [ ] **Step 1: Apply the fix** — append a mobile rule near the end of the user-menu section (before the existing `@media (prefers-reduced-motion)` block, i.e. after the `.jds-miniswitch[data-on] > span` rule):

```css
/* On mobile the rail is a fixed full-height drawer that can scroll; keep the
   account quick-menu pinned to the bottom so it's reachable without scrolling. */
@media (max-width: 880px) {
  .rail-foot {
    position: sticky;
    bottom: 0;
    margin-top: auto;
    background: var(--surface-raised);
  }
}
```

- [ ] **Step 2: Verify** — at 375–430px with the nav drawer open, the account trigger stays visible at the drawer bottom while the module list scrolls; tapping it opens the popover fully on-screen (not clipped, not under the chat dock). Desktop unchanged. `pnpm build:web` succeeds.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/styles/components-jarvis.css
git commit -m "fix(#389): pin account quick-menu to rail foot on mobile"
```

---

### Task 3: #384 — Calendar header stacks instead of overlapping the view toggle (mobile)

**Files:**

- Modify: `apps/web/src/styles/kit-calendar.css` (add a mobile breakpoint near the toolbar rules, e.g. after `.cal-range__dow` ~L60)

**Root cause (verified by read):** `.cal-toolbar { display:flex; justify-content:space-between; gap:16px }` with `.cal-range { white-space:nowrap; font-size:22px }` on the left and the view-toggle (`.cal-toolbar__right { flex:none }`) on the right. There is no mobile breakpoint (only `prefers-reduced-motion`). At narrow widths the nowrap 22px range label can't shrink and visually overlaps the fixed-width right toggle. Fix: at phone widths let the toolbar wrap so the right group drops to its own full-width row, and reduce the range font/padding.

- [ ] **Step 1: Apply the fix** — add after the `.cal-range__dow` rule:

```css
@media (max-width: 560px) {
  .cal-toolbar {
    flex-wrap: wrap;
    gap: 10px 12px;
    padding: 14px 16px 10px;
  }
  .cal-toolbar__right {
    flex: 1 0 100%;
    justify-content: flex-start;
  }
  .cal-range {
    font-size: 18px;
    white-space: normal;
  }
}
```

- [ ] **Step 2: Verify** — at 375–430px the month/range label and the day/week/month toggle no longer overlap (toggle sits on its own row below the nav/label); desktop layout unchanged. `pnpm build:web` succeeds.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/styles/kit-calendar.css
git commit -m "fix(#384): add calendar toolbar mobile breakpoint to stop header/toggle overlap"
```

---

### Task 4: #388 — Tasks header bar reflows cleanly on mobile

**Files:**

- Modify: `apps/web/src/tasks/tasks.css` (add a mobile breakpoint for `.tk-bar`; loads after kit-tasks so it overrides)

**Root cause (verified by read):** `.tk-bar { display:flex; flex-wrap:wrap; gap:12px 14px }` with `.tk-bar__spacer { flex: 1 1 24px }` pushing the view toggle to the right. When controls wrap, the flexible spacer can land mid-row and orphan the view toggle on its own line, producing uneven rows when lists toggle. Fix: at phone widths neutralize the spacer (so it doesn't force a break) and give the bar a deliberate, stable wrap with the search field taking a full row.

- [ ] **Step 1: Apply the fix** — append to `tasks.css` (after existing rules; it already has `@media` blocks):

```css
/* Mobile: deliberate wrap for the tasks toolbar so controls don't orphan a
   single control on its own line when lists are toggled (#388). */
@media (max-width: 560px) {
  .tk-bar {
    gap: 8px 10px;
  }
  .tk-bar__spacer {
    flex-basis: 0;
  }
  .tk-bar__sep {
    display: none;
  }
  .tk-tagfield {
    flex: 1 1 100%;
  }
}
```

- [ ] **Step 2: Verify** — at 375–430px the toolbar wraps into even rows with the search field spanning its own row; toggling a list's visibility does not orphan the view dropdown on a line by itself. Desktop unchanged. `pnpm build:web` succeeds.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/tasks/tasks.css
git commit -m "fix(#388): deliberate mobile wrap for tasks toolbar"
```

---

### Task 5: #391 — Settings panes optimized for phone widths

**Files:**

- Modify: `apps/web/src/styles/settings.css` (add a tighter phone breakpoint below the existing `@media (max-width:860px)` rules)

**Root cause (verified by read):** A `@media (max-width:860px)` block collapses the grid to one column and turns the nav into a wrapped row, but `.set2` keeps `padding: 24px 40px 88px` — 80px of horizontal padding wastes a phone's width, cramping pane content (forms, toggles, the connected-accounts/data panes). Fix: at phone widths cut `.set2` horizontal padding and tighten the nav so panes get usable width.

- [ ] **Step 1: Apply the fix** — append after the existing `.set2__navnote` mobile block (end of the nav section, ~L180):

```css
/* Phone widths: reclaim horizontal space the desktop padding wastes and let
   the sub-nav chips sit compactly above the pane content (#391). */
@media (max-width: 520px) {
  .set2 {
    padding: 16px 14px 64px;
  }
  .set2__grid {
    gap: 6px;
  }
  .set2__navitem {
    width: auto;
    flex: 0 1 auto;
    padding: 7px 10px;
  }
  .set2__navitem .lbl {
    font-size: 13px;
  }
}
```

- [ ] **Step 2: Verify** — at 375–430px the settings content uses the full phone width (no ~80px wasted side padding), the sub-nav chips wrap compactly above the pane, and pane forms/toggles aren't cramped. Nav→pane navigation still works. Desktop + the 860px tablet layout unchanged. `pnpm build:web` succeeds.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/styles/settings.css
git commit -m "fix(#391): tighten settings layout at phone widths"
```

---

### Task 6: Full gate + visual verification

- [ ] **Step 1: File-size + static gate** (real exit codes, no pipe-to-tail):

```bash
pnpm lint && echo "lint=$?"
pnpm format:check && echo "fmt=$?"
pnpm check:file-size && echo "size=$?"
pnpm typecheck && echo "tc=$?"
pnpm build:web && echo "build=$?"
```

Expected: all exit 0. (`check:file-size` confirms no CSS file crossed 1000.)

- [ ] **Step 2: Layout verification** — run focused browser DOM/layout assertions at phone and desktop widths. Confirm no desktop regression.

- [ ] **Step 3: Close out** — invoke `coordinated-wrap-up`: clean tree, pre-push trio + rebase on `origin/main`, push branch, open PR (base `main`) titled `fix: wave1 mobile/shell layout (#389 #390 #384 #388 #391)` with `Fixes #389` … `Fixes #391` in the body. Report PR # + verified exit codes to Coordinator.

## Self-Review

- **Spec coverage:** all five issues (#389 nav-foot, #390 miniswitch, #384 calendar header, #388 tasks bar, #391 settings) each have a task. ✓
- **File-size safety:** no additions to `styles.css` (975) or `kit-tasks.css` (962); all additions to files with ≥200 lines headroom. ✓
- **Cascade:** `tasks.css` override loads after `kit-tasks.css`; usermenu/calendar/settings additions are in the same file as their base rules. ✓
- **Scope:** zero behavioural/API/schema/migration change; no wellness files. ✓
- **Risk note:** #390 fix touches desktop too (the bug is cross-platform per the issue) — verify desktop popover explicitly.
