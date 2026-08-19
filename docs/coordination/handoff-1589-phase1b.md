# Build Handoff — 1589-job-failure-incident-closure (Phase 1 only)

**Spec (approved):** docs/superpowers/specs/2026-08-15-1589-job-failure-incident-closure.md
(Phase 1 only — Phase 2 split to #1634, out of scope for this lane)
**GitHub issue:** #1589
**Risk tier:** `sensitive` — data-loss fix in `packages/memory/src/repository.ts`. Standard QA
plus explicit invariant check plus matched e2e-UAT; auto-merge after green + digest to Ben.
**Worktree:** ~/Jarv1s/.claude/worktrees/build-1589-phase1b **Branch:** build-1589-phase1b (off
origin/main @ 389e96488)
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

- Spec Exit Criteria met (Phase 1 only), full gate green **on an isolated gate DB**
  (`coordinated-wrap-up` step 2).
- PR open, rebased on `origin/main`.
- **Live-path proof posted** if this touches a user-facing feature, module, or UI surface: the
  feature exercised through the real UI on a live dev instance, as a `gh pr comment` with the UAT
  run, exit code, and assertions or bounded DOM/network/log evidence. Cannot produce it? Report
  **code-complete, unverified** — never "done".
  `docs/DEVELOPMENT_STANDARDS.md` → Live-Path Gate.
- `sensitive` tier: also do the explicit invariant walk (DataContextDb/VaultContext,
  metadata-only pg-boss payloads, module isolation) called out in `coordinated-qa`.

## Run-specific bans (non-negotiable)

- Work ONLY in this worktree/branch; `git add` by explicit path — never `git add -A` or repo-wide
  `pnpm format`.
- Never touch `docs/coordination/` (coordinator-only), the project board, milestones, or merge.
- No secrets in any doc, payload, log, or prompt.

## Collision notes (from the coordinator)

- Zero file overlap with #895 or #1013 — no ordering dependency, spawn/build/merge independently.
- Phase 1a is already resolved (confirmed by Ben) — do not re-open it. Phase 2 is split to #1634
  and needs its own spec; do not fold it into this lane.
