# Coordinated build handoff — #1412

- Issue: #1412
- Spec: `docs/superpowers/specs/2026-08-08-non-feature-wave-1.md` — read only the #1412 rows
- Worktree: `~/Jarv1s/.claude/worktrees/fix-1412-masthead-space`
- Branch: `fix-1412-masthead-space`
- Tier: routine
- Coordinator: label `Coordinator`, session `019fe31f-18ba-7342-b5dd-83db98923b31`
- Build skill: `~/Jarv1s/.claude/skills/coordinated-build/SKILL.md`
- Wrap-up skill: `~/Jarv1s/.claude/skills/coordinated-wrap-up/SKILL.md`
- Collision note: no sibling owns the shared Masthead component; this lane is user-facing and must
  carry live-path proof.

## Start

Use coordinated-build. Keep the production fix semantic and one-line; add only the smallest
accessible-text regression. The plan must include the required UAT trigger/live-path proof. Send
the plan to `Coordinator`; do not code before approval.

