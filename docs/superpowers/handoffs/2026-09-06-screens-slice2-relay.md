# Screens slice 2 - continuation notes

Issue: https://github.com/motioneso/moss/issues/2350
Worktree: /home/ben/Jarv1s/.claude/worktrees/screens-slice2, branch work/screens-slice2
Coordinator: agent name coordinator, pane resolved fresh each time (do not reuse a pane number
from this doc)

## Message from the coordinator, word for word, to carry forward

"Understood, and the findings are useful, especially confirming nothing outside the slice points
at the old builds page. Go straight to building. The scope question is settled, the file list is
approved, the colour and layout values are in hand, and there is nothing left to investigate. Do
not re-read the plan from the top, do not re-verify what this session already verified, and do not
send a research helper to look at anything. Write the plan in a few lines, send it to me, and start
cutting code the moment I approve it. This is the only relay this lane gets: if you find yourself
approaching seventy percent again, stop and report to me for a re-slice rather than handing off a
third time. Use the design system skill before the user interface work, since the design system
here is authored rather than generated and invented names get sent back. And post a screenshot of
dark mode on the pull request, because the dark field colour is Ben's to confirm and he wants to
see it."

## What is already settled - do not re-check any of this

**Scope conflict, resolved.** The brief said do not touch the Workshop package. The coordinator
confirmed that rule was too broad: build slice 2 exactly as the plan describes, including editing
and deleting files inside the Workshop package. The only file that is off limits is the project
conversation page (the screen at one project's own address, function `WorkshopProjectContent` in
`packages/workshop/src/web/project-pages.tsx`) - a different lane is changing that page and the
server behind it right now. Slice 2 never touches that function. If anything in slice 2 turns out
to need touching it, stop and tell the coordinator before editing it.

**Nothing outside the slice points at what you are deleting.** Checked with a repository-wide
search: the old builds page, its file, and its companion file are referenced only by each other,
by the route that is being removed, and by their own three test files. Two unrelated files
(`apps/web/src/app.tsx` and `apps/web/src/styles/kit-chat.css`) share the words "workshop-page" in
an unrelated class name for the draft preview panel - not the same thing, already ruled out by the
plan itself. Safe to delete without checking again.

## What to build (the file list from the plan, already read)

Read `docs/superpowers/plans/2026-09-05-park-press-finish-and-workshop-workspace.md`, the section
titled "Slice 2 - the green masthead, the row index, and the Workshop home page on them" (около
line 191), and the specification's "The masthead" and "Lists" sections in
`docs/superpowers/specs/2026-09-05-park-press-finish-design.md` (lines 104 to 262) if any exact
wording is needed. Do not read either document beyond those sections.

1. **`packages/ui/src/masthead.tsx`** - add a tone prop to the existing `Masthead` component for a
   reversed, full-bleed treatment (field touching the top bar, rule at the bottom, reversed text,
   no stripe). Use the masthead tokens already defined in `apps/web/src/styles/tokens.css` (lines
   313 to 319 for light, 441 to 449 for dark, 479 and 493 for two theme-specific tweaks to the
   quieter text) - they already exist from slice 1 and need no changes. The one button on the
   field needs a new button look coloured by `--masthead-action-bg` and `--masthead-action-fg`;
   none of the existing button looks in `packages/ui/src/button.tsx` (primary, secondary, quiet,
   accentSoft, danger) read correctly on the green field, so add one more.

2. **A new row-index component in `packages/ui`** (the plan's working name is `jds-index`; confirm
   or pick the final name using the design-system skill before writing it) - full width, a heavy
   dark rule on top, one thin rule under every row, a name column, an excerpt column, and
   right-aligned meta on the right. Hovering a row draws a thin gold line down its left edge and
   turns the name forest green - never a filled block. The exact numbers to copy are already
   worked out in a style sheet that is part of the mockup, not code:
   `docs/superpowers/specs/assets/2026-09-05-park-press-finish/park-press.css`, lines 186 to 245
   (search for "THE KEYLINE GRID"). It already uses the same design tokens this app ships
   (`--ink`, `--border`, `--text-subtle`, `--forest`, `--gold`, the `--space-*` and `--text-*`
   sizes), confirmed present in `apps/web/src/styles/tokens.css`. Export the new component from
   `packages/ui/src/index.ts` and run `pnpm build:ui-catalogue` afterward so
   `packages/ui/catalogue.json` picks it up automatically - do not hand-edit that file.

3. **`packages/workshop/src/web/project-pages.tsx`, only the `WorkshopProjectList` function** -
   render the new masthead tone with eyebrow "Workshop", title "Your projects", and a lede line
   from the mockup instead of the current `workshop-project-heading` markup; render the project
   list with the new row index instead of the card grid; each row shows the name as a link, the
   opening request as the excerpt, and on the right a neutral badge reading "Talking it through"
   (every project reads this way in this slice; the fuller set of states is a later slice) plus the
   date. Remove the footer link to "Earlier builds and installed modules" and the sentence that
   leans on privacy ("Start with an idea. Keep your projects and their conversations here."). Use
   `Badge` from `@moss/ui` with `tone="neutral"` and no dot for this state - the component already
   supports it, confirmed by reading `packages/ui/src/badge.tsx`. Do not touch any other function
   in this file - `WorkshopProjectCreate` and `WorkshopProjectDetail` / `WorkshopProjectContent`
   stay exactly as they are.

