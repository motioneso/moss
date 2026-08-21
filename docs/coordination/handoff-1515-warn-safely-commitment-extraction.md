# Build Handoff — 1515-warn-safely-commitment-extraction

**Spec (approved):** docs/superpowers/specs/2026-08-10-1137-robustness-followups.md (read the
section for #1515 / "C2" only)
**GitHub issue:** #1515
**Risk tier:** routine
**Worktree:** /home/ben/Jarv1s/.claude/worktrees/1515-warn-safely-commitment-extraction
**Branch:** 1515-warn-safely-commitment-extraction (off origin/main)
**Build skill path (absolute):** /home/ben/Jarv1s/.claude/skills/coordinated-build/SKILL.md
**Coordinator label:** `Coordinator` — verify `herdr pane list` shows EXACTLY ONE pane with this
label before messaging, resolved fresh (never a cached pane number).
**Coordinator session id:** `ff54b7d3-1ff0-4fad-94ce-b8fa9062a3ad`
**Relay trigger:** context-meter 70% warning, or a compaction summary in your own context →
message the coordinator, then use the `relay` skill immediately.

## Start

1. `[ -d node_modules ] || pnpm install`.
2. Read the spec above BY SECTION for #1515 only — never in full.
3. Invoke `coordinated-build` and follow it end-to-end: verify spec against your branch → plan
   with `plan-build` → coordinator approval → TDD build → `coordinated-wrap-up`.

## Exit criteria for this lane

- Spec exit criteria for #1515 met, full gate green on an isolated gate DB.
- PR open, rebased on origin/main.
- This is a backend safety-handling fix (warn safely on commitment extraction failures) — likely
  not a user-facing UI surface. If it is not user-facing, the live-path gate does not apply; state
  that explicitly in your wrap-up report rather than skipping the question.

## Run-specific bans (non-negotiable)

- Work ONLY in this worktree/branch; `git add` by explicit path.
- Never touch `docs/coordination/`, the project board, milestones, or merge.
- No secrets in any doc, payload, log, or prompt.

## Collision notes (from the coordinator)

- #1517 ("[1137-C4] Escape commitment evidence excerpts as plain text") touches the same
  commitment-handling files and is queued to start after this lane lands — land and merge cleanly,
  don't leave loose ends for it to rebase around.
- No collision with the active Workshop-feature lanes (#1752/#1755/#1756).
