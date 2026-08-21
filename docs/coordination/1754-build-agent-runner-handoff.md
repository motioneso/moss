# Build Handoff — 1754-build-agent-runner

**Spec (approved):** docs/superpowers/specs/2026-06-09-dev-coordinator-design.md (Workshop stage 1
covers this; plan already carries the concrete decisions — see plan doc below)
**GitHub issue:** #1754 — the build agent: agree a plan, then build it
**Risk tier:** sensitive (spawns a build agent/job)
**Worktree:** ~/Jarv1s/.claude/worktrees/1754-build-agent-runner **Branch:** 1754-build-agent-runner (off current main, not the stale plan branch)
**Plan already written and committed:** docs/superpowers/plans/2026-08-20-1739-stage1-workshop.md (commit 46a5abe77) — read it by section for your current task, do not re-plan from scratch.
**Build skill path (absolute):** ~/Jarv1s/.claude/skills/coordinated-build/SKILL.md (follow this
exact file if `coordinated-build` does not resolve by name in your spawn env)
**Coordinator agent name:** `coordinator` — escalate via `herdr agent prompt coordinator` (through
`herdr-pane-message`); before messaging, verify `herdr agent list` shows EXACTLY ONE live agent
with this name, resolved fresh each time. The visible pane label should also be `Coordinator`.
**Coordinator session id:** d4bf2ae0-eb8f-4def-a85a-132e054020be (immutable authority; label is only routing).
**Relay trigger:** the context-meter 70% warning, or a compaction summary in your own context →
message the coordinator, then use the `relay` skill immediately.

## Start

1. `[ -d node_modules ] || pnpm install` (worktrees share the pnpm store; relay successors skip).
2. Read the plan doc above BY SECTION for your current task only — never in full.
3. Invoke **`coordinated-build`** and follow it end-to-end: verify the plan against your actual
   branch → coordinator approval if anything is unclear → TDD build → **`coordinated-wrap-up`**
   (PR + live-path proof + report). Escalation rules and gate commands are defined there — this
   doc does not restate them.

## Exit criteria for this lane

- Spec/plan Exit Criteria met, full gate green **on an isolated gate DB** (`coordinated-wrap-up`
  step 2).
- PR open, rebased on `origin/main`.
- **Live-path proof posted**: this feature is user-facing (a build agent that plans and builds),
  so the feature must be exercised through the real UI on a live dev instance, as a `gh pr comment`
  with the UAT run, exit code, and assertions or bounded DOM/network/log evidence. Cannot produce
  it? Report **code-complete, unverified** — never "done".
  `docs/DEVELOPMENT_STANDARDS.md` → Live-Path Gate.

## Run-specific bans (non-negotiable)

- Work ONLY in this worktree/branch; `git add` by explicit path — never `git add -A` or repo-wide
  `pnpm format`.
- Never touch `docs/coordination/` (coordinator-only), the project board, milestones, or merge.
- No secrets in any doc, payload, log, or prompt.

## Collision notes (from the coordinator)

- #1756 (PR 1799) wires two surfaces against this: the "changing a running draft" moment needed
  #1753 (already merged), the "agreeing the plan" moment needs whatever you build here. Once your
  PR merges, the coordinator will tell #1756's lane to wire that second surface.
- #1319/#1106/#948/#1252/#1586 all touch module discovery/registry/install or the module gateway —
  same area as this lane. They are being held until this Workshop stage lands; you don't need to
  coordinate with them directly, just don't assume the area is uncontested.
