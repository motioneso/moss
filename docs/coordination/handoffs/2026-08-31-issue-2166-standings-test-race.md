# Build Handoff — issue 2166 standings test race

**Approved scope:** issue #2166 and Fable verdict comment 5489854528
**GitHub issue:** #2166
**Risk tier:** `routine` — test-only stabilization
**Worktree:** `~/Jarv1s/.claude/worktrees/fix-2166-standings-test-race`
**Branch:** `fix/2166-standings-test-race` off `origin/main`
**Coordinator:** registered agent `coordinator`, immutable session
`01a05b9c-b63a-71e0-bb0e-491466e052c5`
**Build skill:** `~/Jarv1s/.claude/skills/coordinated-build/SKILL.md`

## Locked decision

This is a test race, not a production regression or stale expectation. Apply only the Fable
verdict: set `staleTime: Infinity` on the test query clients and assert the relevant fetch occurs
once. Do not edit production Sports behavior.

## Exit criteria

- The focused standings-picker test is green and proves one fetch.
- Full safe gate is green on an isolated gate database.
- PR is pushed and open with the Fable verdict linked; no live-path proof applies to a test-only PR.

## Collision and merge order

No file collision with issue #2165. This PR lands first, then issue #2165 and PR #2164 rebase on
the stabilized main before their one fresh full gate.

Follow `coordinated-build`, `plan-build`, and `coordinated-wrap-up`. Never touch
`docs/coordination/` beyond this committed handoff, never run a DB-touching gate outside
`verify-gate`, never use broad git staging or repo-wide formatting, and stop after one failed gate.
