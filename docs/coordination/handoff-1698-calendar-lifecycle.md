# Build Handoff — 1698-calendar-lifecycle

**Spec (approved):** docs/superpowers/specs/2026-08-19-1693-calendar-event-lifecycle.md
**GitHub issue:** #1698
**Risk tier:** `sensitive` (calendar write paths, cross-provider sync — shared-table/cross-module
writes, per coordinate skill Risk tiering). Matched e2e-UAT required; per-merge digest to Ben, no
Ben sign-off gate (that's security-tier only) but the live-path gate still applies in full.
**Worktree:** ~/Jarv1s/.claude/worktrees/1698-calendar-lifecycle **Branch:** 1698-calendar-lifecycle (off origin/main)
**Build skill path (absolute):** ~/Jarv1s/.claude/skills/coordinated-build/SKILL.md
**Coordinator label:** `Coordinator` — escalate via `herdr-pane-message`; before messaging, verify
`herdr pane list` shows EXACTLY ONE pane with this label, resolved fresh each time.
**Coordinator session id:** bb90dd87-5f0e-440d-8fba-9e1acdff6fc8
**Relay trigger:** the context-meter 70% warning, or a compaction summary in your own context →
message the coordinator, then use the `relay` skill immediately.

## Start

1. `[ -d node_modules ] || pnpm install`.
2. Read the spec above BY SECTION for your current task only — never in full.
3. Invoke **`coordinated-build`**: verify the spec against your actual branch → plan with
   **`plan-build`** → coordinator approval (do NOT write code before it) → TDD build →
   **`coordinated-wrap-up`** (PR + live-path proof + report).

## Exit criteria for this lane

- Spec Exit Criteria met (see spec's "Exit Criteria" section — provenance tests, confirmation-policy
  matrix, extensibility test for the guest field, privacy tests, data-handling tests, vocabulary
  tests, and the live acceptance run described there), full gate green on an isolated gate DB.
- PR open, rebased on `origin/main`.
- **Live-path proof posted, mandatory:** create/move/delete a Moss-created event AND a
  user-created event through the real Chat UI on a live dev instance against a real connected
  Google account, posted as a `gh pr comment` with the run, exit code, and evidence. No live-path
  proof → report **code-complete, unverified**, do not claim done.

## Run-specific bans (non-negotiable)

- Work ONLY in this worktree/branch; `git add` by explicit path — never `git add -A` or repo-wide
  `pnpm format`.
- Never touch `docs/coordination/` (coordinator-only), the project board, milestones, or merge.
- No secrets in any doc, payload, log, or prompt. Google connector tokens especially — this spec
  touches live calendar write paths.

## Collision notes (from the coordinator)

- No other active lane touches `packages/calendar/*`, `packages/chat/src/calendar-write-impl.ts`,
  or `packages/ai/src/gateway/gateway.ts` as of 2026-08-19. spec-926-fable-review (pane w1:pFX,
  food/nutrition tracking) is unrelated — no shared modules.
- The spec's "Vocabulary" fix (removing "focus block"-only framing from tool descriptions) touches
  `packages/calendar/src/manifest.ts` tool descriptions — this is the only file overlap risk with
  future calendar work; none active right now.
- Do NOT add backend support for `MOSS_DB_HOST`/`MOSS_DB_NAME`/`MOSS_DB_PASSWORD` env vars if you
  encounter that unrelated docs thread — it's being handled separately (agy agent, pane w1:pF7).
