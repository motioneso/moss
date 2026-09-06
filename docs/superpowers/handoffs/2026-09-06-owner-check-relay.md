# Handoff: owner check (issue 2267), relay 1

Coordinator approved the plan on 2026-09-06. Nothing left to study. Go straight to copying files.

## Where things are

- Worktree: this one, `/home/ben/Jarv1s/.claude/worktrees/owner-check`
- Branch: `work/owner-check`
- Plan (read this, it has everything): `docs/superpowers/plans/2026-09-06-owner-check-2267.md`
- Coordinator: agent name `coordinator`, pane label shows as `w1:pR3` right now but re-resolve
  it by name before messaging, pane numbers shift.

## Done so far

- `pnpm install` done, dependencies are in place.
- Plan written, committed (`e7fe6bb4d`), and approved by the coordinator.
- Nothing else. No code copied yet. No commits beyond the plan.

## What to do, in order

1. Task 1 in the plan: copy the trust-check fix, its unit test, the integration test change,
   and the new migration file, straight out of the stranded branch
   `build/workshop-phase-a-0904` using `git show <branch>:<path>`. The plan lists every exact
   file and the exact diff to apply. Before committing the migration, run a fresh search of the
   whole repository to confirm number 226 is still unused. The coordinator warned that five other
   lanes are running and one of them may have already taken it since the plan was written; if it
   is taken, use the next free number instead and note the change when you report back.
2. Run the new tests through the verify-gate skill only, never directly. Commit task 1 once
   green.
3. Kill gate: if that test run fails twice in the same way, stop and tell the coordinator rather
   than trying a different design. This is a straight copy of code that already worked once, so a
   repeated failure means something changed underneath it, not that the approach is wrong.
4. Task 2 in the plan: copy the browser storage proof and its supporting fixture files, again
   straight out of the stranded branch, exact list in the plan. Run the live proof through
   verify-gate. If that run threatens to use up the whole session, stop and tell the coordinator so
   it can be split into a further session on the same issue, rather than dropping it.
5. Never merge, rebase, or push to `build/workshop-phase-a-0904`. Only ever copy files out of it
   with `git show`.
6. Finish with the pre-push checks, push the branch, open the pull request, fill in the release
   note section, and confirm the app map still reads true. Report the finished pull request and
   the test evidence to the coordinator. That is the finish line, not a stopping point along the
   way.

## Rules carried forward, word for word

- This is your only relay. If you approach seventy percent again, do not relay a second time.
  Stop and tell the coordinator you need the work split into smaller pieces instead.
- Do not send a research agent to explore the code. Search narrowly yourself: grep for the exact
  thing, read the specific lines, stop.
- Read the plan by the section you are working on, never from the top, and never twice.
- Every message a person reads, including status updates and handoff documents, must be plain
  English: no jargon, no invented shorthand, plain keyboard punctuation, and at most one piece of
  code formatting per sentence. Exact names like file paths or pull request numbers are fine to
  keep, just do not lead a sentence with one or stack several together. Pass this rule on to any
  agent you spawn.
- Never run a gate command through a pipe, and never run the full gate or anything that touches
  the database without the verify-gate skill.
- The development instance for any live testing is at address 192.168.50.36, port 5173, with the
  api on port 3000, login ben@ben.com, password from the usual dev credential store. Port 1533 is
  production and must never be a test target.
