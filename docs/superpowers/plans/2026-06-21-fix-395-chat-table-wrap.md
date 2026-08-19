# Fix #395 — Chat markdown tables overflow horizontally Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: drive this plan task-by-task with
> superpowers:test-driven-development (the execution sub-skills are disabled in this repo).
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Markdown tables in chat assistant replies fit/wrap within the chat column on desktop and
mobile instead of overflowing the layout and forcing whole-page horizontal scroll.

**Architecture:** CSS-only fix in `apps/web/src/styles/kit-chat.css`. Two parts: (1) root-cause —
the assistant `.chatd-bubble` is a flex child of `.chatd-msg` (`display:flex`) with default
`min-width:auto`, so it refuses to shrink below a wide table's intrinsic width and drags the whole
row past the panel; add `min-width:0` so it shrinks to the available column. (2) table layout —
replace the `display:block; width:max-content` table rule with `table-layout:fixed; width:100%` and
let cells wrap (`white-space:normal; overflow-wrap:anywhere; word-break:break-word`) so the table
always fits the bubble and reflows on narrow widths. No JS / markup / sanitization changes — the
renderer (`markdown-message.tsx`, react-markdown + remark-gfm, no `rehype-raw`) is untouched.

**Tech Stack:** CSS (bespoke `chatd-*` / `kit-*` chat design system), react-markdown, Playwright
(visual verification harness).

## Global Constraints

- UI/CSS only — no schema, auth, secret, or shared-contract surface (risk tier `routine`).
- Do NOT alter the message-render / sanitization path (`markdown-message.tsx`). Presentational only.
- `pnpm check:file-size` caps every source file (incl. CSS) at 1000 lines — `kit-chat.css` is ~520
  lines; this fix adds <10 lines, no split needed.
- Keep all selectors scoped under `.chatd-md` / `.chatd-bubble`; don't regress the bespoke design
  system or leak styles app-wide.
- `git add` only the files this fix touches, by explicit path. Never `git add -A`.

---

### Task 1: Constrain the assistant bubble + fix table layout (CSS)

**Files:**

- Modify: `apps/web/src/styles/kit-chat.css` (the `.chatd-bubble` rule ~line 123; the
  `.chatd-md table` rule ~lines 502-510; the `.chatd-md th, td` rule ~lines 511-516)
- Verify (temporary, NOT committed): a throwaway Playwright DOM/layout assertion harness

**Interfaces:**

- Consumes: existing CSS tokens `--border`, `--surface-2`; existing DOM
  `.chatd-msg > .chatd-bubble > .chatd-md > table` emitted by `MarkdownMessage`.
- Produces: nothing other modules consume — presentational CSS only.

- [ ] **Step 1: Add `min-width: 0` to the shared `.chatd-bubble` rule** so the flex child can shrink
      below its content's intrinsic width (root cause of the layout overflow):

```css
.chatd-bubble {
  font-family: var(--font-serif);
  font-size: 15px;
  line-height: 1.55;
  color: var(--text);
  padding-top: 2px;
  min-width: 0; /* #395 — allow flex child to shrink so wide content (tables, code) stays in-column */
}
```

- [ ] **Step 2: Replace the `.chatd-md table` rule** — drop `display:block; width:max-content;
overflow-x:auto` (the max-content sizing is what makes cells never wrap); use a fixed layout that
      fills the bubble and always fits:

```css
.chatd-md table {
  border-collapse: collapse;
  width: 100%;
  max-width: 100%;
  table-layout: fixed;
  margin: 0 0 10px;
  font-size: 13px;
}
```

- [ ] **Step 3: Add wrapping to the `.chatd-md th, td` rule** so cell text reflows and long
      unbreakable tokens (URLs) break instead of forcing overflow:

```css
.chatd-md th,
.chatd-md td {
  border: 1px solid var(--border);
  padding: 5px 9px;
  text-align: left;
  white-space: normal;
  overflow-wrap: anywhere;
  word-break: break-word;
  vertical-align: top;
}
```

- [ ] **Step 4: Visual verification at desktop + mobile widths.** Write a throwaway harness
      `/tmp/t395/table.html` replicating the chat DOM (`.chatd-msg > .chatd-bubble > .chatd-md > table`)
      with a wide multi-column table + a long-URL cell, importing the real `kit-chat.css` and minimal
      token values. Assert layout at 390px (mobile) and 1280px (desktop) with Playwright. Expected: table
      stays within the bubble, no page-level horizontal scrollbar, cells wrap. Confirm BEFORE→AFTER
      (stash, measure, unstash, measure) that the before overflows and the after is contained. Delete the
      harness after — do NOT commit it.

- [ ] **Step 5: Run the pre-push trio**

Run: `pnpm format:check && pnpm lint && pnpm typecheck`
Expected: all green (CSS-only change; if `format:check` flags the edited file, run
`pnpm prettier --write apps/web/src/styles/kit-chat.css` on that file ONLY and re-check).

- [ ] **Step 6: Commit (only the one CSS file + this plan)**

```bash
git add apps/web/src/styles/kit-chat.css docs/superpowers/plans/2026-06-21-fix-395-chat-table-wrap.md
git commit -m "fix(chat): wrap/contain markdown tables so they fit the chat column (#395)"
```

---

## Self-Review

- **Spec coverage (#395):** "tables overflow horizontally, desktop + mobile" → Task 1 Steps 1-3
  (min-width root cause + fixed-layout wrapping table) fixes both widths. "wrap within chat column /
  sensible cell wrapping on narrow widths" → Step 3 wrapping cells. "global CSS fix in the chat
  markdown renderer, not per-breakpoint" → single un-mediaqueried rule set. Verified visually in
  Step 4.
- **Placeholder scan:** none — exact CSS shown for every edit.
- **Type consistency:** n/a (CSS); selectors match the DOM emitted by `markdown-message.tsx` and the
  existing `.chatd-*` rules confirmed in the tree.
- **Decision (wrap vs contained-scroll vs both):** chose `table-layout:fixed; width:100%` wrapping
  as primary — it guarantees the table never overflows at ANY width (strongest fix for the reported
  bug) and reads best on mobile, which the issue explicitly calls out. `overflow-wrap:anywhere`
  covers the long-token edge case. Contained-scroll was the alternative; rejected as primary because
  it still requires horizontal scroll on mobile for moderately-wide tables, which is the annoyance
  being reported. Escalate `[DESIGN-FORK]` only if visual check shows many-column tables too cramped.
