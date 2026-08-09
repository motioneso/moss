# Build Handoff — w6a-secure-context

**Spec (approved):** docs/superpowers/specs/2026-08-09-wave-6-secure-context-and-weather.md
**GitHub issue:** #1403 (lane A)
**Risk tier:** `security` — this PR gets adversarial Opus QA + Ben merge sign-off (delegated to a
one-shot `Agent(model: "fable")` this run — see manifest Merge policy). Build to that bar. Your
plan also needs a Fable plan-review at the plan-ready checkpoint before coordinator approval — see
manifest "Plan review (security-tier)" line.
**Worktree:** ~/Jarv1s/.claude/worktrees/w6a-secure-context **Branch:** w6a-secure-context (off origin/main)
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
  run and screenshots. Cannot produce it? Report **code-complete, unverified** — never "done".
  `docs/DEVELOPMENT_STANDARDS.md` → Live-Path Gate.

## Run-specific bans (non-negotiable)

- Work ONLY in this worktree/branch; `git add` by explicit path — never `git add -A` or repo-wide
  `pnpm format`.
- Never touch `docs/coordination/` (coordinator-only), the project board, milestones, or merge.
- No secrets in any doc, payload, log, or prompt.

## Collision notes (from the coordinator)

- Independent of the Wave 3 → Wave 4 serialized chain and of Wave 5 — no coordination needed there.
- Building concurrently with Wave 6 lane B (#900/#1134) and lane C stage 1 (#1402, timezone floor)
  against the same spec — read the spec's per-lane file split before starting.
- **You block downstream work:** Wave 6 lane C stage 2 (geolocation upgrade) is held until THIS
  lane (#1403) merges to `main` — flag it to the coordinator clearly when your PR lands.
- Security tier: hunt for what's NOT tested / unproven trust boundaries, not just green tests.
