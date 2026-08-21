# Run manifest: Workshop stage 1 (#1739)

Coordinator: Claude session `01d11bc2-ed28-440a-9f95-3bf53f0046c7`, label `Coordinator`, pane
`w1:pG0` (re-resolve pane fresh by label + session id — pane numbers reflow).

Plan: `docs/superpowers/plans/2026-08-20-1739-stage1-workshop.md` (committed on branch
`plan/1739-stage1-workshop`, worktree `.claude/worktrees/1739-stage1-plan` — plan-writing agent
already wrapped up, idle, reapable once its work is confirmed landed).

Spec: `docs/superpowers/specs/2026-08-19-moss-builds-modules-on-moss.md`.

Order: #1752 first (no dependency) -> #1753 -> #1754 serial. #1755 and #1756 (front-end shell)
run in parallel with any backend work; their data-wiring tasks come after #1753/#1754 land.

Note: GitHub's project board and issue-detail queries (GraphQL) hit the shared 5000/hr rate limit
at 2026-08-20 ~18:37 PDT (other sessions' usage, not this run's). Resets ~19:29 PDT. Basic issue
state checks used the REST API instead (not affected). Board status updates (moving cards) will
wait for GraphQL to reset; issue-close and merge via `gh pr merge`/`gh issue close` are REST and
unaffected.

## Queue

| Issue | Title | Tier | Status | Agent | Pane | Branch | PR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| #1752 | find modules that appear after the server started | routine | queued | - | - | - | - |
| #1753 | a draft module that runs for its author alone | routine | blocked on #1752 | - | - | - | - |
| #1754 | the build agent - agree a plan, then build it | sensitive (spawns a build agent/job) | blocked on #1752 | - | - | - | - |
| #1755 | the Workshop page (front end shell) | routine | queued | - | - | - | - |
| #1756 | plan/draft chat cards (front end shell) | routine | queued | - | - | - | - |

## Ready lane (from GitHub project 2, board query before rate limit)

Only #1252 confirmed by direct query before the limit hit (P0, bug: audit log records failed
external-module tool call as success). Full 29-item Ready list not yet pulled — GraphQL board
queries paused until reset (~19:29 PDT). Will re-pull and append here once available; do not
re-derive from memory.

## merges_since_relay: 0

## Continuation note

Spawning #1752 and the two front-end shells (#1755, #1756) now — all three have no unmet
dependency. #1753 and #1754 wait for #1752's PR to land. Once GraphQL resets, pull the full
Ready-lane list and start working down it after this wave is moving.
