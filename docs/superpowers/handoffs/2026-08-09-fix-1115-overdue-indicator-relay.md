# Relay — #1115 one overdue indicator

**Spec:** `docs/superpowers/specs/2026-08-08-non-feature-wave-2.md` (row #1115)
**Plan:** `docs/superpowers/plans/2026-08-09-fix-1115-overdue-indicator.md`
**Worktree/branch:** `/home/ben/Jarv1s/.claude/worktrees/fix-1115-overdue-indicator`, branch
`fix-1115-overdue-indicator`
**Coordinator:** Herdr label `Coordinator` (pane resolves fresh via `herdr pane list` — do not
reuse a cached pane id), session id `f6461c25-9951-432c-9535-6fb497a92751`. Relay trigger for this
lane: the context-meter 70% warning, same as everyone.

## Done

Build phase is complete and committed — `f9ac8fe24` on this branch, tree clean:

```
fix(#1115): suppress icon/text overdue badge when the drift pill already shows it
```

Touches exactly two files (verified via `git show --name-only HEAD`):
- `apps/web/src/tasks/task-list-view.tsx` — added `showBadge: boolean` to `DueInfo`, set in all
  three `dueInfo()` branches (`false` only when a non-done task is overdue, since the drift pill
  renders "Overdue" there too), gated the icon/text badge JSX on `due?.showBadge` instead of `due`.
- `tests/unit/web-day-classification-timezone.test.ts` — added `describe("#1115 ...")` with 3
  cases. TDD confirmed: red before the fix (`3 failed | 5 passed (8)`, `showBadge` undefined),
  green after (`8 passed (8)`).

Correct test invocation (confirmed working): `pnpm exec vitest run
tests/unit/web-day-classification-timezone.test.ts` from the worktree root — NOT
`pnpm --filter @moss/web exec vitest run ../../...` (that pattern doesn't resolve, fails with "No
test files found").

Plan's seams check, design decision, and kill gate are all in the plan doc linked above — read that
by section if you need the "why", not this doc.

## Left — entirely `coordinated-wrap-up`

1. Full gate on an **isolated gate DB** — use the `verify-gate` skill, never run
   `pnpm verify:foundation` raw (CLAUDE.md hard rule).
2. Pre-push trio + rebase:
   ```bash
   pnpm format:check && pnpm lint && pnpm typecheck
   git fetch origin main && git rebase origin/main
   ```
3. Push branch, open PR (`fix(#1115): ...`, reference the issue).
4. **Live-path proof — the part most likely to get skipped.** This touches a live UI surface with
   no mapped UAT spec. Exercise `/tasks` on a live dev instance with a non-done overdue task,
   live DOM assertion showing exactly **one** overdue indicator (not badge + pill both), post via
   `gh pr comment`. Also assert a done-overdue task still has the badge as its sole indicator
   (kill-gate condition in the plan). Without this proof the honest status is
   "code-complete, unverified" — say that plainly rather than "done" if you can't produce it.
5. Report the PR + evidence to the coordinator, then stop. Merge/board/close are the coordinator's.

## In-flight note

Earlier in this lane's history I briefly mis-edited `/home/ben/Jarv1s/tests/unit/...` (the shared
main tree, missing the worktree path segment) — caught and reverted via `shared-checkout` skill
before it touched anything else. No residue; the worktree tree is clean and this doc's "Done"
section above is the authoritative state. Not actionable, just context if `git log` on the main
tree looks odd to you later.
