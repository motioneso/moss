# Build Handoff — w3c-audit-truth

**Spec (approved):** docs/superpowers/specs/2026-08-09-wave-3-action-audit-truth.md
**GitHub issue:** #1136 (lane C)
**Risk tier:** `security` — this PR gets adversarial Opus QA + Ben merge sign-off (delegated to a
one-shot `Agent(model: "fable")` this run — see manifest Merge policy). Build to that bar. Your
plan also needs a Fable plan-review at the plan-ready checkpoint before coordinator approval — see
manifest "Plan review (security-tier)" line.
**Worktree:** ~/Jarv1s/.claude/worktrees/w3c-audit-truth **Branch:** w3c-audit-truth (off origin/main)
**Build skill path (absolute):** ~/Jarv1s/.claude/skills/coordinated-build/SKILL.md (follow this
exact file if `coordinated-build` does not resolve by name in your spawn env)
**Coordinator label:** `Coordinator` — escalate via `herdr-pane-message`; before messaging,
verify `herdr pane list` shows EXACTLY ONE pane with this label, resolved fresh each time (never
a cached `…-N` pane number — they reflow).
**Coordinator session id:** `890502d0-c97b-4ed1-aaae-8c33ec48c98f` (immutable authority; label is
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
- PR open, rebased on `origin/main`.
- **Live-path proof posted** if this touches a user-facing feature, module, or UI surface: the
  feature exercised through the real UI on a live dev instance, as a `gh pr comment` with the UAT
  run, exit code, and assertions or bounded DOM/network/log evidence. Cannot produce it? Report **code-complete, unverified** — never "done".
  `docs/DEVELOPMENT_STANDARDS.md` → Live-Path Gate.

## Run-specific bans (non-negotiable)

- Work ONLY in this worktree/branch; `git add` by explicit path — never `git add -A` or repo-wide
  `pnpm format`.
- Never touch `docs/coordination/` (coordinator-only), the project board, milestones, or merge.
- No secrets in any doc, payload, log, or prompt.

## Collision notes (from the coordinator)

- This spec has 3 lanes (A/B/C) all landing in Wave 3 — read the spec's lane/file-split section
  before touching any file another lane might also own. Lanes A (#1256/#1252/#1251) and B (#1055)
  are building concurrently with you against the same spec.
- Wave 3 as a whole is serialized BEFORE Wave 4 (both touch `packages/ai` +
  `packages/chat/src/live`) — Wave 4 is held for batch 2, not running concurrently with you, so you
  do not need to coordinate with it directly, but do not assume any Wave-4-owned file is free to
  restructure.
- Security tier: hunt for what's NOT tested / unproven trust boundaries, not just green tests.
