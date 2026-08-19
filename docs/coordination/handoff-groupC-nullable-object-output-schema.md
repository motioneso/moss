# Build Handoff — post1632-groupC-nullable-object-output-schema

**Spec (approved):** docs/superpowers/specs/2026-08-16-post1632-groupC-nullable-object-output-schema.md
**GitHub issue:** #1337
**Risk tier:** `sensitive` — output-schema handling for tool results is a cross-cutting contract
change. Standard QA plus an explicit invariant check plus matched e2e-UAT; per-merge digest to Ben.
**Worktree:** ~/Jarv1s/.claude/worktrees/groupC-nullable-object-output-schema
**Branch:** groupC-nullable-object-output-schema (off origin/main)
**Build skill path (absolute):** ~/Jarv1s/.claude/skills/coordinated-build/SKILL.md (follow this
exact file if `coordinated-build` does not resolve by name in your spawn env)
**Coordinator label:** `Coordinator` — escalate via `herdr-pane-message`; before messaging,
verify `herdr pane list` shows EXACTLY ONE pane with this label, resolved fresh each time.
**Coordinator session id:** `11cf8264-55a8-4fa4-b32b-c8d086469f74` (immutable authority; label is only routing).
**Relay trigger:** the context-meter 70% warning, or a compaction summary in your own context →
message the coordinator, then use the `relay` skill immediately.

## Start

1. `[ -d node_modules ] || pnpm install` (worktrees share the pnpm store; relay successors skip).
2. Read the spec above BY SECTION for your current task only — never in full.
3. Invoke **`coordinated-build`** and follow it end-to-end: verify the spec against your actual
   branch → plan with **`plan-build`** (NOT `superpowers:writing-plans`) → coordinator approval (do
   NOT write code before it) → TDD build → **`coordinated-wrap-up`** (PR + live-path proof +
   report). Escalation rules and gate commands are defined there — this doc does not restate them.

## Exit criteria for this lane

- Spec Exit Criteria met, full gate green **on an isolated gate DB** (`coordinated-wrap-up` step 2).
- PR open, rebased on `origin/main`.
- **Live-path proof posted** if this touches a user-facing feature, module, or UI surface.
  Cannot produce it? Report **code-complete, unverified** — never "done".
  `docs/DEVELOPMENT_STANDARDS.md` → Live-Path Gate.
- Sensitive tier: explicitly verify and state in your wrap-up report which invariant applies —
  this is a tool-output-schema contract change, so confirm module manifest schema handling stays
  consistent for every module that declares a nullable object output, not just the one you test.

## Run-specific bans (non-negotiable)

- Work ONLY in this worktree/branch; `git add` by explicit path — never `git add -A` or repo-wide
  `pnpm format`.
- Never touch `docs/coordination/` (coordinator-only), the project board, milestones, or merge.
- No secrets in any doc, payload, log, or prompt.

## Collision notes (from the coordinator)

- No known file overlap with the concurrently-running Group A / Group B lanes or #1522 (Fable
  confirmed zero overlap when drafting these three specs). If you discover overlap, stop and
  escalate rather than guessing at merge order.
