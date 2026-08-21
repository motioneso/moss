# Build Handoff — 1625-lane-scoped-module-fixture-identities

**Spec:** none on file — the GitHub issue body is a full scope statement for this test-harness
fix, not a new feature. Do not treat the absence of a spec file as a blocker; if it turns out to
need product decisions, stop and escalate to the coordinator.
**GitHub issue:** #1625
**Risk tier:** routine (test harness only)
**Worktree:** /home/ben/Jarv1s/.claude/worktrees/1625-lane-scoped-module-fixture-identities
**Branch:** 1625-lane-scoped-module-fixture-identities (off origin/main)
**Build skill path (absolute):** /home/ben/Jarv1s/.claude/skills/coordinated-build/SKILL.md
**Coordinator label:** `Coordinator` — verify `herdr pane list` shows EXACTLY ONE pane with this
label before messaging, resolved fresh (never a cached pane number).
**Coordinator session id:** `ff54b7d3-1ff0-4fad-94ce-b8fa9062a3ad`
**Relay trigger:** context-meter 70% warning, or a compaction summary in your own context →
message the coordinator, then use the `relay` skill immediately.

## Start

1. `[ -d node_modules ] || pnpm install`.
2. Read GitHub issue #1625 in full — it is your spec for this lane.
3. Invoke `coordinated-build` and follow it end-to-end: plan with `plan-build` → coordinator
   approval → TDD build → `coordinated-wrap-up`.

## Exit criteria for this lane

- Concurrent integration gates use lane-scoped module fixture identities as described in the
  issue; the flakiness/collision this fixes is demonstrated gone.
- PR open, rebased on origin/main.
- Test-only change, not user-facing — live-path gate does not apply; say so in your wrap-up.

## Run-specific bans (non-negotiable)

- Work ONLY in this worktree/branch; `git add` by explicit path.
- Never touch `docs/coordination/`, the project board, milestones, or merge.
- No secrets in any doc, payload, log, or prompt.

## Collision notes (from the coordinator)

- This touches module fixture identities also used by the Workshop feature's own integration
  gates (#1752/#1753/#1754 lanes). Low risk — it's the test harness's fixture identity scheme, not
  the module registry itself — but if you find yourself editing files inside
  `.claude/worktrees/1752-module-discovery-holder` or its module-registry source, stop and check
  with the coordinator before proceeding; that area is actively being edited by another lane.
