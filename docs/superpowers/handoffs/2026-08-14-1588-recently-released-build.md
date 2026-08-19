# #1588 Recently Released — build handoff

## Authority

Ben approved both artifacts on 2026-08-14:

- `docs/superpowers/specs/2026-08-14-1588-recently-released.md`
- `docs/superpowers/plans/2026-08-14-1588-recently-released.md`

GitHub issue: https://github.com/motioneso/moss/issues/1588

Implement the approved plan without product or architecture expansion.

## Coordination boundary

#1275 is the only other active implementation lane and currently owns the solo live window. You
may install dependencies and run non-DB unit/static checks. Do **not** run integration tests, the
full gate, provision a stack, or run UAT until the Coordinator explicitly grants the window.

Do not push, merge, or move the board. Report code/static readiness to the Coordinator first.

## Scope

The approved maximum surface is the seven files listed in the plan. Reuse the existing safe
Markdown renderer and Settings navigation. No API, database, job, runtime GitHub fetch, dependency,
custom parser, editor, notification, or new CSS.

Keep `docs/WHATS_NEW.md` as the only release-note source. Do not invent historical version mappings:
ground version labels in actual tags/history, preserve useful existing entries, and stop for a
decision if the repository cannot truthfully associate an entry with a shipped version.

## Start

1. Read `CLAUDE.md`, the approved spec, and the approved plan in full.
2. Use the `coordinated-build` and `tdd` skills.
3. Run `pnpm install --frozen-lockfile` in this fresh worktree.
4. Execute Tasks 1 and 2 RED→GREEN, then prepare Task 3's UAT test without running it.
5. Run only focused unit tests and static checks that do not touch Postgres.
6. Commit each approved task with explicit paths and the required release-note wording.
7. Message `coord-overnight-successor` with exact head, scope, RED→GREEN evidence, and the request
   for the solo full-gate/UAT window. No DB/live retry loop.
