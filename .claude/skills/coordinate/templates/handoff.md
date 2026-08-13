# Build Handoff — <spec slug>

**Spec (approved):** docs/superpowers/specs/<slug>.md
**GitHub issue:** #NN — **required, no exceptions.** Never `—`, never "live feedback". A lane with
no issue is invisible to every later sweep; that is how nine live-verified commits were deleted on
2026-07-26. If this field is empty, escalate before planning.
**Risk tier:** `routine` | `sensitive` | `security` (see `coordinate` Risk tiering. `security` ⇒
this PR gets adversarial Opus QA + Ben merge sign-off — build to that bar.)
**Worktree:** <repo>/.claude/worktrees/<slug> **Branch:** <branch off origin/main>
**Build skill path (absolute):** <repo>/.claude/skills/coordinated-build/SKILL.md (follow this
exact file if `coordinated-build` does not resolve by name in your spawn env)
**Coordinator label:** `Coordinator` — escalate via `herdr-pane-message`; before messaging,
verify `herdr pane list` shows EXACTLY ONE pane with this label, resolved fresh each time (never
a cached `…-N` pane number — they reflow).
**Coordinator session id:** `<agent_session.value>` (immutable authority; label is only routing).
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
  run, real exit code, and assertions or bounded DOM/network/log/database evidence. Screenshots are
  not required and should not be generated, captured, attached, or preserved. Cannot produce it?
  Report **code-complete, unverified** — never "done".
  `docs/DEVELOPMENT_STANDARDS.md` → Live-Path Gate.

## Run-specific bans (non-negotiable)

- Work ONLY in this worktree/branch; `git add` by explicit path — never `git add -A` or repo-wide
  `pnpm format`.
- Never touch `docs/coordination/` (coordinator-only), the project board, milestones, or merge.
- No secrets in any doc, payload, log, or prompt.

## Collision notes (from the coordinator)

- <e.g. "Your migration lands AFTER #NN's — do not assume a migration number; the coordinator
  assigns landing order." / "You share `app.tasks` with <spec> — coordinate schema changes.">
