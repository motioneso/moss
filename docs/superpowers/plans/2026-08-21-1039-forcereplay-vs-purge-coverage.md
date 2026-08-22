# Plan — 1039-forcereplay-vs-purge-coverage

**Spec:** GitHub issue #1039 body (no separate spec file — test-only follow-up from #984's QA pass).
**Task issue:** #1039 ("Part of #984").
**Risk tier:** routine, test-only. No production code path changes expected.

## Seams check (file:line citations)

- `packages/chat/src/live/persistence.ts:179-183` — D4 guard: an incognito thread's
  `listPriorTurns` returns `{ recent: [], oldSummary: null }` unconditionally, before the
  `forceReplay` opt is even read. This is the guard the plan's new test proves holds.
- `packages/chat/src/live/persistence.ts:202` (and the comment above it, `:198-201`) —
  `forceReplay` only changes a log-visibility label (`trigger`); it does not change which rows are
  fetched.
- `packages/chat/src/live/persistence.ts:250` — `chat-session-manager.ts`'s `launchSession` passes
  `opts?.forceReplay` straight through to `listPriorTurns`.
- `packages/chat/src/live/chat-session-manager.ts:255-257` — a launch on an incognito thread
  throws `CliChatUnavailableError("private session unavailable")` unless the engine exposes
  `purgeTranscripts`. This is independent of `forceReplay`.
- `packages/chat/src/live/chat-session-manager.ts:702-713` — `switchProvider` always calls
  `ensureSession(..., { forceReplay: true }, ...)`. This is the one call site that could, in a
  future refactor, be reached with an incognito thread and would need the D4 guard to hold.
- Existing coverage already in the tree, confirmed by reading each file in full:
  - `tests/integration/chat-token-budgets.test.ts:267-288` ("T2-d") — proves `forceReplay: true`
    and plain launch return an *identical* window on a **non-incognito** thread with 25 retained
    turns. This is the "re-render from retained history" half.
  - `tests/integration/chat-private-mode.test.ts:97-158` ("T2-c") — proves a plain (no
    `forceReplay` opt) `listPriorTurns` call against an **incognito** thread with 25 stored rows
    returns nothing. This is the "history removed" half, but never exercised with
    `forceReplay: true`.
  - `tests/unit/chat-switch-replay.test.ts:34-43` — proves `switchProvider` passes
    `{ forceReplay: true }` into a **mocked** `listPriorTurns`; it asserts the call arguments only,
    never the resulting `replayBatch` sent to `engine.launch`, and never touches incognito.

**The actual gap:** no test calls `listPriorTurns(..., { forceReplay: true })` against an
incognito thread with real stored rows, and no test exercises the full `ChatSessionManager`
launch path (stub engine, real branching logic) to confirm what reaches `engine.launch`'s
`replayBatch` differs between a `forceReplay` relaunch of a normal thread (has content) and an
incognito thread (undefined/no content), including when `forceReplay: true` is passed to the
incognito case. Today the two paths are proven correct in isolation but never proven not to
converge if someone edits one and not the other.

## Determinism boundary

N/A — no user-facing UI or model-authored content. Pure backend test coverage.

## Task 1 — persistence-layer: forceReplay never overrides incognito

**File:** `tests/integration/chat-private-mode.test.ts` (append inside the existing
`describe("private chat persistence")` block, after the current last test).

**New test:** `"T2-e: forceReplay: true does not override incognito — purge still wins"`
- Reuses the existing pattern at `chat-private-mode.test.ts:97-144` (open an incognito thread,
  insert 25 stored message rows directly via `scopedDb.db.insertInto("app.chat_messages")`,
  bypassing the repository no-op).
- Calls `persistence.listPriorTurns(ids.userA, { forceReplay: true })` (the one difference from
  T2-c, which calls it with no opts).
- Asserts `result.recent` is `[]` and `result.oldSummary` is `null` — same assertions as T2-c,
  proving the outcome is unchanged by the presence of `forceReplay: true`.

**Why this test would fail against a broken implementation:** if `persistence.ts`'s D4 guard were
ever reordered to check `forceReplay` before `incognito`, or someone added a
`if (forceReplay) return realRows` shortcut ahead of the incognito check, this test catches it;
T2-c alone would not, because T2-c never sets `forceReplay: true`.

## Task 2 — session-manager layer: replayBatch content actually diverges

**File (new):** `tests/unit/chat-force-replay-vs-purge.test.ts`

Follows the existing stub pattern in `tests/unit/chat-switch-replay.test.ts:6-32` (stub engine
with a `launch` spy, stub `ChatSessionManagerDeps.persistence`), but asserts on the `replayBatch`
argument `engine.launch` actually receives, not just the `listPriorTurns` call args.

