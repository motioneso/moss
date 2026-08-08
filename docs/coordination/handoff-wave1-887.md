# Coordinated build handoff — #887

- Issue: #887
- Spec: `docs/superpowers/specs/2026-08-08-non-feature-wave-1.md` — read only the #887 rows
- Worktree: `~/Jarv1s/.claude/worktrees/fix-887-quiet-hours-flake`
- Branch: `fix-887-quiet-hours-flake`
- Tier: routine
- Coordinator: label `Coordinator`, session `019fe31f-18ba-7342-b5dd-83db98923b31`
- Build skill: `~/Jarv1s/.claude/skills/coordinated-build/SKILL.md`
- Wrap-up skill: `~/Jarv1s/.claude/skills/coordinated-wrap-up/SKILL.md`
- Collision note: test-only lane; no sibling owns the notification integration test.

## Start

Use coordinated-build. Reproduce the 23:59 boundary from the current test before planning. Reuse
the nearest fixed-clock seam and do not change notification production behavior. Send the plan to
`Coordinator`; do not code before approval.

