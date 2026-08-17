# Build Handoff — 1514-commitment-upsert-atomic

**Spec (approved):** docs/superpowers/specs/2026-08-10-1137-robustness-followups.md — read
section §C1 only.
**GitHub issue:** #1514
**Risk tier:** `routine`
**Worktree:** ~/Jarv1s/.claude/worktrees/1514-commitment-upsert-atomic **Branch:**
1514-commitment-upsert-atomic (off origin/main)
**Build skill path (absolute):** ~/Jarv1s/.claude/skills/coordinated-build/SKILL.md (follow this
exact file if `coordinated-build` does not resolve by name in your spawn env)
**Coordinator label:** `Coordinator` — escalate via `herdr-pane-message`; before messaging,
verify `herdr pane list` shows EXACTLY ONE pane with this label, resolved fresh each time (never
a cached `…-N` pane number — they reflow).
**Coordinator session id:** `11cf8264-55a8-4fa4-b32b-c8d086469f74` (immutable authority; label is
only routing).
**Relay trigger:** the context-meter 70% warning, or a compaction summary in your own context →
message the coordinator, then use the `relay` skill immediately.

## Start

1. `[ -d node_modules ] || pnpm install` (worktrees share the pnpm store; relay successors skip).
2. Read the spec above BY SECTION (§C1 only) — never in full.
3. Invoke **`coordinated-build`** and follow it end-to-end: verify the spec against your actual
   branch → plan with **`plan-build`** → coordinator approval (do NOT write code before it) → TDD
   build → **`coordinated-wrap-up`** (PR + live-path proof + report).

## Exit criteria for this lane

- Spec Exit Criteria met, full gate green **on an isolated gate DB**.
- PR open, rebased on `origin/main`.
- Live-path proof: not required — this is an atomic-upsert fix confined to
  `packages/commitments/src/repository.ts`, no user-facing UI surface. State that explicitly in
  the wrap-up report instead of skipping the question.

## Run-specific bans (non-negotiable)

- Work ONLY in this worktree/branch; `git add` by explicit path — never `git add -A` or repo-wide
  `pnpm format`.
- Never touch `docs/coordination/` (coordinator-only), the project board, milestones, or merge.
- No secrets in any doc, payload, log, or prompt.

## Collision notes (from the coordinator)

- File-disjoint from every other lane in this wave and from #1654/#1663 (already merged). No
  known collisions.
- #1515 and #1516 touch the same package (`packages/commitments`) and are held — the coordinator
  will spawn them serialized behind this one once it merges, not in parallel.
