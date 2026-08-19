# #1395 Settings relay 9 → 10 handoff

Context-meter checkpoint at 70%. HEAD is `d44b8505`, tree clean except
`.claude/context-meter.log` (not mine). Task 4 is DONE and committed this relay.
Remaining: Task 5 (registration), Task 6 (e2e), Task 7 (gate + PR).

## Read order

1. This doc
2. `docs/superpowers/handoffs/2026-08-05-ui-1395-settings-relay-8.md` — still accurate for
   Tasks 0-3e state and every standing ruling. Its Task 4 "what's left to do" list is now DONE;
   don't redo it.
3. Only if something here doesn't answer a question or seems to contradict: the two GitHub
   comments named in relay 8's doc (plan `5195260909`, approval `5195303202` — approval wins).

## What happened this relay

Rebased onto `origin/main` (`git fetch && git rebase origin/main`, one stash-pop of
`.claude/context-meter.log` around it, no conflicts — 20 commits replayed cleanly). HEAD moved
from `f49f70fd` to `cf0b8048` before Task 4's own commit. Confirmed `origin/main` tip
`80e70bf0` per the coordinator's message, confirmed `packages/ui/src/styles.css` on main ends
with the three `#1394` import lines as described.

**Discovered mid-relay: CLAUDE.md changed under the rebase.** It now mandates three project-local
skills that didn't exist when relay 8 wrote its doc: `shared-checkout` (before any commit/tree-wide
git action), `verify-gate` (the *only* safe way to run `verify:foundation` or any DB-touching
command — **read this before Task 7**, don't just follow relay 7/8's inline gate-discipline prose),
and `design-system` (before any CSS/component work). All three live at
`.claude/skills/<name>/SKILL.md` in this worktree and are now in the Skill-tool listing. Use them —
don't fall back to the older inline instructions in relay 7/8's docs where they overlap; the skills
are the newer, more specific source.

Re-ran `/tmp/1395-split-css.js` against the post-rebase files: **identical numbers to relay 8's
table** (18/48/63/70 shared selectors, 0 shared properties everywhere, same layout/visual line
counts). Zero drift, as expected since #1394 never touched settings files.

