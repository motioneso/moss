# Coordinated build handoff — #903

- Issue: #903
- Spec: `docs/superpowers/specs/2026-08-08-non-feature-wave-1.md` — read only the #903 rows
- Worktree: `~/Jarv1s/.claude/worktrees/fix-903-sports-tiebreak`
- Branch: `fix-903-sports-tiebreak`
- Tier: routine
- Coordinator: label `Coordinator`, session `019fe31f-18ba-7342-b5dd-83db98923b31`
- Build skill: `~/Jarv1s/.claude/skills/coordinated-build/SKILL.md`
- Wrap-up skill: `~/Jarv1s/.claude/skills/coordinated-wrap-up/SKILL.md`
- Collision note: no sibling owns Sports follow grouping/repository files; keep the existing
  `DataContextDb` boundary. User-visible selection requires live-path proof.

## Start

Use coordinated-build. Trace repository ordering through `selectPrimaryFollow`, then plan one
stable ID tie-break, matching database order, focused regression, and required UAT proof. Send the
plan to `Coordinator`; do not code before approval.

