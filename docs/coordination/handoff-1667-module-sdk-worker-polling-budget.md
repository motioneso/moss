# Build Handoff — 1667-module-sdk-worker-polling-budget

**Spec:** none on file — this is a test-timing bug fix, not a new feature; the GitHub issue body
is the full scope. Do not treat the absence of a spec file as a blocker; if you find the fix needs
product decisions beyond adjusting a timing budget, stop and escalate to the coordinator rather
than guessing.
**GitHub issue:** #1667
**Risk tier:** routine (test-only)
**Worktree:** /home/ben/Jarv1s/.claude/worktrees/1667-module-sdk-worker-polling-budget
**Branch:** 1667-module-sdk-worker-polling-budget (off origin/main)
**Build skill path (absolute):** /home/ben/Jarv1s/.claude/skills/coordinated-build/SKILL.md
**Coordinator label:** `Coordinator` — verify `herdr pane list` shows EXACTLY ONE pane with this
label before messaging, resolved fresh (never a cached pane number).
**Coordinator session id:** `ff54b7d3-1ff0-4fad-94ce-b8fa9062a3ad`
**Relay trigger:** context-meter 70% warning, or a compaction summary in your own context →
message the coordinator, then use the `relay` skill immediately.

## Start

1. `[ -d node_modules ] || pnpm install`.
2. Read GitHub issue #1667 in full — it is your spec for this lane.
3. Invoke `coordinated-build` and follow it end-to-end: plan with `plan-build` → coordinator
   approval → TDD build → `coordinated-wrap-up`.

## Context you should know before planning

The coordinator's own memory already has a note that `module-sdk-worker` tests fail locally but
pass in CI due to a hardcoded ~1s polling budget that's too tight for a real (non-sandboxed) local
cold start — this issue is exactly that problem. Fix the budget to account for slower
sandboxed/child-process cold starts without loosening it so much it hides real regressions.

## Exit criteria for this lane

- The flaky/failing polling-budget test(s) pass reliably both locally and in CI.
- PR open, rebased on origin/main.
- Test-only change, not user-facing — live-path gate does not apply; say so in your wrap-up.

## Run-specific bans (non-negotiable)

- Work ONLY in this worktree/branch; `git add` by explicit path.
- Never touch `docs/coordination/`, the project board, milestones, or merge.
- No secrets in any doc, payload, log, or prompt.

## Collision notes (from the coordinator)

- None identified — isolated to test timing configuration.
