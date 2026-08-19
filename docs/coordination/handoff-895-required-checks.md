# Build Handoff — 895-required-status-checks

**Spec (approved):** docs/superpowers/specs/2026-08-15-895-required-status-checks.md
**GitHub issue:** #895
**Risk tier:** `routine` — CI config only (`.github/workflows/ci.yml`), no schema/auth/secret
surface. Standard QA (CI gate + `/code-review` + exit-criteria); auto-merge after green.
**Worktree:** ~/Jarv1s/.claude/worktrees/build-895-required-checks **Branch:**
build-895-required-checks (off origin/main @ 389e96488)
**Build skill path (absolute):** ~/Jarv1s/.claude/skills/coordinated-build/SKILL.md (follow this
exact file if `coordinated-build` does not resolve by name in your spawn env)
**Coordinator label:** `Coordinator` — escalate via `herdr-pane-message`; before messaging,
verify `herdr pane list` shows EXACTLY ONE pane with this label, resolved fresh each time (never
a cached `…-N` pane number — they reflow).
**Coordinator session id:** `a77937e1-04f0-48e3-9ec1-3e8d9f9c5aea` (immutable authority; label is
only routing).
**Relay trigger:** the context-meter 70% warning, or a compaction summary in your own context →
message the coordinator, then use the `relay` skill immediately.

## Start

1. `[ -d node_modules ] || pnpm install` (worktrees share the pnpm store; relay successors skip).
2. Read the spec above BY SECTION for your current task only — never in full. A full-read bloats a
   fresh context toward the relay threshold before you write any code, which forces a premature
   relay-without-progress. Reading is not progress: BUILD and commit per task.
3. Invoke **`coordinated-build`** and follow it end-to-end: verify the spec against your actual
   branch → plan with **`plan-build`** (NOT `superpowers:writing-plans`) → coordinator approval (do
   NOT write code before it) → TDD build → **`coordinated-wrap-up`** (PR + live-path proof +
   report). Escalation rules and gate commands are defined there — this doc does not restate them.

## Exit criteria for this lane

- Spec Exit Criteria met, full gate green **on an isolated gate DB** (`coordinated-wrap-up` step 2).
- PR open, rebased on `origin/main`, the new `ci-gate` aggregate-check workflow itself runs green
  on the PR.
- No live-path proof needed — this is CI config, not a user-facing feature/module/UI surface.

## Run-specific bans (non-negotiable)

- Work ONLY in this worktree/branch; `git add` by explicit path — never `git add -A` or repo-wide
  `pnpm format`.
- Never touch `docs/coordination/` (coordinator-only), the project board, milestones, or merge.
- No secrets in any doc, payload, log, or prompt.

## Collision notes (from the coordinator)

- Zero file overlap with #1589 or #1013 — no ordering dependency, spawn/build/merge independently.
- **Ordering constraint (out of this lane's scope):** applying the branch-protection ruleset that
  references this workflow's check name is admin-privileged, Ben-only, and must happen only after
  this PR merges and runs green on `main` once. This lane's job is only to land the workflow PR —
  do not attempt to apply the ruleset yourself.
