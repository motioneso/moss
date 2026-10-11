# Handoff: build decision-model presets (#3057)

You are the builder for issue #3057 in worktree `~/Jarv1s-3057`, branch
`feat/3057-decision-model-presets`, draft PR #3059. The spec and plan are approved by Ben.

## Plain English, always

Ben reads status to know whether the work is going well, not to review code. In chat, status
updates and PR comments a human reads:

- Name things by what they do, not by what the repo calls them.
- Keep exact names only where he must act on them (a command, a file, an error string).
- If a sentence has more than one backtick, say it again without them.
- No invented shorthand. Plain ASCII punctuation (no em-dashes or arrows).
- Commit messages, code comments and specs stay precise and technical.
- Pass this instruction on to anything you spawn.

## Read first

1. `CLAUDE.md` and `docs/DEVELOPMENT_STANDARDS.md` (hard invariants, process gates).
2. `docs/superpowers/specs/2026-10-05-decision-model-presets-design.md` (what to build).
3. `docs/superpowers/plans/2026-10-05-decision-model-presets.md` (how, task by task).

## Guardrails

- Run `pnpm install` once at the start. This is a fresh worktree.
- Follow the plan's task order. Write tests first where the plan names them.
- Before any UI or CSS change (phase 2), use the `design-system` skill and read
  `docs/design-system.md`. Use existing `@moss/ui` primitives and `jds-*` classes only.
- Run gates only through the `verify-gate` skill. Never pipe a gate or test command into
  `tail`, `head` or `tee`. Every command keeps its exit code.
- Never run a DB-touching test against the shared dev database without `verify-gate`.
- The Clef token lives at `~/.config/clef/token`. Read it only from that file, at the moment you
  need it. Never print it, log it, commit it or paste it into a PR.
- This repo is public. No account IDs, passwords or LAN addresses in commits or PR text.
- Any dev server you start uses a port from `devports claim 3057-builder`. Release it when you stop.
  Never use port 5173 or 1533.
- Commit with explicit paths only. Never `git add -A` or `git add .`.
- Push to the branch; the PR already exists. Never merge the PR yourself.
- Update the app map and the PR's release-note section in the same PR (plan task 8).

## Stop points

- **After phase 1 (tasks 1 to 3):** push, then stop. Write a short plain-English report to
  `~/.cache/3057-builder/phase1-done.md` saying what was built, the gate results with exit
  codes, and anything that surprised you. Then wait. The coordinator runs the kill gate with Ben
  and will message you to continue with phase 2.
- **After phase 2 (tasks 4 to 8):** push, then write `~/.cache/3057-builder/phase2-done.md`
  the same way and wait. The coordinator decides who runs the live proof.
- **Blocked:** write `~/.cache/3057-builder/blocked.md` with the one question you need answered,
  then wait. Do not guess around a blocker that changes the design.

Two identical failures of the same command means stop and rethink, not retry.

## Review

A Claude reviewer (the side-pr-reviewer agent) reviews this PR, because the builder is DeepSeek.
The plan's security focus still applies: the token never reaches logs, job payloads or the
browser after save, and the account ID and model ID cannot steer a request to another host or
path.

## Start

Run `pnpm install`, read the three documents above, then begin plan task 1.
