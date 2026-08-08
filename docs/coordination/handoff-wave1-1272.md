# Coordinated build handoff — #1272

- Issue: #1272
- Spec: `docs/superpowers/specs/2026-08-08-non-feature-wave-1.md` — read only the #1272 rows
- Worktree: `~/Jarv1s/.claude/worktrees/test-1272-structured-state-migrations`
- Branch: `test-1272-structured-state-migrations`
- Tier: routine
- Coordinator: label `Coordinator`, session `019fe31f-18ba-7342-b5dd-83db98923b31`
- Build skill: `~/Jarv1s/.claude/skills/coordinated-build/SKILL.md`
- Wrap-up skill: `~/Jarv1s/.claude/skills/coordinated-wrap-up/SKILL.md`
- Collision note: test-only; do not edit migration SQL or the manifest unless grounding proves the
  current lists already drifted.

## Start

Use coordinated-build. Reuse the smallest existing manifest/SQL parity-test pattern; do not create
a generic helper. Send the plan to `Coordinator`; do not code before approval.

