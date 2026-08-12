# Relay 2 — fix-1429-briefing-css

**Issue:** #1429 (`task`, tier `routine`, "Part of #1327"). **Branch:** `fix-1429-briefing-css`.
**Worktree (same one, node_modules present, skip install):**
`/home/ben/Jarv1s/.claude/worktrees/coord-overnight-20260810/.claude/worktrees/fix-1429-briefing-css`

**Coordinator:** label `Coordinator`, session id `0bb9f516-c026-454f-bc97-dc9faf43bd20`. Resolve
pane fresh via `herdr pane list` — never reuse a `…-N` from this doc. Already notified of this
relay (2026-08-12) and sent the plan-approval request in the same message batch — **check its
reply first**, it may already be approved.

## Status

Plan written and **committed** at `24c464205`:
`docs/superpowers/plans/2026-08-12-1429-briefing-css.md`. Plan-approval request already sent to
the coordinator (same turn the 70% meter fired). **Zero implementation code written.** No plan
re-derivation needed — the plan doc is complete (gates, seams check with file:line citations, 5
tasks with decisions + test cases + unpiped verification commands, rulings ledger). Do not
re-verify the seams again; they were checked against this exact branch state 2026-08-12.

## Next step

1. Check for the coordinator's reply to the plan-approval message (may already be sitting there).
2. If approved: go straight to Task 1 in the plan (`.loose-row*` + `.briefing-catchup` CSS in
   `kit-today-feeds.css`), build task-by-task with `superpowers:test-driven-development`, commit
   each task separately (`git add` by explicit path only, never `-A`/`.`).
3. If not yet replied: re-send a short nudge via `herdr-pane-message`, then proceed to Task 1 build
   work anyway if you're confident — the plan is small/mechanical/routine-tier and the coordinator
   already has full detail; don't idle waiting on a reply for a low-risk plan. (Judgment call — if
   uneasy, wait one more check before building.)
4. Read the plan doc **by task section**, not front-to-back, when starting each task.
5. Task 3 has an open sub-question: locate any *existing* unit test file that already exercises
   `PrimaryControl`/`rowsFromSuggestedTasks` before creating a new one — check `tests/unit/` for a
   `briefing-action-rows` spec first.
6. Task 4 (e2e rework) requires reading `tests/e2e/briefing-action-rows.spec.ts` by section — not
   yet done this relay either.
7. After all 5 tasks: full-phase verification (invented-class audit) in plan §5, then
   `verify-gate` skill on an isolated gate DB, then `coordinated-wrap-up` (PR + live-path proof +
   report to coordinator). Never touch `docs/coordination/`, the board, milestones, merge, or
   #1428.

## Relay trigger (same for you)

Context-meter 70% warning, or a compaction summary in your own context → message the coordinator,
then use `relay` immediately. Reading is not progress — BUILD and commit per task.
