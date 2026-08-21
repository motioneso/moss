# Build Handoff — 1039-forcereplay-vs-purge-coverage

**Spec (approved):** no separate spec file — the GitHub issue body is the full scope (test-only
follow-up from #984's QA pass). Treat the issue body as the spec.
**GitHub issue:** #1039
**Risk tier:** routine (test-only, no production code path changes expected)
**Worktree:** /home/ben/Jarv1s/.claude/worktrees/1039-forcereplay-vs-purge-coverage **Branch:** 1039-forcereplay-vs-purge-coverage
**Build skill path (absolute):** /home/ben/Jarv1s/.claude/skills/coordinated-build/SKILL.md (follow this
exact file if `coordinated-build` does not resolve by name in your spawn env)
**Coordinator agent name:** `coordinator` — escalate via `herdr agent prompt coordinator` (through
`herdr-pane-message`); before messaging, verify `herdr agent list` shows EXACTLY ONE live agent
with this name, resolved fresh each time. The visible pane label should also be `Coordinator`.
**Coordinator session id:** 9674b6c7-87b1-4612-afad-361c7f9070fa (immutable authority; label is only routing).
**Relay trigger:** the context-meter 70% warning, or a compaction summary in your own context →
message the coordinator, then use the `relay` skill immediately.

## Start

1. `[ -d node_modules ] || pnpm install` (worktrees share the pnpm store; relay successors skip).
2. Read `gh issue view 1039` for the full scope — it's short, that's the point.
3. Invoke **`coordinated-build`** and follow it end-to-end: plan with **`plan-build`** →
   coordinator approval (do NOT write code before it) → TDD build → **`coordinated-wrap-up`**
   (PR + report).

## Exit criteria for this lane

- Test coverage added that distinguishes forceReplay (re-render from retained history) from purge
  (history removed) so the two code paths can't silently converge, per issue #1039 and its parent
  #984.
- Full gate green on an isolated gate DB.
- PR open, rebased on `origin/main`.
- Test-only change — no live-path UI proof required unless you find yourself changing production
  code to make the distinction testable; if that happens, stop and ask the coordinator.

## Run-specific bans (non-negotiable)

- Work ONLY in this worktree/branch; `git add` by explicit path — never `git add -A` or repo-wide
  `pnpm format`.
- Never touch `docs/coordination/` (coordinator-only), the project board, milestones, or merge.
- No secrets in any doc, payload, log, or prompt.

## Collision notes (from the coordinator)

- #1521 (the private-chat lane this depended on) already merged — you're building on top of it,
  no coordination needed with a live lane.
