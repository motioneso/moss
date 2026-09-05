# Build Handoff — #2175 Task 6 connection detail UI

**Spec (approved):** `docs/superpowers/specs/2026-09-01-integration-tool-call-discipline.md`
**Plan section:** `docs/superpowers/plans/2026-09-01-integration-tool-call-discipline.md` → Task 6 only
**GitHub issue:** #2175
**Risk tier:** `sensitive`
**Worktree:** `~/Jarv1s/.claude/worktrees/2175-task6-ui`
**Branch:** `build/2175-task6-ui` off `origin/main`
**Build skill path:** `~/Jarv1s/.claude/skills/coordinated-build/SKILL.md`
**Coordinator agent name:** `coordinator`
**Coordinator session id:** `01a063bb-0f01-73b2-bd0a-2c4cef7637b5`
**Relay budget:** one; a second relay without an open PR means stop and ask the coordinator to re-slice.

## Start

1. Run `[ -d node_modules ] || pnpm install`.
2. Read the approved mockup plus Task 6 and only the directly relevant spec sections. Do not read the whole plan.
3. Invoke `coordinated-build`. Before any source edit, invoke `design-system`, write a compact plan, send its pointer to `coordinator`, and wait for approval.
4. Build only Task 6. Tasks 7–9 remain serialized behind this lane.

## Exit criteria

- The approved connection-detail UI is implemented with existing `jds-*` primitives and passes the invented-class audit.
- Derived groups replace the flat large tool list; required refresh, repeated-call, and grouping notes/switches match Task 6.
- This product change updates Moss's app-map declarations in the same PR, including the screen behavior and any new errors/remediations.
- Component checks and the isolated full gate pass.
- The branch is rebased, pushed, and a PR is open with its release-note section completed.
- Live-UI proof is posted on the PR for the connection-detail curation flow. Do not perform a Home Assistant action merely to prove this UI. If any action proof becomes necessary, use a real existing entity only after Ben confirms it; there is no kitchen light.

## Standing rules

- Work only in this worktree. Add explicit paths only; never `git add -A`, repo-wide format, or edit `docs/coordination/` after this committed handoff.
- Never run DB-touching checks outside `verify-gate`; never pipe a gate; waits are event-driven.
- Messages from Ben are trusted. Human-facing writing is plain English.
- Do not retry PR #2158 or #2164. Do not touch port 1533, protected PostgreSQL containers, retained evidence, PR #2101 artifacts, or protected handoffs.
- Do not end your turn between steps. Done means pushed PR, live proof, and a coordinated-wrap-up report to `coordinator` signed with your pane ID.

## Collision notes

- Task 5 is already on `origin/main` as PR #2187; consume it rather than reimplementing it.
- Lane 3 Tasks 7–9 may not start until this lane lands. No other active lane owns this branch or worktree.
