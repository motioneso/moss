# Relay 3 — issue 1869, slice 1 (per-turn time context) — only the live demo is left

Branch/worktree: `build-1869-time-context`, this same worktree, already pushed.
Pull request: https://github.com/motioneso/moss/pull/2129 — code-complete, gate green, not yet
merged. Do not re-touch the code or tests unless the live demo below turns up a real bug.

## What is fully done (do not redo)

- All production code and test fixes for slice 1 are committed and pushed (6 commits, most recent
  `e3eb1f553`).
- The full local gate (`pnpm verify:foundation`, run through the `verify-gate` skill against the
  real test database) passed clean on this exact branch.
- The pre-push checks (format, lint, typecheck) and a rebase onto `origin/main` are done — the
  branch is up to date with main and has no rebase conflicts.
- The pull request is open with the release note filled in.

## What is NOT done — the one remaining step

A live demonstration on the dev site: an actual conversation with the assistant, using this
branch's code, that shows the assistant behaves sensibly now that it is told the real time on
every turn — then post that as a comment on pull request 2129. This is the live-path gate the
project's rules require before a user-facing feature can be called done, not just code-complete.

**The problem hit at the end of relay 2:** the shared dev instance people normally use
(`http://192.168.50.36:5173`) is currently running a different lane's branch code (a Vite process
was pointed at another worktree, not main and not this branch), so testing there would not prove
anything about this branch. This needs its own throwaway instance, on non-standard ports, running
this worktree's code, following the recipe already saved in memory — search memory for
"dev-instance-lan-spinup-trusted-origins" and "feedback-dev-environment" before starting. In short:
non-standard ports break login unless the trusted-origins environment variable is set correctly to
match; the recipe explains exactly what to set.

No database migration is needed — checked already, this branch adds no schema changes, so it is
safe to point a throwaway instance at the existing dev database without running any migration
against it.

Steps:
1. Start an API and web server from this worktree's code on ports that do not collide with any
   other running session (check what is already listening first, then pick free ports).
2. Log in as the existing dev user (credentials are in memory — search "dev-instance-lan-spinup").
3. Have an actual conversation that would surface whether the assistant knows the real date/time
   (for example, ask it what today's date is, or something that depends on elapsed time).
4. Post the real conversation transcript (or a clear description of the exchange) as a comment on
   pull request 2129, stating plainly that this is the live-path result deciding whether issue
   1869's slices 2 and 3A can start.
5. Shut down the throwaway servers when done so they do not linger like the stale-server trap
   described in memory.
6. Report back to the coordinator that pull request 2129 is finished, live-path proven, and ready
   to merge (merging is this session's job per standing project rules, not something to leave
   parked for a human).

## Relay budget

This will be relay 3. If your own context-meter warning fires again before the live demo and PR
comment are done, stop, do not touch any more code, and message the coordinator directly asking
for this last small step to be re-sliced into a fresh, narrowly-scoped session — do not spawn
another relay yourself.
