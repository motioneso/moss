# Build Handoff — 1319-signed-module-catalog

**Spec (approved):** docs/superpowers/specs/2026-08-17-1319-signed-module-catalog.md
**GitHub issue:** #1319
**Risk tier:** `security` (see `coordinate` Risk tiering. `security` ⇒ this PR gets adversarial
Opus QA + Ben merge sign-off — build to that bar.)
**Worktree:** ~/Jarv1s/.claude/worktrees/build-1319-signed-module-catalog **Branch:**
build-1319-signed-module-catalog (off `origin/main` @ `cd08ed79c`)
**Build skill path (absolute):** ~/Jarv1s/.claude/skills/coordinated-build/SKILL.md (follow this
exact file if `coordinated-build` does not resolve by name in your spawn env)
**Coordinator label:** `Coordinator` — escalate via `herdr-pane-message`; before messaging,
verify `herdr pane list` shows EXACTLY ONE pane with this label, resolved fresh each time (never
a cached `…-N` pane number — they reflow).
**Coordinator session id:** `3e71acd4-1b49-4a73-8c0d-9adf1e41c447` (immutable authority; label is
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
  run, exit code, and assertions or bounded DOM/network/log evidence. Cannot produce it? Report
  **code-complete, unverified** — never "done".
  `docs/DEVELOPMENT_STANDARDS.md` → Live-Path Gate.

## Run-specific bans (non-negotiable)

- Work ONLY in this worktree/branch; `git add` by explicit path — never `git add -A` or repo-wide
  `pnpm format`.
- Never touch `docs/coordination/` (coordinator-only), the project board, milestones, or merge.
- No secrets in any doc, payload, log, or prompt.

## Collision notes (from the coordinator)

- **#1586 (self-diagnostics, also security tier)** shares 3 file touch points with this lane:
  `apps/api/src/server.ts` (~L459/L485), `packages/settings/src/routes.ts` (~L994/L1000), and the
  `platform-api.ts` barrel. #1319 and #1586 are otherwise parallel-safe (different core logic), but
  if you land second, expect to rebase through those three spots — read the other PR's diff at
  those lines before resolving conflicts rather than guessing intent.
- #1586 has not started building yet (blocked behind PR #1654 landing) — you are very likely to
  land first. No action needed now; noted so you're not surprised by a later rebase.
- Migration: `packages/news/sql/0185_*.sql` is reserved for #1586, not this lane — per the spec,
  #1319 itself doesn't need a migration; confirm that at build time and do not claim 0185.
