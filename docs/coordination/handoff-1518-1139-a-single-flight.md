# Build Handoff — 1139-a-single-flight

**Spec (approved):** docs/superpowers/specs/2026-08-10-1139-chat-export-ui-followups.md — read
only the "Child 1139-A — Make action resolution single-flight" section (~line 78-137).
**GitHub issue:** #1518
**Risk tier:** `routine` (chat UI state fix, no auth/RLS/secrets/migration/cross-module contract).
**Worktree:** .claude/worktrees/1139-a-single-flight **Branch:** 1139-a-single-flight (off origin/main)
**Build skill path (absolute):** /home/ben/Jarv1s/.claude/skills/coordinated-build/SKILL.md
**Coordinator label:** `Coordinator` — escalate via `herdr-pane-message`; verify `herdr pane list`
shows EXACTLY ONE pane with this label, resolved fresh (never a cached pane number).
**Coordinator session id:** `11cf8264-55a8-4fa4-b32b-c8d086469f74`
**Relay trigger:** context-meter 70% warning, or a compaction summary in your own context →
message the coordinator, then use the `relay` skill immediately.

## Start

1. `[ -d node_modules ] || pnpm install`.
2. Read the spec section named above only — never the full spec file.
3. Invoke **`coordinated-build`**: verify spec against your branch → plan with **`plan-build`** →
   coordinator approval before writing code → TDD build → **`coordinated-wrap-up`** (PR + live-path
   proof + report).

## Dependency gate (already verified clear by the coordinator before spawn)

This child's spec text says it "does not dispatch until #1449 / PR #1494 is merged." Confirmed
merged already — clear to build.

## Exit criteria for this lane

- Spec's "Focused regression" + "Live-path artifact" sections for 1139-A satisfied.
- Full gate green on an isolated gate DB.
- PR open, rebased on origin/main, live-path proof posted (this is a UI-facing chat surface fix).

## Run-specific bans (non-negotiable)

- Work ONLY in this worktree/branch; `git add` by explicit path — never `git add -A` or repo-wide
  `pnpm format`.
- Never touch `docs/coordination/` (coordinator-only), the project board, milestones, or merge.
- No secrets in any doc, payload, log, or prompt.

## Collision notes (from the coordinator)

- Three other lanes are building in parallel this wave: #1519 (1139-B, different file area —
  fallback reconciliation by record identity), #1522 (1139-E, Settings export — fully independent
  module), #1523 (1140-A, news preview sweep — unrelated module). No known file overlap with any of
  them, but if you touch shared chat-action resolution code outside your section, stop and check
  with the coordinator before proceeding.
