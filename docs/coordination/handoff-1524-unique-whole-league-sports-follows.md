# Build Handoff — 1524-unique-whole-league-sports-follows

**Spec (approved):** docs/superpowers/specs/2026-08-10-1140-backend-low-followups.md (read the
section for #1524 / "B" only)
**GitHub issue:** #1524
**Risk tier:** sensitive (shared-table migration)
**Worktree:** /home/ben/Jarv1s/.claude/worktrees/1524-unique-whole-league-sports-follows
**Branch:** 1524-unique-whole-league-sports-follows (off origin/main)
**Build skill path (absolute):** /home/ben/Jarv1s/.claude/skills/coordinated-build/SKILL.md
**Coordinator label:** `Coordinator` — verify `herdr pane list` shows EXACTLY ONE pane with this
label before messaging, resolved fresh (never a cached pane number).
**Coordinator session id:** `ff54b7d3-1ff0-4fad-94ce-b8fa9062a3ad`
**Relay trigger:** context-meter 70% warning, or a compaction summary in your own context →
message the coordinator, then use the `relay` skill immediately.

## Start

1. `[ -d node_modules ] || pnpm install`.
2. Read the spec above BY SECTION for #1524 only — never in full.
3. Invoke `coordinated-build` and follow it end-to-end: verify spec against your branch → plan
   with `plan-build` → coordinator approval → TDD build → `coordinated-wrap-up`.

## Exit criteria for this lane

- Spec exit criteria for #1524 met, full gate green on an isolated gate DB.
- PR open, rebased on origin/main.
- This adds a migration (uniqueness on whole-league sports follows). **Tell the coordinator the
  migration number you land on before you merge** — two other lanes (#1572, #906) are queued
  behind this one specifically because they touch the same Sports settings/migration area, and the
  coordinator needs your landed number to sequence them correctly.
- User-facing (sports follows) — live-path proof required on the PR.

## Run-specific bans (non-negotiable)

- Work ONLY in this worktree/branch; `git add` by explicit path.
- Never touch `docs/coordination/`, the project board, milestones, or merge.
- No secrets in any doc, payload, log, or prompt.

## Collision notes (from the coordinator)

- **You are the head of a chain.** #1572 (Sports custom public news sources) and #906 (see
  more/less like this on News+Sports) are both held until you land — they touch the same Sports
  settings area and a shared-table migration. Land cleanly and report your migration number.
