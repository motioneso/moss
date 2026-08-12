# Relay — fix-1429-briefing-css

**Issue:** #1429 (defect split off #1327, tier `routine`). **Branch:** `fix-1429-briefing-css`.
**Real worktree (use this, NOT the sibling path in the boot brief — that one has no `.git`,
silently resolves to the main checkout):**
`/home/ben/Jarv1s/.claude/worktrees/coord-overnight-20260810/.claude/worktrees/fix-1429-briefing-css`
`node_modules` already installed there — skip `pnpm install`.

**Coordinator:** label `Coordinator`, session id `0bb9f516-c026-454f-bc97-dc9faf43bd20`. Resolve
pane fresh via `herdr pane list` before messaging — never reuse a `…-N` from this doc. Already
notified of this relay (2026-08-12) with the summary below.

**Original handoff doc (still authoritative for exit criteria/bans):**
`docs/coordination/handoff-1429-briefing-css.md` in this same worktree.

**Status:** investigation complete, zero code written, zero commits. Full derived fix plan is
saved in memory — `mcp__plugin_agentmemory_agentmemory__memory_recall` or `memory_smart_search`
with project `jarv1s`, id `mem_msqm24px_be083d037e7a` — read that before re-deriving anything.

## Next step

Go straight into `coordinated-build`'s `plan-build` step using the plan below (do NOT re-read
`briefing-action-rows.tsx` or the CSS files in full again — you already have the plan; open files
only to make the actual edits). Get coordinator approval before writing code.

## Derived plan (4 issue items)

1. **CSS (primary defect):** `apps/web/src/today/briefing-action-rows.tsx:154-206` uses 6 classes
   defined nowhere: `loose-row`, `loose-row__ic`, `loose-row__main`, `loose-row__title`,
   `loose-row__meta`, `loose-row__act`. Only `.loose` exists
   (`apps/web/src/styles/kit-today-feeds.css:2`). Add the missing family to
   `kit-today-feeds.css` (that file is imported directly by `today-page.tsx` as a "feature kit" —
   confirmed NOT part of the global `index.css` cascade, matching `kit-tasks.css`'s tier). Model it
   on the existing `.tk-task` family in `kit-tasks.css:189-303` (icon+main+actions row,
   border-top separators, hover lift, token-based spacing/colors) — do not refactor the component
   onto `jds-fact`/`jds-perm` (checked: those primitives exist in
   `packages/ui/src/styles/components-moss.css` but are unused by any Today `.tsx`, so adopting
   them is a bigger, unnecessary blast radius for a routine-tier CSS fix). After writing, run the
   design-system skill's invented-class audit against `apps/web/src/today/` to confirm nothing
   else is missing:
   ```
   grep -rhoE "jds-[a-zA-Z0-9_-]+" apps/web/src/today/ | sort -u > /tmp/used.txt
   grep -rhoE "\.jds-[a-zA-Z0-9_-]+" apps/web/src/styles/ | sed 's/^\.//' | sort -u > /tmp/defined.txt
   comm -23 /tmp/used.txt /tmp/defined.txt
   ```
   Also audit `.loose-row*` itself against `kit-today-feeds.css` the same way (module-local hooks
   fail silently too).

2. **Inline styles bypassing the CSS layer (item 4, same pass):** replace with classNames driven by
   the new CSS:
   - `:132` `style={{ marginTop: 12 }}` on the Catch-up wrapper — give it a small dedicated class
     (e.g. `.briefing-catchup`) in `kit-today-feeds.css`.
   - `:154` `style={{ cursor: "default" }}` on the row div — fold into `.loose-row`.
   - `:161-169` full inline reset on the `<button className="loose-row__main">` (background,
     border, font, color, cursor, textAlign, padding) — fold into `.loose-row__main`.
   - `:176` `style={{ display: "flex", gap: 8, alignItems: "center" }}` on `.loose-row__act` —
     fold into `.loose-row__act`.

3. **Dead `primaryAction` branch (item 4):** `PrimaryControl` (`:211-249`) for `needs_action` /
   `time_sensitive_info` reads `row.sourceHref` directly (`:236`), never `row.primaryAction` — so
   the `{kind:"view",href}` object built in `rowsFromSuggestedTasks` (`:302-307`) is dead. Two
   valid fixes; pick whichever is smaller diff against the approved parent spec
   (`docs/superpowers/specs/2026-07-29-1327-briefing-action-rows.md` — read the action-row section
   only, not in full, before deciding): either (a) have `PrimaryControl` consult
   `row.primaryAction?.kind === "view"` first and fall back to `sourceHref`, or (b) stop
   constructing the dead `view` variant in `rowsFromSuggestedTasks` and simplify. Confirm against
   spec intent, don't guess.

4. **E2E test (item 2):** `tests/e2e/briefing-action-rows.spec.ts` — NOT YET READ THIS RELAY. It
   currently locates by the same broken classnames, which structurally can't catch a missing
   stylesheet. Rework it to assert something a missing/broken stylesheet would actually fail (e.g.
   computed style / layout assertion, not just presence of the class attribute). Read this file by
   section when you get to this task.

5. **Orphan tracking (item 4):** `scripts/check-migrated-sections.ts:51` still tracks
   `today-suggested-email.tsx` as orphaned. **Caveat found but not resolved:** a proactive context
   read this relay surfaced that `today-suggested-email.tsx` still contains live `jds-brief`
   markup — re-verify it's actually unused (search for real imports/render call sites) before
   touching the tracking entry. Don't take the issue's "orphaned" claim at face value.

## Confirmed NOT part of the defect (don't re-check)

- `.jds-brief` family — fully defined, `packages/ui/src/styles/components-moss.css:438-485`.
- `.cmd-empty` / `.cmd-leadin` — fully defined, `apps/web/src/styles.css:535-540` / `:543-549`.
- CSS cascade: `index.css` does NOT import kit-*.css files; each page component imports its own
  kit file directly. `apps/web/src/styles/index.css` read in full (19 lines) confirms this.

## Process reminder

`coordinated-build`: `plan-build` (plan) → coordinator approval (do NOT write code first) → TDD
build → `coordinated-wrap-up` (PR + live-path proof + report). Commit per task, not one giant
commit. `git add` by explicit path only — never `-A`/`.` (shared checkout). Never touch
`docs/coordination/`, the board, milestones, or merge. Don't touch #1428. Exit criteria: all 4
items resolved, full gate green on an isolated gate DB (`verify-gate` skill), PR open + rebased on
`origin/main`, live-path proof posted via `gh pr comment` (styled rows, live UI, screenshot).

Relay trigger for you too: context-meter 70% warning, or a compaction summary in your own context →
message the coordinator, then use `relay` immediately. If that fires before you've committed
anything, over-read happened — commit whatever's green, relay anyway, say so in your continuation
doc.
