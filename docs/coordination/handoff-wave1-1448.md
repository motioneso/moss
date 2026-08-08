# Coordinated build handoff — #1448

- Issue: #1448
- Spec: `docs/superpowers/specs/2026-08-08-non-feature-wave-1.md` — read only the #1448 rows
- Worktree: `~/Jarv1s/.claude/worktrees/fix-1448-news-vitest-alias`
- Branch: `fix-1448-news-vitest-alias`
- Tier: routine
- Coordinator: label `Coordinator`, session `019fe31f-18ba-7342-b5dd-83db98923b31`
- Build skill: `~/Jarv1s/.claude/skills/coordinated-build/SKILL.md`
- Wrap-up skill: `~/Jarv1s/.claude/skills/coordinated-wrap-up/SKILL.md`
- Collision note: no other Wave 1 lane owns `vitest.config.ts` or the focused alias regression.

## Start

Use coordinated-build. Ground the renamed `@moss/news/web` entry and existing package export before
planning. Keep the fix to the specific alias plus one regression. Send the plan to `Coordinator`
for approval; do not code before that approval.

