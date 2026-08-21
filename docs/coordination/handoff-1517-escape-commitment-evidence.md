# Build Handoff — 1517-escape-commitment-evidence

**Spec (approved):** docs/superpowers/specs/2026-08-10-1137-robustness-followups.md (section 1137-C4)
**GitHub issue:** #1517
**Risk tier:** routine
**Worktree:** /home/ben/Jarv1s/.claude/worktrees/1517-escape-commitment-evidence **Branch:** 1517-escape-commitment-evidence
**Build skill path (absolute):** /home/ben/Jarv1s/.claude/skills/coordinated-build/SKILL.md (follow this
exact file if `coordinated-build` does not resolve by name in your spawn env)
**Coordinator agent name:** `coordinator` — escalate via `herdr agent prompt coordinator` (through
`herdr-pane-message`); before messaging, verify `herdr agent list` shows EXACTLY ONE live agent
with this name, resolved fresh each time. The visible pane label should also be `Coordinator`.
**Coordinator session id:** 9674b6c7-87b1-4612-afad-361c7f9070fa (immutable authority; label is only routing).
**Relay trigger:** the context-meter 70% warning, or a compaction summary in your own context →
message the coordinator, then use the `relay` skill immediately.

## Start

1. `[ -d node_modules ] || pnpm install` (worktrees share the pnpm store; relay successors skip).
2. Read the spec above BY SECTION for your current task only (1137-C4) — never in full.
3. Invoke **`coordinated-build`** and follow it end-to-end: verify the spec against your actual
   branch → plan with **`plan-build`** → coordinator approval (do NOT write code before it) → TDD
   build → **`coordinated-wrap-up`** (PR + live-path proof + report).

## Exit criteria for this lane

- Escape ampersand and angle brackets once and truncate commitment evidence to the existing
  500-character database limit, per the 1137-C4 contract in the spec.
- Spec Exit Criteria met, full gate green on an isolated gate DB.
- PR open, rebased on `origin/main`.
- This is backend text-handling, not a UI surface — live-path proof only required if your change
  touches a rendered surface; if unsure, ask the coordinator rather than skip it.

## Run-specific bans (non-negotiable)

- Work ONLY in this worktree/branch; `git add` by explicit path — never `git add -A` or repo-wide
  `pnpm format`.
- Never touch `docs/coordination/` (coordinator-only), the project board, milestones, or merge.
- No secrets in any doc, payload, log, or prompt.
- Keep this to one implementation session — do not absorb sibling 1137-C* cleanup.

## Collision notes (from the coordinator)

- #1515 (the C-series sibling this depended on) already merged — you're building on top of it,
  no coordination needed with a live lane.
