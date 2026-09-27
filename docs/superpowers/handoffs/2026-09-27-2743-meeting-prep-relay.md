# 2743 meeting-prep: relay handoff

Issue: #2743 (part of #2521). Worktree: `~/Jarv1s/.claude/worktrees/2743-meeting-prep`,
branch `feat/2743-meeting-prep`. Coordinator pane: label "coordinator", session id
resolve fresh via `herdr pane list` (do not trust a baked pane number).

## What's done (all pushed)

1. Commit `d377defe3` — plan amendment written into
   `docs/superpowers/plans/2026-09-16-visual-parity.md` (new subsection under
   "3. Finish the existing screen tasks..."): the mockup's "two decisions" line
   has no real data source anywhere in the repo (no decision entity, nothing
   links one to a meeting), so it will not be built. Scoped the card to a
   preparation line and a link instead.
2. Ben approved with one change (see his message, quoted in full below) and
   commit `7bea39237` folded it in: the preparation line only shows when the
   touching Moss block's own **title** reads as preparation (case-insensitive
   `prep`/`prepare`/`preparation`), not just because a block happens to end
   when the meeting starts. Link label is "See meeting" (no "and decisions").
3. Commit `5dfabd1b2` — the actual build, WIP, untested:
   - `apps/web/src/today/today-rail.tsx`: `RailNextEvent` gained `id: string`.
     Added exported `preparationBlockMinutes(nextEvent, precedingEvents)` —
     finds a preceding `CalendarEventDto` with `isMossBlock: true`, whose
     `endsAt` equals the meeting's `startsAt`, whose `title` matches
     `/\bprepar(e|ation)?\b/i`; returns its duration in minutes or `null`.
     Card renders a second `cmd-next__note` paragraph with
     `preparationNote(minutes)` when non-null. The "See meeting" button now
     navigates to `` `/calendar?event=${encodeURIComponent(nextEvent.id)}` ``
     instead of the bare `/calendar`.
   - `apps/web/src/today/today-page.tsx`: passes `id: nextEvent.id` into the
     `nextEvent` prop, and a new `precedingEvents={todayEvents}` prop (the
     already-computed, already-sorted today `CalendarEventDto[]`).
   - `apps/web/src/calendar/calendar-page.tsx`: imports `useSearchParams`;
     reads an `event` query param once `allViewEvents` has loaded, and if it
     matches a real event id, calls the existing `setPeek` — same as a click.
     No new route.

## What's NOT done yet — pick up here

Nothing has been typechecked, linted, or tested. Do this next, in order:

1. **Typecheck/lint the three changed files first** (fast feedback before
   writing tests) — `pnpm --filter web typecheck` or the repo's usual
   per-package command; check `package.json` scripts if unsure. Fix anything
   red before writing tests against broken types.
2. **Unit tests (TDD was skipped under time pressure — write them now,
   retroactively, and make sure they'd fail against a broken implementation):**
   for `preparationBlockMinutes` in a new or existing test file under
   `tests/unit/` (pattern: `tests/unit/today-weather-row.test.tsx` shows how
   this repo tests Today components — but `preparationBlockMinutes` is a pure
   function so it does not need the heavy page-level render setup, just call
   it directly). Cases required by the amended plan:
   - (a) matching preceding block, titled as preparation → returns minutes
   - (b) no preceding block → null
   - (c) touching Moss block, NOT titled as preparation → null
   - (d) Moss block titled as preparation, NOT touching the meeting's start → null
   Also a render-level check (react-test-renderer, `TodayRail` directly with
   hand-built props — it takes props only, no fetching) that the card shows
   the preparation `<p>` in case (a) and not in (b)/(c)/(d), and that the
   link href/onClick target includes the real event id.
3. **Browser test**: seed one meeting with a real Moss block titled
   "Prep for the 10am" (or similar) ending exactly at the meeting's start, and
   one meeting with no such block. Check the card text differs correctly in
   both. Click "See meeting", confirm the calendar page opens with that
   event's `CalendarPeek` visible (not just navigated to `/calendar`).
4. **App map**: check `packages/shared/src/app-map-core.ts` (or the calendar
   module's manifest) for whether the Today first-meeting card / calendar
   detail link needs a declaration update. Read the "App Map Truthfulness"
   rule in `docs/DEVELOPMENT_STANDARDS.md` if unsure what counts.
5. **PR release note section**: Category Added, short title, one plain
   sentence — non-technical, no file names or code terms. Something like:
   "Today's first-meeting card now tells you about a real preparation block
   before the meeting, and links straight to that meeting instead of just the
   calendar."
6. **Gate**: use the `verify-gate` skill before running anything — never pipe
   a gate command. Live-path proof needed per the brief: a disposable dev
   instance (never the shared dev DB, never port 1533), a real meeting with a
   real correctly-titled preparation block and one without, crop screenshots
   of the card at 1440 and 375 to disk, post as a PR comment.
7. **Open the PR**, title/body "Fixes #2743", release note filled in. Do not
   merge. Report to the coordinator (brief's step 11 form), then verify with
   `herdr agent read coordinator --source recent-unwrapped --lines 12`.
8. Stop any server you start by explicit PID, delete scratch files, leave the
   worktree clean before finishing.

## Ben's exact ruling (quoted, for the plan-amendment record — already folded into commit 7bea39237, included here so nothing is re-derived from memory)

> APPROVED with one change. A Moss block ending at the meeting start is not
> proof it is preparation (it could be a focus block for other work), so
> calling it a preparation block would be invented. Show the preparation line
> only when that touching Moss block's own title says it is preparation
> (case-insensitive prep/prepare/preparation), else no line. Add that as test
> case (d): touching Moss block with an unrelated title shows no line. Amend
> the plan section to say this in the same commit series. Dropping the
> decisions line is correct. Link label should say 'See meeting' (no 'and
> decisions'). Everything else as written. Go to PHASE B.

## Standing rules (repeat from the boot brief, still apply)

- Ben reads status to know whether the work is going well, not to review
  code. Plain English in anything written for a human, no jargon, no invented
  shorthand, exact names only where he must act on them (a command, a file, an
  error string). This applies to every agent, including whoever reads this doc.
- Never `git add -A`/`git add .`, never bare `git commit`. Commit per task
  with explicit paths.
- Never touch `docs/coordination/`.
- Two identical failures → stop and rethink, don't retry-loop.
- Bound every read; never pull a full-page screenshot into context, crop to
  disk first.
- Relay depth is budgeted at ONE for build lanes. This is relay #1. If the
  70% warning fires again before a PR is open, do not relay again — push
  what you have and report to the coordinator that the slice needs
  re-scoping, per the brief's standing rules.
