# Build Handoff — 1521-keep-private-chat-closed-refetch

**Spec (approved):** docs/superpowers/specs/2026-08-10-1139-chat-export-ui-followups.md (read the
section for #1521 / "D" only)
**GitHub issue:** #1521
**Risk tier:** routine
**Worktree:** /home/ben/Jarv1s/.claude/worktrees/1521-keep-private-chat-closed-refetch
**Branch:** 1521-keep-private-chat-closed-refetch (off origin/main)
**Build skill path (absolute):** /home/ben/Jarv1s/.claude/skills/coordinated-build/SKILL.md
**Coordinator label:** `Coordinator` — verify `herdr pane list` shows EXACTLY ONE pane with this
label before messaging, resolved fresh (never a cached pane number).
**Coordinator session id:** `ff54b7d3-1ff0-4fad-94ce-b8fa9062a3ad`
**Relay trigger:** context-meter 70% warning, or a compaction summary in your own context →
message the coordinator, then use the `relay` skill immediately.

## Start

1. `[ -d node_modules ] || pnpm install`.
2. Read the spec above BY SECTION for #1521 only — never in full.
3. Invoke `coordinated-build` and follow it end-to-end: verify spec against your branch → plan
   with `plan-build` → coordinator approval → TDD build → `coordinated-wrap-up`.

## Exit criteria for this lane

- Spec exit criteria for #1521 met, full gate green on an isolated gate DB.
- PR open, rebased on origin/main.
- This touches private chat UI behavior (staying closed during a focus refetch) — it is
  user-facing. Live-path proof required: exercise it through the real UI on the live dev instance
  and post the evidence as a PR comment before calling this done.

## Run-specific bans (non-negotiable)

- Work ONLY in this worktree/branch; `git add` by explicit path.
- Never touch `docs/coordination/`, the project board, milestones, or merge.
- No secrets in any doc, payload, log, or prompt.

## Collision notes (from the coordinator)

- #1039 ("test: forceReplay vs purge behavior on private chat history") touches the same
  private-chat area and is queued to start after this lane lands.
- No collision with the active Workshop-feature lanes (#1752/#1755/#1756).