**Applied the split for real** (relay 8's 10-step list, all done):
- `apps/web/src/styles/{settings,settings-panes,settings-panes-2,settings-panes-3}.css` overwritten
  with layout-only content, each with one new sentence appended to its existing header comment
  (wellness-style, cites `#1395` and the correct destination component file).
- `packages/ui/src/styles/components-settings-1.css` (435 lines: settings.css + settings-panes.css
  visual, wellness-style header) and `components-settings-2.css` (843 lines: settings-panes-2.css +
  settings-panes-3.css visual) created new.
- Two new `@import` lines appended to `packages/ui/src/styles.css`, after the three `#1394` lines.
- Spot-checked byte-for-byte: the `.set2__navgroup` mixed `@media` block (relay 8 flagged this one
  explicitly — confirmed the media block's `flex`/`padding` stay layout-side, the base rule's
  `font-family`/`font-size`/`font-weight`/`color` move to visual, exactly as predicted), and all
  three Task 3e sites (`.theme-swatch`, `.psona-save__state--error`, `.fld__sep`) — all split
  exactly as relay 8 described in prose.
- Ran `pnpm check:design-tokens` and `pnpm check:migrated-sections` (no DB, safe to run directly,
  didn't need the `verify-gate` skill for these) — **both green**. This is pre-registration, so it
  only proves the split itself introduced no banned properties into the layout files; it says
  nothing about registration (Task 5, still to do).
- Committed as `d44b8505`, 7 explicit paths (never touched `.claude/context-meter.log`), diffed
  every file first, `git show --name-only HEAD` after — matched intent exactly.

**Shared checkout**: this worktree has a second Claude pane on it, `ui-1395-relay8`
(agent_session `8169e386-d081-4c78-aa22-1188b0dc58e7`, pane reflows — resolve fresh from
`herdr pane list`/`herdr agent list`), status `done` (not `working`) as of this relay. I sent it a
heads-up before the rebase via `herdr agent prompt` per the `shared-checkout` skill; it did not
reply or appear to touch the tree. Re-check `herdr pane list` before your own next tree-wide action
in case it or another pane resumed since.

## What's left — Task 5, 6, 7 (unchanged in substance from relay 8's doc, restating deltas only)

**Task 5 registration**: compute absolutes off `origin/main` post-rebase — **re-verify with
`git log origin/main -1` yourself**, don't trust any number (including this doc's) unverified.
Relay 8's arithmetic was 23/59 (main) + 4/31 (delta) = 27/90; recompute for real. Register the two
new CSS files + however many of the TSX files in this section's scope in
`scripts/check-design-tokens.ts` and `scripts/check-migrated-sections.ts`, **and** the SECOND
hardcoded `DEFINITION_FILES` list inside `check-ui-classes.test.ts` (editing only the script leaves
that test fixture ENOENT). Prove it's not a no-op with TWO separate proofs per guard: (a)
red-before/green-after on an injected violation, (b) confirm every path you add resolves to a real
file (`test -f`) — both guards `catch { continue }` silently on an unreadable path.

**Task 6 e2e**: grep `tests/e2e` for assertions keyed to any control converted in this section,
including relay 7's swatch/save-status/quiet-hours markup. Run
`pnpm test:e2e > /tmp/e2e-1395.log 2>&1; echo "EXIT=$?"` — unpiped, separate from
`verify:foundation` (which excludes it).

**Task 7 gate + PR**: **read the `verify-gate` skill before running anything DB-touching** — it
supersedes the inline "fresh gate DB, never live dev, never piped" prose in relay 7/8's docs with
the actual current procedure. PR body must carry: the 199/0 split-check (now re-derivable directly
from the diff of commit `d44b8505`, no need to re-run the splitter on committed files — running it
against the *already-split* layout files trivially shows 0/0 since there's nothing left to split;
the real 199/0 number is the pre-split one already stated in this doc and the commit message);
statement that CI's "Verify foundation and app" runs the browser suite and the local gate doesn't;
Browser assertions are corroboration not proof (one state per section, can't cover
Switch/Segmented/Select/Badge/Avatar/Indicator/ComingSoon); which `#1416` importers this PR closes
(settings panes) vs. doesn't (six module packages + `apps/web/src/tasks/task-details-dialog.tsx`) —
post that as a factual comment on #1416, don't re-scope it.

**Expect the coordinator to hold the merge on a live-path walk** — said explicitly, twice now
(relay 7's doc and the original brief). Do NOT merge the PR, do NOT close #1395.

## Binding rulings — unchanged, do not re-litigate

`--st-swatch` not `--swatch` (already allowlisted in `check-design-tokens.ts`, confirmed present
pre-split). `Dialog.className` layout-only. No settings IA changes (#983's territory). `forms.css`
and `command-palette.css` out of scope. `INLINE_STYLE_EXEMPT_PATHS` off limits. The two
`jds-dialog` hits in comments (`terminal-modal.tsx:32`, `settings-feedback.tsx:18`) are legal, don't
touch. Don't re-scope #1416.

## Reminders that still apply

Never pipe gate output through `tail`/`grep`. Explicit-path commits only; diff before, `git show
--name-only HEAD` after. Check `herdr pane list` before any tree-wide action; use the
`shared-checkout` skill, not just memory of its rules. Report to the coordinator via
`herdr-pane-message` (pane label "DESIGN ELEMENTS", re-resolve `pane_id` fresh — do not reuse
`w1:p1` from an old doc without confirming). Do NOT merge the eventual PR, do NOT close the issue.
At the next context checkpoint: write+commit a handoff doc, message the coordinator, STOP — do not
self-spawn a successor via the Agent tool. That's an explicit override from the coordinator on this
chain, given twice now.
