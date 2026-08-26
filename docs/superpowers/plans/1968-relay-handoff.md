# Relay handoff — issue #1968 (piece 1 of 4)

Plain English only in anything a human reads, and pass that rule to anything you spawn.

## Where things stand

The database change and the whole server change are **written, committed, and compiling**.
What is left is tests, the gate, the pull request, and live proof.

Branch `fleet/lane-1968`, worktree `/home/ben/Jarv1s/.claude/worktrees/fleet-lane-1968`.
`node_modules` is installed — do not reinstall.

Commits so far (newest last):

- `509198a8b` the spec
- (plan commit) the build plan
- migration and database types
- `6e4d8b21f` the server change

## Verified, do not re-derive

- `pnpm typecheck` exits 0.
- `pnpm lint` exits 0.
- Prettier has been run on every file touched.
- `pnpm format` repo-wide **times out after two minutes** and is banned by the brief anyway.
  Format only the files you touch: `npx prettier --write <paths>`.
- No database test has been run yet. Nothing has been pushed. No pull request exists.

## Read these two, in this order

1. `docs/specs/1968.md` — the approved spec. Also posted on issue #1968 as a comment starting
   with the word SPEC.
2. `docs/superpowers/plans/2026-08-25-medication-start-date-reminders-editing.md` — the build
   plan. Its "Task 6 — tests" section lists **every test case with the reason it would fail
   against a broken implementation**. Write the tests straight from that table.

## What the change actually does (so you can review it in one pass)

- New migration `packages/wellness/sql/0196_wellness_medication_start_date_reminders.sql`.
  It swaps the constraint from migration 0194 that only let the "every interval" and "monthly"
  schedule types store a start date for one that only restricts the shape-describing columns, so
  all six types can now store a start and end date. It also adds a `reminders_enabled` flag,
  defaulting to off, and a rule keeping it off for as-needed medications, which have no scheduled
  time for a reminder to fire on. It is registered in
  `tests/integration/foundation-schema-catalog.test.ts` as version 0196.
- `packages/wellness/src/routes.ts` — the schedule validation is now one shared function used by
  both creating and editing. Editing the schedule is all-or-nothing: send the frequency type plus
  every field that type needs, or the request is rejected. Start and end dates are checked as real
  calendar dates so a bad one is a friendly rejection rather than a server error.
- `packages/wellness/src/repository.ts` — editing now rewrites every schedule column at once,
  clearing the ones the new type does not use, and re-records the caller's time zone.
- `packages/wellness/src/schedule.ts` — a medication produces no doses on days outside its stored
  start and end window.
- `packages/shared/src/wellness-api.ts`, `packages/wellness/src/serialize.ts`,
  `packages/db/src/types.ts` — the contract, the reader and the column type for the new fields.

## Exact next steps

1. Write `tests/unit/wellness-schedule-start-window.test.ts` from the plan's table (three cases,
   no database needed). Run it with the unit test runner and watch it pass.
2. Write `tests/integration/wellness-medication-editing.test.ts` from the plan's table (ten
   cases). Model it on `tests/integration/wellness-medication-schedule-v2.test.ts`, which sets up
   its own user and Fastify app in the same way.
3. Run the full gate **through the `verify-gate` skill** — never bare, never piped. An unscoped
   run hits the live development database.
4. Rebase on `origin/main`, push, open the pull request. The release note section is
   `Category: N/A` (nothing user-visible ships in this piece; the form is a later piece).
5. Live proof, posted with `gh pr comment` whose **first line is exactly** `LIVE-PATH PROOF`.
   Against the running development instance at http://192.168.50.36:5173 (API on port 3000),
   log in as ben@ben.com, then through the real server: create a daily medication with a start
   date and the reminder toggle on, read it back, edit it into a monthly schedule, read that back,
   and show that a medication starting tomorrow contributes no dose to today's list. Remember the
   development instance needs the new migration applied first — see the memory note about a
   module install needing a manual reconcile. Port 1533 is production; never touch it.
6. Record the pull request:
   `node /home/ben/jarv1s-fleet/fleetctl.mjs set 1968 status=pr-open pr=<number>`

## Two things to watch

- Reminder on/off deliberately lives **outside** the schedule object, so it can be toggled on its
  own. When a request turns it on without also changing the schedule, the handler reads the
  stored frequency type to check it is not an as-needed medication.
- The start date is applied as a day-level window in `computeSchedule`, **not** by feeding it into
  the schedule engine's anchor. For a cycle schedule the anchor decides which days are "on" days,
  so swapping in a different date would shift the whole on/off pattern. The plan records this as a
  rejected option with its reason; keep it that way.
