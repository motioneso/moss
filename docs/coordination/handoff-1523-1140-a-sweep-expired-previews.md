# Build Handoff — 1140-a-sweep-expired-previews

**Spec (approved):** docs/superpowers/specs/2026-08-10-1140-backend-low-followups.md — read only
the "1140-A: sweep expired news previews" section (~line 71-99).
**GitHub issue:** #1523
**Risk tier:** `routine` (spec says explicitly: "Tier: routine").
**Worktree:** .claude/worktrees/1140-a-sweep-expired-previews **Branch:** 1140-a-sweep-expired-previews (off origin/main)
**Build skill path (absolute):** /home/ben/Jarv1s/.claude/skills/coordinated-build/SKILL.md
**Coordinator label:** `Coordinator` — escalate via `herdr-pane-message`; verify `herdr pane list`
shows EXACTLY ONE pane with this label, resolved fresh (never a cached pane number).
**Coordinator session id:** `11cf8264-55a8-4fa4-b32b-c8d086469f74`
**Relay trigger:** context-meter 70% warning, or a compaction summary in your own context →
message the coordinator, then use the `relay` skill immediately.

## Start

1. `[ -d node_modules ] || pnpm install`.
2. Read the spec section named above only — never the full spec file.
3. Invoke **`coordinated-build`**: verify spec against your branch → plan with **`plan-build`** →
   coordinator approval before writing code → TDD build → **`coordinated-wrap-up`** (PR + live-path
   proof + report).

## Dependency gate (already verified clear by the coordinator before spawn)

Spec text: "parallel-ready: 1140-A, 1140-B, 1140-C, 1140-E" — no blocking dependency. Clear to build.

## Exit criteria for this lane

- Spec's "Focused acceptance" section for 1140-A satisfied.
- Full gate green on an isolated gate DB.
- PR open, rebased on origin/main. Confirm with the spec whether this is user-visible (news
  preview sweep sounds backend-only/cron-adjacent) — if not user-facing, say so explicitly per
  CLAUDE.md release-note rule instead of skipping live-path proof silently.

## Run-specific bans (non-negotiable)

- Work ONLY in this worktree/branch; `git add` by explicit path — never `git add -A` or repo-wide
  `pnpm format`.
- Never touch `docs/coordination/` (coordinator-only), the project board, milestones, or merge.
- No secrets in any doc, payload, log, or prompt.

## Collision notes (from the coordinator)

- Three other lanes building in parallel this wave, all chat/Settings UI work (#1518, #1519,
  #1522) — unrelated module, no known overlap. Note: this spec's sibling child **1140-B is
  sensitive-migration tier** and **1140-F is security tier** — neither is in this wave, but if you
  see a migration file appear unexpectedly, stop and check with the coordinator (migration numbers
  are assigned by landing order, never assume one).
