# Build Handoff — 1279-external-module-gateway-validator

**Spec (approved):** docs/superpowers/specs/2026-08-09-wave-4-external-module-supply-chain.md
(lane C, last item)
**GitHub issue:** #1279 — "Pin external-module tools to the shared gateway validator with a test,
and name the tool in rejections"
**Risk tier:** `security` — this PR gets adversarial Opus QA + Ben merge sign-off. Build to that bar.
**Worktree:** ~/Jarv1s/.claude/worktrees/1279-external-module-gateway-validator
**Branch:** 1279-external-module-gateway-validator (off origin/main @ bcb3c2765)
**Build skill path (absolute):** ~/Jarv1s/.claude/skills/coordinated-build/SKILL.md
**Coordinator label:** `Coordinator` — escalate via `herdr-pane-message`; verify `herdr pane list`
shows EXACTLY ONE pane with this label, resolved fresh each time.
**Coordinator session id:** `11cf8264-55a8-4fa4-b32b-c8d086469f74`
**Relay trigger:** the context-meter 70% warning, or a compaction summary in your own context →
message the coordinator, then use the `relay` skill immediately.

## Start

1. `[ -d node_modules ] || pnpm install`
2. Read the spec above BY SECTION for your current task only (lane C, last item — the shared
   gateway validator pin + named-tool-in-rejections item). Never read the full multi-lane spec.
3. Invoke **`coordinated-build`** and follow it end-to-end: verify the spec against your actual
   branch → plan with **`plan-build`** → coordinator approval (do NOT write code before it) → TDD
   build → **`coordinated-wrap-up`** (PR + live-path proof if applicable + report).

## Exit criteria for this lane

- Spec exit criteria for the lane-C item met, full gate green on an isolated gate DB.
- PR open, rebased on `origin/main`.
- If this touches any user-facing surface, live-path proof posted as a `gh pr comment`. If it's
  internal-only (module-registry validator + test), say so explicitly instead.

## Run-specific bans (non-negotiable)

- Work ONLY in this worktree/branch; `git add` by explicit path — never `git add -A` or repo-wide
  `pnpm format`.
- Never touch `docs/coordination/` (coordinator-only), the project board, milestones, or merge.
- No secrets in any doc, payload, log, or prompt.

## Collision notes (from the coordinator)

- Three other lanes are building in parallel this wave: #1037, #1038 (chat privacy tests),
  #1468 (target-identity guard extension). Zero file overlap confirmed by Phase-0 collision map —
  you touch `packages/module-registry/src/external`; they touch chat test files and
  `scripts/*.ts`. No coordination needed between lanes.
- No shared migration in this batch.
