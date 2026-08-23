# Build Handoff — 1517 evidence escape

**Spec (approved):** `docs/superpowers/specs/2026-08-10-1137-robustness-followups.md` — contract 1137-C4 only
**GitHub issue:** #1517
**Risk tier:** `routine`
**Worktree:** `~/Jarv1s/.claude/worktrees/1517-evidence-escape` **Branch:** `build/1517-evidence-escape` off current `origin/main`
**Build skill path:** `~/Jarv1s/.claude/skills/coordinated-build/SKILL.md`
**Coordinator agent name:** `coordinator`
**Coordinator session id:** `01a02e90-46d7-7093-bffd-5e2a4bb029dc`
**Relay trigger:** context-meter 70% warning or compaction summary.

## Start

1. `[ -d node_modules ] || pnpm install`.
2. Read only the 1137-C4 section needed for this task.
3. Invoke `coordinated-build`, plan via `plan-build`, and send the plan pointer to `coordinator`.
4. Do not implement until a one-shot Fable plan review returns APPROVE.

## Exit criteria

- Escape ampersands and angle brackets exactly once, then truncate to the existing 500-character database limit, as locked by the approved contract.
- Leave one smallest runnable regression check.
- PR open, rebased on `origin/main`, required CI green, and release-note section complete.

## Run-specific bans

- Work only in this worktree and branch. Add/commit explicit paths only; no repo-wide format.
- Never touch `docs/coordination/`, project fields, milestones, or merge.
- No secrets or private evidence text in logs, docs, payloads, or prompts.

## Collision notes

- #1497 is parallel but disjoint. Rebase on current `origin/main` before final QA/merge.