4. **Delete** `packages/workshop/src/web/workshop-page.tsx`,
   `packages/workshop/src/web/workshop-groups.tsx`, the `legacy` route and its import in
   `packages/workshop/src/web/project-routes.tsx`, and the three tests
   `tests/unit/workshop-page.test.tsx`, `tests/unit/workshop-groups-actions.test.tsx`,
   `tests/unit/workshop-groups.test.tsx`. Confirmed nothing else references any of this (see
   above). After removing the route, `/workshop/legacy` falls through to the existing catch-all
   route in the same file, which already renders a not-found message - nothing new to write there.

5. **`packages/workshop/src/web/workshop.css`** - remove the rules that belong only to the deleted
   card grid and the deleted old-builds page. Confirmed by reading the file and both deleted
   files' class names: safe to remove `.workshop-head`, `.workshop-lede`, `.workshop-groups`,
   `.workshop-group`, `.workshop-row`, `.workshop-log`, `.workshop-log-group`, `.workshop-spacer`,
   and the card-grid rules `.workshop-project-list` (both the grid rule and its card rule),
   `.workshop-project-card__title` (both rules), `.workshop-project-card__foot`,
   `.workshop-project-more`, `.workshop-project-footer`, and `.workshop-project-excerpt`. **Do
   not** remove `.workshop-project-heading`, `.workshop-project-heading__text`,
   `.workshop-project-heading__meta`, `.workshop-back`, `.workshop-project-detail`,
   `.workshop-project-messages`, `.workshop-project-form form`, `.workshop-project-pane` (and its
   heading rule), `.workshop-project-text`, `.workshop-mobile-tabs`, `.workshop-project-pane--inactive`,
   `.workshop-actions`, or `.workshop-empty-action` - all of these are still used by the project
   conversation page or the new-project form, which this slice does not touch. `.workshop-page`
   itself also stays; it is the page wrapper used everywhere.

6. **`packages/workshop/src/manifest.ts`** - in the `navigation` entry, drop the word "private"
   from the description. In the `workshop.view` permission entry, drop "private" and "see your
   earlier module builds" from its description. Leave `workshop.projects` and everything else
   alone.

## Acceptance, live proof, and things the plan says not to do

Copy these directly from the plan's Slice 2 section rather than re-deriving them - they are
already exact:

- `pnpm check:ui-catalogue`, the existing `tests/integration/workshop-projects.test.ts`, a new unit
  test for the row index (name, excerpt, meta in that order), and `pnpm build:app-map` all pass.
- A repository search for `workshop/legacy`, `workshop-page`, and `workshop-groups` finds nothing
  (already true once the deletions above are done).
- Live proof on the development instance (http://192.168.50.36:5173, login ben@ben.com / password
  jarvistest123!): the Workshop home page shows the green field touching the top bar with the gold
  rule, the row index with a hairline per row, hover drawing the gold edge, and the "Talking it
  through" chip on each row. The old link is gone and visiting `/workshop/legacy` shows the
  not-found page. It reads sensibly at 800 pixels and 375 pixels wide. Today's page is unchanged.
  Screenshots at desktop and phone width, plus one with the Canyon theme and one in dark mode - the
  dark mode screenshot is for Ben, who has not seen the dark field yet and wants to decide on it.
  Port 1533 is production; never test against it.
- Must not: put the field or its rules in the Workshop stylesheet (they belong in the shared
  primitive); name a colour directly anywhere in the new variant (tokens only); give any other
  page the green field; add a second masthead component; keep the old page reachable behind a flag
  or a hidden route.

## Process reminders that still apply

- Use the design-system skill before any of the interface work in steps 1 to 3.
- Write the plan short - a few lines naming the files, the new component name, and the acceptance
  checks above - and send it to the coordinator (agent name coordinator; resolve its pane fresh
  from `herdr agent list`, do not reuse a pane number from this document) before writing code.
- Commit per task, using explicit file paths, never a bare `git add -A` or `git commit` with no
  paths; use the shared-checkout skill for the commit itself since this checkout is shared.
- Never run the full gate, or anything that touches the database, without the verify-gate skill.
- This is the only relay this lane gets. If the seventy percent warning fires again before the
  branch is pushed and the pull request is open, stop and report to the coordinator for a
  re-slice - do not hand off again.
- Fill in the release note section of the pull request template, plain English, and keep the
  Workshop manifest's app-map entries true in the same pull request (step 6 above is part of that).
- Plain English in every message a person reads: commit messages, the pull request body, status
  updates, and anything else you write for the coordinator or for Ben. No invented shorthand.
