# #1512 relay 5 → 6 handoff

Full state: `memory_recall("1512 relay 5 end-state notes.test.ts file-size")` or search agentmemory
for memory id `mem_msxnngxu_4c2c48cb1360` (project `jarv1s`, type `bug`). Read it before touching
anything — it has the exact line ranges, import lists, and grep confirmations. This doc is just
the pointer + immediate next action.

## State

- Tasks 1+2 DONE, COMMITTED, rebased clean on `origin/main`: `da2e65df0`, `2ddda8cc3`, `eca496d5f`.
- `format:check` / `lint` / `typecheck` all green.
- Isolated gate (`scripts/run-gate.sh`, DB `jarvis_gate_1512_notes_path_recheck`) got to
  `check:file-size` and died: `tests/integration/notes.test.ts: 1060` lines (limit 1000). Log:
  `/tmp/jarv1s-gate/1512_notes_path_recheck-20260817-125024.log`. That gate DB was left kept
  (rc=1) — start fresh via `run-gate.sh start`, don't reuse it.

## Immediate next action

Split `tests/integration/notes.test.ts`. Extract `describe("handleNotesSyncJob", ...)`
(lines 366-790) plus the TOCTOU `vi.mock`/`vi.hoisted` scaffolding (lines 1-39) into a new sibling
file `tests/integration/notes-sync-worker.test.ts`, mirroring the existing
`notes-write-tools.test.ts` split. Full import-by-import breakdown and exclusivity grep results
are in the memory entry above — **verify each import removal with a fresh grep before deleting it
from the old file**, don't trust the memory blindly since it wasn't 100% exhaustively checked for
every identifier.

Then: typecheck → run both test files individually (real exit code, unpiped) confirming the 2
TOCTOU tests still pass → commit the split (shared-checkout: diff-review, explicit paths,
`git show --name-only HEAD` after) → re-run `format:check`/`lint`/`typecheck` → fresh
`scripts/run-gate.sh start`/`wait`/`status` → on green, push + `gh pr create` (SECURITY TIER,
needs Opus adversarial QA + Fable-5 sign-off before merge, live-path N/A, disclose the test-file
split and both TOCTOU fixes) → report to Coordinator `coord-take29` via `herdr-pane-message`
(re-resolve pane fresh via `herdr pane list` first).

Do not move the board, close the issue, or merge — coordinator's job.
