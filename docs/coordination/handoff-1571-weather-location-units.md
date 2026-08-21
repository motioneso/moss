# Build Handoff — 1571-weather-location-and-units

**Spec (approved):** docs/superpowers/specs/2026-08-17-1571-weather-location-and-units.md
**GitHub issue:** #1571
**Risk tier:** routine (no migration, reuses existing owner-scoped preferences and Weather
service; UI-facing so the live-path gate still applies in full)
**Worktree:** ~/Jarv1s/.claude/worktrees/1571-weather-location-units **Branch:**
1571-weather-location-units (off origin/main)
**Build skill path (absolute):** ~/Jarv1s/.claude/skills/coordinated-build/SKILL.md
**Coordinator agent name:** `coordinator` — escalate via `herdr agent prompt coordinator`; verify
`herdr agent list` shows EXACTLY ONE live agent with this name before messaging. Pane label is
also `Coordinator`.
**Coordinator session id:** cac2ffa0-60bb-407c-9f3a-1a5fb19d6a9b
**Relay trigger:** the context-meter 70% warning, or a compaction summary in your own context →
message the coordinator, then use the `relay` skill immediately.

## Start

1. `[ -d node_modules ] || pnpm install`
2. Read the spec above BY SECTION for your current task only — never in full.
3. Invoke **`coordinated-build`** and follow it end-to-end: verify the spec against your actual
   branch → plan with **`plan-build`** → coordinator approval (do NOT write code before it) → TDD
   build → **`coordinated-wrap-up`** (PR + live-path proof + report).

## Exit criteria for this lane

- Spec Exit Criteria met, full gate green on an isolated gate DB.
- PR open, rebased on origin/main.
- **Live-path proof posted** (this is user-facing settings + Today UI): the spec's own primary
  acceptance test on a live dev instance — save a real place, see Today update, change place, see
  it update again, an ambiguous query ("Springfield") showing candidates with nothing saved until
  chosen, and both F/C unit states changing displayed temperatures. Post as a `gh pr comment` with
  the run and evidence. Cannot produce it? Report code-complete, unverified — never "done".

## Run-specific bans (non-negotiable)

- Work ONLY in this worktree/branch; `git add` by explicit path — never `git add -A` or repo-wide
  `pnpm format`.
- Never touch `docs/coordination/` (coordinator-only), the project board, milestones, or merge.
- No secrets in any doc, payload, log, or prompt.
- Do not add a new weather/geocoding provider or a new database migration — the spec's
  Implementation Decisions say none is needed; if you find yourself reaching for either, stop and
  escalate to the coordinator instead of proceeding.

## Collision notes (from the coordinator)

- None known. This touches Settings (owner-scoped preferences) and Weather (Open-Meteo client,
  Today route) only — no other lane in this run touches either module right now.
