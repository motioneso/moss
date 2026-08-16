# Build Handoff — 1139-e-export-resume

**Spec (approved):** docs/superpowers/specs/2026-08-10-1139-chat-export-ui-followups.md — read
only the "Child 1139-E — Resume an export after remount" section (~line 281-336).
**GitHub issue:** #1522
**Risk tier:** `routine` (Settings UI state fix, no auth/RLS/secrets/migration/cross-module contract).
**Worktree:** .claude/worktrees/1139-e-export-resume **Branch:** 1139-e-export-resume (off origin/main)
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

Spec text: "1139-E is independent and may run in parallel... because it owns only the Settings
export flow." No blocking dependency — clear to build.

## Exit criteria for this lane

- Spec's "Focused regression" + "Live-path artifact" sections for 1139-E satisfied.
- Full gate green on an isolated gate DB.
- PR open, rebased on origin/main, live-path proof posted (this is a UI-facing Settings surface fix).

## Run-specific bans (non-negotiable)

- Work ONLY in this worktree/branch; `git add` by explicit path — never `git add -A` or repo-wide
  `pnpm format`.
- Never touch `docs/coordination/` (coordinator-only), the project board, milestones, or merge.
- No secrets in any doc, payload, log, or prompt.

## Collision notes (from the coordinator)

- Three other lanes building in parallel this wave, all in unrelated modules (#1518/#1519 chat
  action resolution, #1523 news preview sweep). No known overlap expected — this is the most
  isolated of the four.
