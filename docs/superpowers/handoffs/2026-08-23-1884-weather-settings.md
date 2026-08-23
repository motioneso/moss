# Build Handoff — #1884 Weather settings

**Spec (approved):** `~/Jarv1s/docs/superpowers/specs/2026-08-23-1884-weather-settings-card.md`
**GitHub issue:** #1884
**Risk tier:** routine — live authenticated UI proof required
**Worktree:** `~/Jarv1s/.claude/worktrees/1884-weather-settings`
**Branch:** `build/1884-weather-settings` from green `origin/main` `4ee77dbd2`
**Coordinator:** registered name `coordinator`, pane label `Coordinator`, immutable Codex session
`01a02f0e-05d0-7e61-9a20-c87b7a7f9305`

## Start and exit

Install dependencies, invoke `coordinated-build`, run the design-system check before markup, and
send a plan to the coordinator before code. Then use TDD and `coordinated-wrap-up`; open a non-draft
PR and post durable live proof. Never merge or touch the board or `docs/coordination/`.

## Collision and UI boundary

No source or migration collision with this run. Keep one Weather card. The binary unit toggle shows
only its active letter (`C` or `F`), not a two-option segmented control. Reuse JDS control vocabulary
and preserve the existing metric/imperial API, location behavior, and Today invalidation.

