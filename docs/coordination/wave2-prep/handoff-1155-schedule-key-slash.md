# Build Handoff — fix-1155-schedule-key-slash

**Spec (approved):** docs/superpowers/specs/2026-08-08-non-feature-wave-2.md (your row: #1155)
**GitHub issue:** #1155
**Risk tier:** `routine`
**Worktree:** ~/Jarv1s/.claude/worktrees/fix-1155-schedule-key-slash **Branch:** fix-1155-schedule-key-slash (off origin/main)
**Build skill path (absolute):** ~/Jarv1s/.claude/skills/coordinated-build/SKILL.md (follow this
exact file if `coordinated-build` does not resolve by name in your spawn env)
**Coordinator label:** `Coordinator` — escalate via `herdr-pane-message`; before messaging,
verify `herdr pane list` shows EXACTLY ONE pane with this label, resolved fresh each time (never
a cached `…-N` pane number — they reflow).
**Coordinator session id:** f6461c25-9951-432c-9535-6fb497a92751 (immutable authority; label is only routing).
**Relay trigger:** the context-meter 70% warning, or a compaction summary in your own context →
message the coordinator, then use the `relay` skill immediately.

## Start

1. `[ -d node_modules ] || pnpm install` (worktrees share the pnpm store; relay successors skip).
2. Read the spec above BY SECTION for your current task only — never in full.
3. Invoke **`coordinated-build`** and follow it end-to-end: verify the spec against your actual
   branch → plan with **`plan-build`** (NOT `superpowers:writing-plans`) → coordinator approval (do
   NOT write code before it) → TDD build → **`coordinated-wrap-up`** (PR + live-path proof +
   report).

## Exit criteria for this lane

- Spec Exit Criteria met, full gate green **on an isolated gate DB** (`coordinated-wrap-up` step 2).
- Requires a real pg-boss v12 integration test proving the schedule-key slash fix — not fake-only.
- PR open, rebased on `origin/main`.
- This lane touches `packages/module-registry/src/index.ts` — not directly user-facing UI, so
  live-path proof is not required unless your diff also touches a UI surface. If in doubt, ask.

## Run-specific bans (non-negotiable)

- Work ONLY in this worktree/branch; `git add` by explicit path — never `git add -A` or repo-wide
  `pnpm format`.
- Never touch `docs/coordination/` (coordinator-only), the project board, milestones, or merge.
- No secrets in any doc, payload, log, or prompt.

## Collision notes (from the coordinator)

- None. Your seam (`packages/module-registry/src/index.ts`) is disjoint from the other three
  Wave 2 lanes (#1207 assistant-surface, #1115 task-list-view, #1433 datasets client).
- Merge order for this wave: #1207 → #1155 → #1115 → #1433. You merge second — do not assume a
  migration number if you add one; the coordinator assigns landing order.
