# Build Handoff — 1526-pty-socket-backpressure

**Spec (approved):** docs/superpowers/specs/2026-08-10-1140-backend-low-followups.md (read the
section for #1526 / "D" only)
**GitHub issue:** #1526
**Risk tier:** sensitive (terminal/CLI runner path)
**Worktree:** /home/ben/Jarv1s/.claude/worktrees/1526-pty-socket-backpressure
**Branch:** 1526-pty-socket-backpressure (off origin/main)
**Build skill path (absolute):** /home/ben/Jarv1s/.claude/skills/coordinated-build/SKILL.md
**Coordinator label:** `Coordinator` — verify `herdr pane list` shows EXACTLY ONE pane with this
label before messaging, resolved fresh (never a cached pane number).
**Coordinator session id:** `ff54b7d3-1ff0-4fad-94ce-b8fa9062a3ad`
**Relay trigger:** context-meter 70% warning, or a compaction summary in your own context →
message the coordinator, then use the `relay` skill immediately.

## Start

1. `[ -d node_modules ] || pnpm install`.
2. Read the spec above BY SECTION for #1526 only — never in full.
3. Invoke `coordinated-build` and follow it end-to-end: verify spec against your branch → plan
   with `plan-build` → coordinator approval → TDD build → `coordinated-wrap-up`.

## Exit criteria for this lane

- Spec exit criteria for #1526 met, full gate green on an isolated gate DB.
- PR open, rebased on origin/main.
- Sensitive tier: this needs the matched e2e-UAT gate, not just unit coverage — propagating
  terminal backpressure correctly is exactly the kind of thing that looks right under a mock and
  breaks under real load. If it's exercised through a real terminal session in the UI, that also
  satisfies the live-path proof; state clearly what you actually ran.

## Run-specific bans (non-negotiable)

- Work ONLY in this worktree/branch; `git add` by explicit path.
- Never touch `docs/coordination/`, the project board, milestones, or merge.
- No secrets in any doc, payload, log, or prompt.

## Collision notes (from the coordinator)

- No collision identified with other active lanes — this is isolated to the terminal/PTY path.
