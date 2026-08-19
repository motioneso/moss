# Build Handoff — 1139-b-fallback-identity

**Spec (approved):** docs/superpowers/specs/2026-08-10-1139-chat-export-ui-followups.md — read
only the "Child 1139-B — Reconcile fallbacks by record identity" section (~line 139-183).
**GitHub issue:** #1519
**Risk tier:** `routine` (chat UI state fix, no auth/RLS/secrets/migration/cross-module contract).
**Worktree:** .claude/worktrees/1139-b-fallback-identity **Branch:** 1139-b-fallback-identity (off origin/main)
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

This child's spec text says it does not dispatch until #1482 AND #1449/PR#1494 are merged.
Confirmed both merged already — clear to build.

**Note:** the spec's dependency chain lists 1139-B → 1139-C → 1139-D as sequential (C depends on
B merged, D depends on C). Only B (this lane, #1519) is being spawned now — do NOT build C or D's
scope; they are separate future lanes gated on this one landing.

## Exit criteria for this lane

- Spec's "Focused regression" (if present) + "Live-path artifact" sections for 1139-B satisfied.
- Full gate green on an isolated gate DB.
- PR open, rebased on origin/main, live-path proof posted (this is a UI-facing chat surface fix).

## Run-specific bans (non-negotiable)

- Work ONLY in this worktree/branch; `git add` by explicit path — never `git add -A` or repo-wide
  `pnpm format`.
- Never touch `docs/coordination/` (coordinator-only), the project board, milestones, or merge.
- No secrets in any doc, payload, log, or prompt.

## Collision notes (from the coordinator)

- Three other lanes are building in parallel this wave: #1518 (1139-A, action resolution
  single-flight — different mechanism, same chat surface), #1522 (1139-E, Settings export — fully
  independent module), #1523 (1140-A, news preview sweep — unrelated module). Watch for overlap
  with #1518 in shared chat-message-rendering code; if you touch anything outside your section,
  stop and check with the coordinator before proceeding.
