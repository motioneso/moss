# Build Handoff — 1497 Today residue

**Spec (approved):** `docs/superpowers/specs/2026-08-10-css-guard-residue.md` — Child A contract only
**GitHub issue:** #1497
**Risk tier:** `routine`
**Worktree:** `~/Jarv1s/.claude/worktrees/1497-today-residue` **Branch:** `build/1497-today-residue` off current `origin/main`
**Build skill path:** `~/Jarv1s/.claude/skills/coordinated-build/SKILL.md`
**Coordinator agent name:** `coordinator`
**Coordinator session id:** `01a02e90-46d7-7093-bffd-5e2a4bb029dc`
**Relay trigger:** context-meter 70% warning or compaction summary.

## Start

1. `[ -d node_modules ] || pnpm install`.
2. Read only the Child A section needed for this task.
3. Invoke the `design-system` skill before UI/CSS work, then `coordinated-build`; plan via `plan-build` and send the pointer to `coordinator`.
4. Do not implement until a one-shot Fable plan review returns APPROVE.

## Exit criteria

- Meet the approved Child A contract without absorbing sibling cleanup.
- PR open, rebased on `origin/main`, required CI green, and release-note section complete.
- Post live-path proof from a real dev instance: bounded light/dark browser comparison through the real Today UI, with the UAT command/run, exit code, and assertions or DOM evidence in a PR comment.

## Run-specific bans

- Work only in this worktree and branch. Add/commit explicit paths only; no repo-wide format.
- Never touch `docs/coordination/`, project fields, milestones, or merge.
- No invented design classes or bypass of the design-system audit.

## Collision notes

- Branch only from current `origin/main`; sibling CSS/package PRs #1841, #1868, #1873, and #1878 are already landed.
- #1517 is parallel but disjoint. Rebase on current `origin/main` before final QA/merge.
