# Build Handoff — 1520-chat-drawer-queued-drain

**Spec (approved):** docs/superpowers/specs/2026-08-10-1139-chat-export-ui-followups.md — read
section §1139-C only.
**GitHub issue:** #1520
**Risk tier:** `routine` — but the **Live-Path Gate applies** (see Exit criteria below). This
touches a user-facing UI surface (`chat-drawer.tsx`), so CI-green is not enough to merge.
**Worktree:** ~/Jarv1s/.claude/worktrees/1520-chat-drawer-queued-drain **Branch:**
1520-chat-drawer-queued-drain (off origin/main)
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
2. Read the spec above BY SECTION (§1139-C only) — never in full.
3. Invoke **`coordinated-build`** and follow it end-to-end: verify the spec against your actual
   branch → plan with **`plan-build`** → coordinator approval (do NOT write code before it) → TDD
   build → **`coordinated-wrap-up`** (PR + live-path proof + report).

## Exit criteria for this lane

- Spec Exit Criteria met, full gate green **on an isolated gate DB**, plus the one e2e scenario
  the spec calls for.
- PR open, rebased on `origin/main`.
- **Live-path proof is required, not optional.** Before this can merge, install and exercise the
  drawer's queued-message drain through the real UI on a live dev instance, and post the run
  (steps, exit code, and assertions or bounded DOM/network/log evidence) as a `gh pr comment`. If
  you cannot get a live dev instance running yourself, say so explicitly in the wrap-up report as
  "code-complete, unverified" rather than skipping the question or claiming it's done.

## Run-specific bans (non-negotiable)

- Work ONLY in this worktree/branch; `git add` by explicit path — never `git add -A` or repo-wide
  `pnpm format`.
- Never touch `docs/coordination/` (coordinator-only), the project board, milestones, or merge.
- No secrets in any doc, payload, log, or prompt.

## Collision notes (from the coordinator)

- File-disjoint from every other lane in this wave and from #1654/#1663 (already merged). No
  known collisions.
- #1521 depends on this issue — do not start it; the coordinator will spawn it after this merges.
