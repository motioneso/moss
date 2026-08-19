# Build Handoff — #1560 assistant-name loading flash

**Approved task:** issue #1560 (problem, known sites, expected behavior, and regression-test shape)
**GitHub issue:** #1560
**Risk tier:** routine (small UI copy/loading-state correction)
**Worktree:** `~/Jarv1s/.claude/worktrees/1560-assistant-name-flash`
**Branch:** `fix/1560-assistant-name-flash` from current `origin/main`
**Build skill path:** `~/Jarv1s/.claude/skills/coordinated-build/SKILL.md`
**Coordinator label:** `Coordinator`
**Coordinator session id:** `019fef6b-8f40-7453-a6f9-4c3e245dce52`

## Scope

Use neutral pending copy while persona/assistant-name loading is unresolved at the two issue-named
evening-card sites. Preserve the configured assistant name after resolution. Add the smallest
regression assertion that holds loading pending and proves the default name never renders.

Read and follow the repository design-system skill before any UI edit. Reuse the current assistant
name/loading contract; do not add an abstraction, dependency, or new loading system.

## Exit criteria

- Issue #1560 acceptance met with a failing-before/passing-after regression check.
- Relevant UI/unit checks and formatting pass.
- Live-path proof on a real dev instance records that pending copy is neutral and the configured
  name appears after load; no screenshot needs to enter coordinator context.
- Draft PR opened and reported; do not merge.

## Collision notes

- Independent of #1557, #1533, #1564, and #1121.
- Own only the minimal Today/evening files and one focused test.
- Never touch `docs/coordination/`, project fields, milestones, or merge state.
