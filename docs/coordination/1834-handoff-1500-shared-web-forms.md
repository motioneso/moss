# Handoff: #1500 — shared web form visuals into @moss/ui

Spec: `docs/superpowers/specs/2026-08-10-css-guard-residue.md` — child D.
Issue: #1500. Tier: routine. Worktree: `.claude/worktrees/1500-shared-web-forms`.
Branch: `1500-shared-web-forms`.

Coordinator: pane w1:pMV, agent name `coordinator`, session
7b8957b3-93f9-44ee-81cc-a6a436514031.

Order in the chain: child 4 of 7 (#1498 → #1499 → #1500 → #1501 → #1502 → #1503).
#1499 already merged. You are next. #1501 is waiting on you.

Explicitly inspect equal-specificity rules in later package sheets before moving
anything — if a moved rule's computed value would flip because of specificity or
ordering, use the approved narrower-import escape hatch (see the spec) rather than
force-inlining or reordering broadly.

Follow `coordinated-build` end to end: plan → my approval → build → PR →
`coordinated-wrap-up`. Owned scope and acceptance = Child D in the approved spec. Do not
absorb sibling cleanup (#1501-#1503) — stay in scope.

Do not touch `docs/coordination/` (coordinator-only) or run repo-wide `pnpm format` /
broad `git add`. Read the spec by section for your current task only.

Live-path proof must cover both desktop and mobile widths, in light and dark mode
(spec line ~178-179) — not just one axis. #1499's proof initially missed the mobile
pass and had to be added after the fact; don't repeat that.
