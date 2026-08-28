# Build Handoff — #1319-A catalog verification

**Spec (approved):** `docs/superpowers/specs/2026-08-17-1319-signed-module-catalog.md`
**Plan (approved):** `docs/superpowers/plans/2026-08-18-1319-signed-module-catalog.md`
**GitHub issue:** #1319
**Risk tier:** security — adversarial Opus QA and Ben merge sign-off required
**Worktree:** `~/Jarv1s/.claude/worktrees/1319a-catalog-verify`
**Branch:** `build/1319a-catalog-verify` from green `origin/main` `4ee77dbd2`
**Coordinator:** registered name `coordinator`, pane label `Coordinator`, immutable Codex session
`01a02f0e-05d0-7e61-9a20-c87b7a7f9305`

## Start and exit

Install dependencies, invoke `coordinated-build`, and send a phase-2-only plan to the coordinator
before code. Then use TDD and `coordinated-wrap-up`; open a non-draft PR with exact-head evidence.
Never merge or touch the board or `docs/coordination/`.

## Collision and scope boundary

No collision outside the serial #1319 chain. Implement plan phase 2 only: fetch-time verification,
atomic snapshot/cache state, and response envelope. Do not begin phases 3-4 enforcement, override,
or UI work. No migration. #1319-B branches from main only after this PR merges.

