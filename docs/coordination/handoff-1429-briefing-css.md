# Build Handoff — fix-1429-briefing-css

**Spec (approved, parent feature):** docs/superpowers/specs/2026-07-29-1327-briefing-action-rows.md
**GitHub issue:** #1429 — defect fix within #1327's already-approved design, split off by Ben's
2026-08-05 QA ruling (comment 5197873276 on PR #1379). Companion #1428 is separate, not this lane.
**Risk tier:** `routine` (isolated UI/CSS fix, no shared-table or cross-module change).
**Worktree:** /home/ben/Jarv1s/.claude/worktrees/fix-1429-briefing-css **Branch:** fix-1429-briefing-css (off origin/main, includes #1562's merged replay-contract work)
**Build skill path (absolute):** /home/ben/Jarv1s/.claude/worktrees/coord-overnight-20260810/.claude/skills/coordinated-build/SKILL.md
**Coordinator label:** `Coordinator` — escalate via `herdr-pane-message`; verify `herdr pane list`
shows exactly one pane with this label before messaging (resolve fresh, never a cached pane id).
**Coordinator session id:** `0bb9f516-c026-454f-bc97-dc9faf43bd20`
**Relay trigger:** context-meter 70% warning, or a compaction summary in your own context →
message the coordinator, then use the `relay` skill immediately.

## What #1429 actually requires (from the issue body — read it in full before planning)

1. `apps/web/src/today/briefing-action-rows.tsx:154-206` uses six CSS classes defined nowhere
   (`loose-row`, `loose-row__ic`, `loose-row__main`, `loose-row__title`, `loose-row__meta`,
   `loose-row__act`). Only `.loose` exists (kit-today-feeds.css:2). Section renders unstyled.
   **Must go through the design-system skill** (jds-* primitives, invented-class audit) — this
   defect is exactly what that audit catches.
2. `tests/e2e/briefing-action-rows.spec.ts` locates by those same class names — structurally
   incapable of catching missing styling. Rework so it asserts something a missing stylesheet
   would actually fail.
3. Live-path gate unmet: prior "all-six UAT green" does not transfer (force-push invalidated it,
   20 files differ from that head). Fresh live UI proof required after the CSS exists.
4. Same pass, non-blocking but in scope: dead `primaryAction` branch at :306 (PrimaryControl reads
   `row.sourceHref`, never consults it); inline `style={{…}}` at :132,154,161-169,176 bypassing the
   authored CSS layer; orphaned `today-suggested-email.tsx` still tracked at
   scripts/check-migrated-sections.ts:51.

## Start

1. `[ -d node_modules ] || pnpm install`.
2. Read #1429's full issue body (`gh issue view 1429`) and the design-system skill before touching
   any CSS. Read the parent spec BY SECTION for the action-row design only — not in full.
3. Invoke **`coordinated-build`**: plan with **`plan-build`** → coordinator approval (do NOT write
   code first) → TDD build → **`coordinated-wrap-up`** (PR + live-path proof + report).

## Exit criteria

- All 4 items above resolved; full gate green on an isolated gate DB.
- PR open, rebased on `origin/main`.
- Live-path proof posted (`gh pr comment`): the action rows rendered styled, live UI, screenshot.

## Run-specific bans (non-negotiable)

- Work ONLY in this worktree/branch; `git add` by explicit path only.
- Never touch `docs/coordination/`, the project board, milestones, or merge.
- No secrets in any doc, payload, log, or prompt.

## Collision notes

- None known — isolated to `apps/web/src/today/briefing-action-rows.tsx` and its CSS/test files.
  #1428 (companion issue) is out of scope for this lane; don't touch it.
