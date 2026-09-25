# Handoff: Workshop PR 2307, and the chat-has-no-tools bug found while proving it

2026-09-05. Plain English, no jargon, in every message and every spawn prompt you write.

## Where Workshop stands

Branch `feat/workshop-projects-phase-a`, worktree `~/Jarv1s/.claude/worktrees/workshop-pr`, PR 2307.

- Code complete. Main is merged in (one conflict, in the migration catalogue test: kept both
  Workshop's 0223/0224 and web push's 0225).
- Release note section of the PR is already filled in.
- Design polish Ben asked for is done and committed (commit 322e20227): full-width page, card grid,
  no truncated titles, start dates, empty-state button.
- The plain-http crash is fixed and proved live over `http://<dev-lan-host>:20001`.
- Last gate run failed on lint only, from two temporary probe scripts that have now been deleted.
  Rerun the gate; nothing else was red.
- One temporary file still to delete before merge: `tests/uat/hold-instance.ts`.
- Still missing: the live proof of the chat handover. Blocked by the bug below.

## The blocker

Chat cannot use any tool on a current Claude command-line install. Full detail in memory:
`chat-tools-flag-hides-mcp-tools.md`. Short version: the launcher passes `--tools "Read,Glob,Grep"`
when a tool server is configured, and on version 2.1.183 that drops all 101 Moss tools. Proved both
ways inside the container. The fix is to stop passing that flag on the branch where the tool server
is configured; the fail-closed permission hook already blocks everything that is not a Moss tool,
so nothing is loosened. Two call sites: `claude-print-chat-engine.ts` around line 381 and
`cli-launch-commands.ts` around line 106. Unit tests that assert on the flag will need updating.

Plan agreed with Ben: fix that in its own small pull request first, merge it, then rebuild his test
instance and have him do the click-through that finishes Workshop.

## The test instance

`http://<dev-lan-host>:20001` (tailnet: `http://<dev-tailnet-host>:20001`),
login the demo admin account (credentials kept out of the repo). Compose project
`uat-1531132_eb432fc8`. Held open by `tests/uat/hold-instance.ts`. The Claude command-line program
had to be installed into it by hand through `POST /api/onboarding/provider-install`; the seeded
sign-in then settles as ready on its own.

## Rules that bit this session

- Run the gate only through `scripts/run-gate.sh`, never piped. The wrapper can exit 0 while the
  gate itself is red — read the `FINAL rc=` line.
- `git diff origin/main` two-dot shows main's own changes as if they were yours. Use three dots.
