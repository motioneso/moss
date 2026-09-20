---
name: wrap-up
description: Close out a Jarv1s session by preserving work, cleaning up session-owned resources, and leaving accurate tracking and handoff notes. Use for wrap up, close out, or is everything saved. This is not a verification, release, or merge gate.
---

# Wrap up: leave the environment clean and lose no work

The goal is to make the session safe to leave and easy to resume. Preserve work,
stop unnecessary session-owned processes, and state what is saved and what remains.

Announce: “Using the wrap-up skill to close out.” Keep the close-out short.

## 1. Establish ownership

Check the current worktree, `git status --short`, and relevant agent/pane activity.
Stay in the task's worktree. Distinguish your changes and processes from others'.
Use the shared-checkout skill before committing in a shared checkout.

Never use `git add -A`, `git add .`, stash, reset, checkout, or broad process kills
as cleanup. Do not disturb another session's files, servers, tests, or database.
Notify a relevant teammate if your cleanup or handoff affects their work; do not
start another agent merely to wrap up.

## 2. Preserve work

- Review and commit your intended changes by explicit path. Preserve useful
  unfinished work as a clearly described checkpoint, not as a claim of completion.
- Push the task branch when it is intended for the remote, then verify sync.
  Do not force-push. If pushing is unavailable, state what remains local.
- Keep plans, specs, required assets and a concise continuation note in durable
  storage. Important work must not exist only in a transcript or temporary file.
- Leave other sessions' changes alone. Report deliberate uncommitted exceptions.
- Format only touched files when needed; do not run a repository-wide formatter
  merely to make the session look clean.

## 3. Clean up resources you own

Stop temporary servers, watchers, test runs and helper processes started for this
session when they are no longer needed. Use their supported stop command and
verify termination. For an unnecessary gate started by this session, use
`scripts/run-gate.sh stop`; use its recorded result, not `pgrep`, as the verdict.

Remove disposable scratch files and isolated test resources only after confirming
ownership and preserving anything needed to resume or diagnose a known failure.
Keep valuable logs or record their locations. Do not delete a worktree, branch,
shared database, service or volume just because the session is ending.

If a process must keep running, record its purpose, owner, status and stop command.
Do not leave unexplained background work behind.

## 4. Record truthful status without launching a new gate

**Do not start, rerun, or wait for full tests, audits, builds, CI, or release gates
solely because the user asked to wrap up.** This applies to source changes as well
as documentation. Report checks already performed accurately; mark anything not
run, still running, failed or intentionally stopped. A pending or failed check can
remain tracked without preventing preservation and cleanup.

Verification required by an explicitly requested implementation, review, merge or
release remains part of that task. This skill adds no verification requirement and
does not waive one. If that work is paused or unfinished, preserve it and say so;
never claim it is verified, released or merge-ready merely because wrap-up is done.

Check only the GitHub records touched by this session. Project 2, “Issue and Roadmap
Work,” is the live board. Keep issues/PRs and their status consistent with reality;
leave planned or unfinished work open. Link deferred work and the next step so it
cannot disappear. Do not expand close-out into a repo-wide board audit, fresh
implementation, automatic merge, or release.

## 5. Leave a usable handoff

Save significant decisions, corrections and state changes in project memory. For
unfinished work, leave a concise durable note containing the branch, issue/PR,
completed work, known limitations, verification actually performed, and next step.
Use `~/Jarv1s` in documentation and never store secrets.

Finish with a short report: saved/pushed state, cleanup performed, relevant issue/PR
links, and any remaining work or deliberate exception. Successful wrap-up means
nothing important is lost and the environment is left understandable—not that the
product is finished or every check is green.
