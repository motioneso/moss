# Build Handoff — issue 2165 zero-table validator

**Approved scope:** issue #2165 and Fable verdict comment 5489845245
**GitHub issue:** #2165
**Risk tier:** `sensitive` — external module install validation
**Worktree:** `~/Jarv1s/.claude/worktrees/fix-2165-zero-table-validator`
**Branch:** `fix/2165-zero-table-validator` off `origin/main`
**Coordinator:** registered agent `coordinator`, immutable session
`01a05b9c-b63a-71e0-bb0e-491466e052c5`
**Build skill:** `~/Jarv1s/.claude/skills/coordinated-build/SKILL.md`

## Locked decision

Remove only the empty-array rejection in the owned-table validator, flip the existing empty-list
test, and add the smallest acceptance regression check. Downstream consumers already interpret an
empty list as no database access and remain fail-closed. Do not broaden validation behavior.

## Exit criteria

- Issue #2165 behavior and focused regression check are green.
- Full safe gate is green on an isolated gate database.
- PR is pushed and open with the Fable verdict linked.
- No live proof is required for this internal fix itself; PR #2101 owns the later real-UI re-proof.

## Collision and merge order

No file collision with issue #2166. Issue #2166 lands first to stabilize the full gate; rebase on
that main before final verification.

Follow `coordinated-build`, `plan-build`, and `coordinated-wrap-up`. Never touch
`docs/coordination/` beyond this committed handoff, never run a DB-touching gate outside
`verify-gate`, never use broad git staging or repo-wide formatting, and stop after one failed gate.
