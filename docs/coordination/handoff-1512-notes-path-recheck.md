# Build Handoff — 1512-notes-path-recheck

**Spec (approved):** docs/superpowers/specs/2026-08-10-1137-robustness-followups.md — read
section §B1 only.
**GitHub issue:** #1512
**Risk tier:** `security` — this is a filesystem trust-boundary fix (fail-closed path
recheck), not a routine change. Build to the security bar from the start: no shortcuts on the
guard logic, and expect adversarial QA plus Fable-5 sign-off before merge (see below).
**Worktree:** ~/Jarv1s/.claude/worktrees/1512-notes-path-recheck **Branch:**
1512-notes-path-recheck (off origin/main)
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
2. Read the spec above BY SECTION (§B1 only) — never in full.
3. Invoke **`coordinated-build`** and follow it end-to-end: verify the spec against your actual
   branch → plan with **`plan-build`** → coordinator approval (do NOT write code before it) → TDD
   build → **`coordinated-wrap-up`** (PR + live-path proof + report).

## Exit criteria for this lane

- Spec Exit Criteria met, full gate green **on an isolated gate DB**.
- PR open, rebased on `origin/main`.
- Live-path proof: not required — this is a backend filesystem-guard fix (`path-guard.ts`,
  `write-tools.ts`, `jobs.ts`), no user-facing UI surface. State that explicitly in the wrap-up
  report instead of skipping the question.
- **Because this is security tier: do not expect routine auto-merge.** The coordinator will spawn
  adversarial (Opus) QA and route to Fable-5 for sign-off under the standing security-tier
  delegation before merge — same procedure as PR #1663. Your job ends at a clean, well-tested PR;
  merge decision is the coordinator's, not yours.

## Run-specific bans (non-negotiable)

- Work ONLY in this worktree/branch; `git add` by explicit path — never `git add -A` or repo-wide
  `pnpm format`.
- Never touch `docs/coordination/` (coordinator-only), the project board, milestones, or merge.
- No secrets in any doc, payload, log, or prompt.

## Collision notes (from the coordinator)

- File-disjoint from every other lane in this wave and from #1654/#1663 (already merged). No
  known collisions.
- #1513 depends on this issue and touches the same files — held, do not start it; the coordinator
  will spawn it serialized behind this one once it merges.
