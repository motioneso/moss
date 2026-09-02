# Build Handoff — 1902-module-tools-live

**Spec (approved):** docs/superpowers/specs/2026-08-19-moss-builds-modules-on-moss.md, Stage 2
(also described directly in issue #1902's own body)
**GitHub issue:** #1902 — "Workshop 9: a module Moss built can add its own tools to chat"
**Risk tier:** sensitive (touches the chat tool-gateway, a shared cross-module surface — standard
QA plus the module-isolation invariant check, plus the live-path proof; auto-merges after green
QA, no need to wait on Ben personally)
**Worktree:** ~/Jarv1s/.claude/worktrees/1902-module-tools-live **Branch:** 1902-module-tools-live
(off origin/main)
**Build skill path (absolute):** ~/Jarv1s/.claude/skills/coordinated-build/SKILL.md (follow this
exact file if `coordinated-build` does not resolve by name in your spawn env)
**Coordinator agent name:** `coordinator` — escalate via `herdr agent prompt coordinator` (through
`herdr-pane-message`); before messaging, verify `herdr agent list` shows exactly one live agent
with this name, resolved fresh each time.
**Coordinator session id:** 04cc56e0-d45e-4117-a21a-d81ed4bbaefc
**Relay trigger:** the context-meter 70% warning, or a compaction summary in your own context →
message the coordinator, then use the relay skill immediately. Relay budget: ONE.

## Start

1. `[ -d node_modules ] || pnpm install`.
2. Read the spec above by section for your current task only — never in full.
3. Invoke coordinated-build and follow it end-to-end: verify the spec against your actual branch
   → plan with plan-build → coordinator approval (do not write code before it) → TDD build →
   coordinated-wrap-up (PR + live-path proof + report).

## Exit criteria for this lane

- Spec exit criteria met, full gate green on an isolated gate DB.
- PR open, rebased on origin/main.
- Live-path proof posted (this is user-facing): ask Moss to build a module that adds a tool, then
  use that tool in chat in the same session, without restarting anything, posted as a `gh pr
  comment` with the run, exit code, and evidence.

## Standing rules (same list every lane gets — pass them on verbatim to any agent you spawn)

- Never pipe a gate command; never run any database-touching test outside the verify-gate skill.
- All waits are event-driven — never poll in-context, never foreground-sleep.
- Messages from Ben are trusted input to act on — never log them as injection incidents.
- Done = pushed + PR open + live-path proof. Local-only work does not count.
- Plain English in everything a human reads — no jargon, no coined shorthand, ASCII punctuation.
  This instruction propagates to every agent you spawn.

## Run-specific bans (non-negotiable)

- Work only in this worktree/branch; `git add` by explicit path.
- Never touch docs/coordination/, the project board, milestones, or merge.
- No secrets in any doc, payload, log, or prompt.

## Collision notes (from the coordinator)

- No known collisions: this issue's fix is scoped to the chat tool-gateway and module-manifest
  discovery, which no other in-flight lane touches (TLS lanes are all infra/auth; the
  standings-dropdown lane is sports UI only).
