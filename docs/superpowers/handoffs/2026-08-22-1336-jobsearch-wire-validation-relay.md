# Relay: #1336 job-search board wire validation

**Branch/worktree:** `1336-jobsearch-wire-validation` (already checked out, already has
`node_modules` — do not run `pnpm install`).
**Plan:** `docs/superpowers/plans/2026-08-22-1336-jobsearch-board-wire-validation.md` — read it by
section for the task you're on, not front to back.
**Coordinator:** name `coordinator` (confirm exactly one live agent has that name via
`herdr agent list` before messaging).
**Follow-up issue already opened:** #1835 (the same problem, one call site over — `match.get` /
`MatchDetail` — deliberately not part of this PR).

## Plain-English recap

The job-search board screen asks the server for the list of matched jobs and used to trust
whatever came back had every field it needed. Now it checks. This relay covers: the check itself
is written and wired in; still needed are (1) a message the person actually sees on screen when a
row gets dropped, (2) the same kind of check on the server side with a log that names which field
was wrong — never the job content itself, (3) tests, (4) the full check suite, (5) the pull
request with proof the app still works.

Everyone on this task writes status/PR text in plain English, no jargon, no coined shorthand —
carry that forward to any further successor too.

## Coordinator's approval conditions (message received 2026-08-22, must all be satisfied)

1. A dropped row is not just filtered — the screen must show a visible count, so a person doesn't
   silently lose sight of a real job match.
2. Log enough server-side to diagnose which field was wrong, but never put the job content
   (title, company, url, etc) in that log.
3. One malformed row must never blank the whole board.
4. Open a real GitHub issue for the match-detail follow-up rather than leaving it as a plan
   sentence — **done: #1835**, already referenced above and should be referenced in the PR body.

## Done (committed: `436309664`)

- `external-modules/job-search/src/web/board-types.ts`: added `isBoardMatch(value): value is
  BoardMatch`, a full runtime shape check (every field, right type, `state` in the known set).
- `external-modules/job-search/src/web/read-board.ts`: `BoardPageResult` gained `invalidCount:
  number`; `readWholeBoard` filters every page's raw items through `isBoardMatch`, accumulates
  `invalidCount` across pages, returns it in both the early-return and the `truncated: true`
  fallthrough.

## Not started yet — do these in order

### Task 2 — visible notice in board.tsx (plan's "Task 2")
- `external-modules/job-search/src/web/screens/board.tsx`: `MatchesState`'s `"ready"` branch
  (around line 40) needs `invalidCount: number`, set from `readWholeBoard`'s new field at the
  `setMatchesState({ status: "ready", ... })` call (~line 366).
- Next to the existing `matchesState.truncated` notice (~line 854, `jsm-queue-notice`/
  `role="status"` pattern), add a sibling notice when `invalidCount > 0`. Exact copy is not
  pinned — write something plain like "N role(s) couldn't be shown — the server sent something
  the board didn't recognize," singular/plural handled the way the existing "new role(s)" copy
  already does (`runNotice`'s `"finished"` case, ~line 215).
- Test in `tests/unit/job-search-web-board.test.tsx`: notice renders when `invalidCount > 0`,
  does not render when 0.

### Task 1 tests (plan's Task 1 test cases, not yet written)
In `tests/unit/job-search-web-board.test.tsx` (existing `matches.list` mock setup around line 139
and 664): three cases — a row missing `url`, a row with an unrecognized `state`, and an
all-well-formed response — asserting `items`/`invalidCount` behave as described in the plan doc's
Task 1 section.

### Task 3 — server-side check + log (plan's "Task 3", full code already drafted in the plan doc)
`external-modules/job-search/src/worker/handlers/matches.ts`: add `malformedBoardMatchFields`
(field names only — id/title/company/url/location/source non-empty strings, state in the known
set) and call it on each built row before `items.push(item)`; on a bad row, `console.error` with
the match id and the list of bad field names (never the field values) and `continue` instead of
pushing. Full code is in the plan file — copy it, don't redesign it. Rationale for why
`console.error` (not a proper logger) is the right call server-side is also in the plan
("Task 3" section) — don't relitigate it, the research backing it is already in.
Test in `tests/unit/job-search-match-handler.test.ts`: one case with an empty-string posting
field, asserting the row is dropped, `console.error` fires once, message names the field, message
does not contain any posting content.

### Then
- Run the pre-push trio: `pnpm format:check && pnpm lint && pnpm typecheck`, fix anything red.
- `git fetch origin main && git rebase origin/main`.
- Full gate via the `verify-gate` skill (don't improvise it).
- `coordinated-wrap-up`: push, open PR, fill in the PR template's "Release note" section in plain
  language (this is user-visible: "the board now tells you if it couldn't show some roles, instead
  of showing a broken link" is the shape of a good line), reference #1336 and #1835 in the PR body.
- **Live-path proof required** (this is a UI screen): run the app on the dev instance, open the
  job-search board with real data and confirm it still renders normally (proves no regression),
  and paste the new unit test output on the PR. The malformed-row path itself is unit-proven, not
  live-proven (no way to make the real server send a bad row on demand) — say that plainly in the
  PR rather than overclaiming live coverage of that specific path.
- Report the PR + evidence to the coordinator, signed with your pane id. Do not merge, close the
  issue, or move the board — that's the coordinator's job.

## Traps already avoided, don't reintroduce

- Do not expand scope to `job-search.match.get`/`MatchDetail` or any other screen's
  `invokeTool`/`runQueue` call — that's #1835 and other future work, explicitly out of scope here
  per both the issue and the coordinator's own message.
- Do not use `pnpm verify:foundation` or any DB-touching test command without the `verify-gate`
  skill.
- Never `git add -A`; stage only the files each task actually touched.
