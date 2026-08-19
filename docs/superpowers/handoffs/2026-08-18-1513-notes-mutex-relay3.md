# 1513 notes-mutex — relay 3 continuation

Branch/worktree: `1513-notes-mutex` (this worktree, unchanged). Coordinator label `Coordinator`
(session `b1aa5379-b1e8-46aa-9349-48b149a68dec`, pane `w1:pFK` — re-resolve fresh via
`herdr pane list`, don't trust this pane id later).

## Done (commit `7c2a38814`)

- `withPathLock` FIFO in-process mutex added to `packages/notes/src/write-tools.ts`, wired into
  `notesEditExecute` around the read→count→write critical section.
- Two new tests in `tests/integration/notes-write-tools.test.ts` under `describe("concurrent
  edits")`, using a deterministic `realpathMock` barrier. RED confirmed pre-implementation, GREEN
  confirmed after.
- `pnpm --filter @moss/notes typecheck` — EXIT 0 (fixed a TS2769 narrowing issue by hoisting
  `raw.oldText`/`raw.newText` to locals before the closure).
- Full file run `tests/integration/notes-write-tools.test.ts`: my 2 new tests pass; 2 unrelated
  gateway tests fail ("gateway auto-runs create/edit/delete under trusted_auto",
  "gateway forces confirmation for a notes.create overwrite...") — verified via stash/restore
  against pristine `write-tools.ts` that these fail identically without my change. Pre-existing,
  not mine to fix. Documented in the commit message already.

## Not yet done — do these in order

1. Pre-push trio at repo root: `pnpm format:check && pnpm lint && pnpm typecheck`.
2. `git fetch origin main && git rebase origin/main`.
3. Re-run the gate per `verify-gate` skill (don't improvise):
   `export JARVIS_PGDATABASE=jarvis_gate_1513notesmutex`, then
   `pnpm exec vitest run tests/integration/notes-write-tools.test.ts` +
   `pnpm --filter @moss/notes typecheck`. Expect: my tests green, the 2 pre-existing gateway
   failures still present (confirm once more, don't re-litigate).
4. Drop gate DB `jarvis_gate_1513notesmutex` when fully done.
5. `coordinated-wrap-up`: push, open PR. This is backend-only concurrency behavior, no UI
   surface — state that explicitly in the PR body so no live-path proof is expected. Mention the
   2 pre-existing unrelated gateway failures in the PR body too.
6. Report PR + evidence to the coordinator (label `Coordinator`, re-resolve session id fresh).
   Coordinator owns QA/merge/board/issue-close — do not do those yourself.

## Why relay 3 fired

Compaction summary appeared in relay-2's context (harness-triggered), which per the `relay` skill
is an immediate-relay tripwire — no further work in that context, hand off clean instead.
