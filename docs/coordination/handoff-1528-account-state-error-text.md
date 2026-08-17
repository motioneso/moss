# Build Handoff — 1140-F account-state error text

**Spec (approved):** docs/superpowers/specs/2026-08-10-1140-backend-low-followups.md (section 1140-F)
**GitHub issue:** #1528 — required, no exceptions.
**Risk tier:** `security` (auth/account-state error handling). This PR gets adversarial Opus QA +
Ben merge sign-off — build to that bar.
**Worktree:** ~/Jarv1s/.claude/worktrees/1528-account-state-error-text
**Branch:** 1528-account-state-error-text (off origin/main)
**Build skill path (absolute):** ~/Jarv1s/.claude/skills/coordinated-build/SKILL.md (follow this
exact file if `coordinated-build` does not resolve by name in your spawn env)
**Coordinator label:** `Coordinator` — escalate via `herdr-pane-message`; before messaging,
verify `herdr pane list` shows EXACTLY ONE pane with this label, resolved fresh each time (never
a cached `…-N` pane number — they reflow).
**Coordinator session id:** `de66eab9-b0c0-49fe-b508-806759583d36` (immutable authority; label is
only routing).
**Relay trigger:** the context-meter 70% warning, or a compaction summary in your own context →
message the coordinator, then use the `relay` skill immediately.

## Start

1. `[ -d node_modules ] || pnpm install` (worktrees share the pnpm store; relay successors skip).
2. Read the spec above BY SECTION for your current task only (1140-F) — never in full. A full-read
   bloats a fresh context toward the relay threshold before you write any code.
3. Invoke **`coordinated-build`** and follow it end-to-end: verify the spec against your actual
   branch → plan with **`plan-build`** (NOT `superpowers:writing-plans`) → coordinator approval
   (do NOT write code before it) → TDD build → **`coordinated-wrap-up`** (PR + live-path proof +
   report).

## Scope (from issue #1528)

Dependency gate cleared: #1527 (1140-E) merged (`0042fbb37`). Owned scope: map pending and
deactivated account codes to fixed 403 literals while preserving codes and scrubbing unknown auth
errors. Acceptance is the 1140-F contract in the spec. Keep this to one implementation session —
do not absorb sibling cleanup.

## Exit criteria for this lane

- Spec Exit Criteria met, full gate green **on an isolated gate DB**.
- PR open, rebased on `origin/main`.
- **Live-path proof posted** if this touches a user-facing feature, module, or UI surface: the
  feature exercised through the real UI on a live dev instance. Cannot produce it? Report
  **code-complete, unverified** — never "done".

## Run-specific bans (non-negotiable)

- Work ONLY in this worktree/branch; `git add` by explicit path — never `git add -A` or repo-wide
  `pnpm format`.
- Never touch `docs/coordination/` (coordinator-only), the project board, milestones, or merge.
- No secrets in any doc, payload, log, or prompt.

## Collision notes (from the coordinator)

- None known. Sibling 1140-E (#1527) already merged; this is the next serialized item in the
  1140-backend-low-followups chain. If you find another open 1140-* PR touching the same auth
  error-handling file, stop and escalate rather than guessing merge order.
