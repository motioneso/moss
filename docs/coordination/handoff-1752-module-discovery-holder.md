# Build Handoff — Workshop 1: find modules that appear after the server has started

**Spec (approved):** docs/superpowers/specs/2026-08-19-moss-builds-modules-on-moss.md
**Plan (already written and coordinator-approved — do NOT re-plan from scratch):**
docs/superpowers/plans/2026-08-20-1739-stage1-workshop.md — read only **"Group A — #1752"**
(starts at its own heading; stop before "Group B"). It has file-level tasks with failing-test-first
steps already specified.
**GitHub issue:** #1752
**Risk tier:** routine
**Worktree:** ~/Jarv1s/.claude/worktrees/1752-module-discovery-holder **Branch:**
1752-module-discovery-holder (off origin/main)
**Build skill path (absolute):** ~/Jarv1s/.claude/skills/coordinated-build/SKILL.md
**Coordinator label:** `Coordinator` — escalate via `herdr-pane-message`; verify `herdr pane list`
shows exactly one pane with this label before messaging, resolved fresh (never a cached pane
number).
**Coordinator session id:** `01d11bc2-ed28-440a-9f95-3bf53f0046c7`
**Relay trigger:** context-meter 70% warning, or a compaction summary in your own context ->
message the coordinator, then use the `relay` skill immediately.

## Start

1. `[ -d node_modules ] || pnpm install`.
2. Read the plan's "Group A" section (only that section, not the whole plan or the spec in full).
3. Since the plan is already coordinator-approved, skip straight to TDD build following
   `coordinated-build`'s build step, then `coordinated-wrap-up` (PR + live-path proof if
   applicable + report). This task is a backend holder with no UI surface, so a live-UI proof is
   likely not required — confirm against the plan's own task description; if genuinely no UI
   surface, note "no UI surface, live-path gate does not apply" in your PR instead of skipping
   silently.

## Exit criteria for this lane

- Full gate green on an isolated gate DB.
- PR open, rebased on origin/main, referencing #1752.
- Downstream note: #1753 and #1754 in this same plan depend on your holder API
  (`createExternalModuleDiscoveryHolder`) landing first — say so plainly in your PR description so
  the coordinator knows it's safe to unblock them.

## Run-specific bans (non-negotiable)

- Work only in this worktree/branch; `git add` by explicit path only.
- Never touch docs/coordination/, the project board, or merge anything.
- No secrets in any doc, payload, log, or prompt.

## Collision notes

- #1753 and #1754 (same plan, different worktrees) will build against your holder's shape once
  your PR is up — do not rename `getDiscoveries`/`rescan` without flagging it to the coordinator.
- #1755 and #1756 (front-end shell) are being built in parallel and do not depend on you.
