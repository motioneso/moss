# Relay — w3b-audit-truth (#1055)

**Spec:** `docs/superpowers/specs/2026-08-09-wave-3-action-audit-truth.md` (Lane B)
**Plan (approved by Fable, no re-approval needed):**
`docs/superpowers/plans/2026-08-09-tasks-create-idempotency-owner-scope.md` — read its
"STATE AS OF THIS CHECKPOINT" section first, it's the ground truth.
**Branch/worktree:** `w3b-audit-truth`, this worktree. No commits made yet this lane.
**Coordinator label:** `Coordinator` (herdr) — already notified of this relay.

## What's actually true right now (verified via git status/grep, not assumed)

- No code or test changes exist on disk yet for #1055. `packages/tasks/src/repository.ts` is
  unmodified. `tests/integration/tasks.test.ts` has zero uncommitted changes.
- `docs/superpowers/plans/2026-08-09-tasks-create-idempotency-owner-scope.md` is new/untracked —
  not yet committed (do that as your first action, `git add` scoped to that one file).
- A fresh-worktree gotcha was found and fixed: integration tests need `pnpm build:app-map` run
  once before any vitest integration run in this worktree, else the whole file silently reports as
  "skipped" instead of failing (missing `dist/app-map.json`). Already run once — should persist for
  this worktree's lifetime.
- Gate DB `jarvis_gate_w3b_1055` already exists (created via docker exec psql), ready to use.

## What's left (in order)

1. Commit the plan doc (`git add docs/superpowers/plans/2026-08-09-tasks-create-idempotency-owner-scope.md`, own commit or bundle with Task 1).
2. TDD Task 1 — write the cross-owner regression test (exact code in the plan doc), run it against
   unmodified `repository.ts`, confirm it fails for the right reason (RLS owner-or-share lets B see
   A's shared row). Use `export JARVIS_PGDATABASE=jarvis_gate_w3b_1055 && pnpm test:tasks -t
   "cross-owner shared task"` (no extra `--`). Commit test file alone.
3. TDD Task 2 — apply the one-line `.where(...)` fix + corrected comment (exact code in plan doc,
   includes Fable's required `tasks_source_external_key_idx` citation) to
   `packages/tasks/src/repository.ts`. Re-run, confirm green. Commit repository.ts alone.
4. Task 3 — full `tests/integration/tasks.test.ts` green (no regression on the pre-existing
   same-owner idempotency test at ~line 781).
5. Pre-push trio (`pnpm format:check && pnpm lint && pnpm typecheck`), rebase on `origin/main`.
6. `coordinated-wrap-up`: full gate on the isolated DB (its own recipe, don't reuse this doc's
   gate-DB steps blindly — check the skill), push, open PR (no live-path proof needed — backend
   only, spec's Process Gates section confirms lanes B/C are internal).
7. DROP `jarvis_gate_w3b_1055` when fully done with it.
8. Report PR to Coordinator via `herdr-pane-message` (resolve the `Coordinator` label fresh, don't
   reuse any pane_id from this doc). Do not merge, move board, or close the issue.

## Bans still in force

Work only in this worktree/branch. `git add` by explicit path only, never `-A`. Never touch
`docs/coordination/`, the board, milestones, or merge. No secrets in any doc/payload/log.

## Relay trigger reminder

Same as always: context-meter 70% warning, or seeing a compaction summary → message Coordinator,
relay again. Read the spec/plan by section only, never in full.