**Test A — `"forceReplay relaunch on a normal thread carries retained history into replayBatch"`**
- `persistence.listPriorTurns` mock returns `{ recent: [{ role: "user", content: "q1" }, { role: "assistant", content: "a1" }], oldSummary: null }` for any call.
- `persistence.getCurrentThreadState` mock returns `{ id: "t1", incognito: false }`.
- Call `manager.ensureSession("user-1", "User")`, then `manager.switchProvider("user-1", "User")`
  (this is the real `forceReplay: true` call site — no synthetic opts).
- Assert the **second** `engine.launch` call's `replayBatch` argument is a string containing
  `"q1"` and `"a1"` (i.e., the retained turns were rendered into the replay block).

**Test B — `"an incognito relaunch renders no replayBatch even when forceReplay: true is passed"`**
- `persistence.listPriorTurns` mock returns `{ recent: [], oldSummary: null }` unconditionally
  (this is what the real D4 guard guarantees per Task 1 — the unit test stubs that guarantee
  rather than re-proving it, since Task 1 already proves it against the real DB).
- `persistence.getCurrentThreadState` mock returns `{ id: "t-priv", incognito: true }`.
- Engine stub exposes `purgeTranscripts: vi.fn()` (required per
  `chat-session-manager.ts:255-257` or launch throws).
- Call `manager.ensureSession("user-1", "User", { forceReplay: true })` directly (simulating the
  `switchProvider` call site landing on a private session).
- Assert `engine.launch` was called with `replayBatch: undefined` — no memory seed, no summary, no
  recent turns — proving `forceReplay: true` cannot resurrect content purge already removed.

**Test C — `"an incognito relaunch without engine purge support refuses to launch, regardless of forceReplay"`**
- Same as Test B but the engine stub has no `purgeTranscripts` method.
- Assert `manager.ensureSession("user-1", "User", { forceReplay: true })` rejects with
  `CliChatUnavailableError` (imported from `packages/chat/src/live/types.js` or wherever it's
  exported — confirm the export path when writing the import, matching
  `chat-session-manager.ts`'s own import of it).

**Why these tests would fail against a broken implementation:** if a future edit made
`forceReplay` short-circuit past the incognito branch in `launchSession` (e.g., moved the
`threadState?.incognito` checks below the `replayParts` construction, or made `forceReplay` build
`replayBatch` from a separate non-DB source), Test B or Test C would fail while Test A kept
passing — which is exactly the "silently converge" failure mode the issue names.

## Verification

```bash
pnpm --filter @moss/chat exec vitest run ../../tests/unit/chat-force-replay-vs-purge.test.ts > /tmp/1039-unit.log 2>&1; echo "EXIT=$?"
```
Expected: `EXIT=0`. (If the workspace filter doesn't resolve root `tests/`, fall back to
`pnpm vitest run tests/unit/chat-force-replay-vs-purge.test.ts` from repo root — confirm whichever
resolves during Task 2 and use it for both tasks.)

```bash
pnpm test:integration > /tmp/1039-integration.log 2>&1; echo "EXIT=$?"
```
Expected: `EXIT=0`. (Full integration run rather than a single-file filter — the file uses a
shared `resetFoundationDatabase()` `beforeAll` other tests in the same file depend on; run under
the `verify-gate` skill's isolated gate DB, not the live dev DB.)

Full local gate at wrap-up: `pnpm verify:foundation` under the `verify-gate` skill recipe (never
run unscoped).

## Kill gate

None needed — this is a single-phase, test-only addition with no architectural fork. If Task 1 or
Task 2 turns up that the current code *does* let `forceReplay` leak purged content (i.e., a real
bug, not a coverage gap), stop and escalate to the coordinator before writing any production-code
fix — that would take this lane outside "test-only" and the coordinator needs to decide scope.

## Rulings ledger

- Confirmed by reading, not assumed: `forceReplay` and "purge" are different mechanisms over
  different substrates — `forceReplay` rebuilds a DB-backed replay window for a fresh engine
  process (`persistence.ts`), while "purge" (`purgeTranscripts` / `purgePrivateTranscripts`)
  deletes an engine's own on-disk transcript files for a private/incognito session
  (`chat-session-manager.ts:939-970`, `private-transcript-cleanup.ts`). The issue's "history
  removed" maps to the incognito/D4 DB-read guard for this plan's purposes, since that's the piece
  `listPriorTurns` (the function under test) actually controls; file-level transcript purging is
  already covered by `tests/unit/chat-session-manager-private.test.ts` and is out of scope here.
