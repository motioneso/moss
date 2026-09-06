# Cancel signal (issue 2276) — relay 1

Worktree: `/home/ben/Jarv1s/.claude/worktrees/cancel-signal`, branch `work/cancel-signal`.
Task issue: 2276. Coordinator: agent name `coordinator` (pane resolved fresh each time via
`herdr agent list`, do not reuse a pane number from this doc).

## What is done

- Read issue 2276 and the diff on the stranded branch `build/workshop-phase-a-0904` (never merge,
  never rebase, never push to it — copy files out only).
- Wrote and committed the plan: `docs/superpowers/plans/2026-09-06-2276-cancel-signal.md`
  (commit `59377af24`). Read it by section, not in full — the seams check and the two task
  sections are what you need.
- Sent the plan to the coordinator for approval and said in the message that it should be treated
  as approved unless a problem is flagged, since I could not wait for a live reply before
  relaying. No code has been touched yet — check for a reply from the coordinator first thing, but
  do not block long on it.

## What is next (in order)

1. Read the plan's Task 1 section only. Edit `packages/ai/src/structured/generate-structured.ts`:
   add one line checking `input.signal?.aborted` right after the adapter call resolves and before
   its result is parsed. Exact insertion point and reasoning are in the plan.
2. Add the forced-late-result test described in Task 1 to
   `packages/ai/src/structured/generate-structured.test.ts`. Run it, watch it fail against the
   pre-fix code path if you want proof the test is real, then confirm it passes after the fix.
   Commit task 1 (code plus test together) once green.
3. Read the plan's Task 2 section only. Edit `packages/chat/src/live/cli-structured-adapter.ts`'s
   `generateOneShotStructured` per the plan's decisions (a `cancelled` flag; the rescue read only
   runs when not cancelled). Add the four test cases described in Task 2 to
   `packages/chat/src/live/cli-structured-adapter.test.ts`. Commit task 2 once green.
4. Run the two scoped test commands in the plan's Verification section (never piped, check the
   exit code). Then use the `verify-gate` skill for the full scoped gate — never run
   `pnpm verify:foundation` directly.
5. Fill in the pull request's release note section with `Category: N/A` (reasoning is in the
   plan's Task 3) and state plainly in the pull request body that no app map entry applies.
6. Use `coordinated-wrap-up`: push, open the pull request, report to the coordinator. This is a
   backend-only fix behind a path that is not yet reachable from any shipped feature, so there is
   no live-UI proof to attach — say that plainly rather than searching for one.

## Standing rules that still apply

Plain English in every message a human reads. Never run the full gate or anything touching the
database without `verify-gate`. Waits are event driven, never a polling loop. One relay is the
budget — if you also hit the context warning before task 2's pull request is open, stop and report
to the coordinator that the slice needs to be cut smaller, rather than relaying again.
