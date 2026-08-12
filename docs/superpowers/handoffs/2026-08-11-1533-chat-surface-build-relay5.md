# Relay 5 — #1533 chat-surface routing build

Continuation of `...-relay4.md` (superseded — Phase 2 production code now done, tests still needed).

## Status

- Plan: `docs/superpowers/plans/2026-08-10-1533-chat-surface-send-routing.md` (`83ccac7a5`), approved
  by Coordinator + Ben. Ben: "Plan approved as written. Proceed Phase 1 through Phase 4... finish
  with the sensitive live-path proof and draft PR." No further check-in needed except the Phase 2
  kill gate (NOT triggered — mechanism implemented with zero new surface source) and the mandatory
  pre-draft-PR report.
- Phase 1: DONE, committed (`57f92ce2e` prod, `cda5b6ca5` tests). 16/16 green as of relay4.
- **Phase 2 production code: DONE, UNCOMMITTED.** `git status --short` shows only
  `M apps/web/src/chat/chat-drawer.tsx` (+64/-20). Implements all 7 mechanism steps from relay4
  exactly, verified by full re-read this session (not yet run through vitest/tsc):
  1. `surfaceRef` (useRef, synced every render).
  2. Reset `useEffect(() => {...}, [props.surface])` clearing all 12 listed local-state fields
     unconditionally.
  3. `sendMessage`'s IIFE: `initiatingSurface` captured, passed to `sendChatTurn`/threads
     invalidation; every post-await state mutation guarded on `surfaceRef.current === initiatingSurface`.
  4. `resumeMutation.mutationFn` takes `{threadId, surface}`; call site
     `resumeMutation.mutate({ threadId: id, surface: props.surface })`; `onSuccess`/`onError` guard
     local state on `vars.surface === surfaceRef.current`, invalidations unguarded.
  5. `startPrivateChat`'s IIFE: same `initiatingSurface` pattern as step 3.
  6. `drainAfterStopText` retyped to `{ text, surface } | null`; drain effect discards (no
     `sendMessage` call) when `drainAfterStopText.surface !== props.surface`.
  7. `switchToNewModelChat(surface)`: same-surface path unchanged (`startNewChat()`), cross-surface
     path is `void clearChat({ surface })`. Its one call site is
     `onCrossProviderSwitch={() => switchToNewModelChat(props.surface)}` — a Phase-2 stopgap; Phase 3
     replaces this with a real cross-surface caller in `ChatModelPill`.
- **Phase 2 tests: NOT WRITTEN.** `tests/unit/chat-drawer-surface.test.tsx` still has only Phase 1's
  6 cases (217 lines). Zero test-file edits made this session — do not assume any progress here.
- Verification commands from relay4 (§ below) have **not been run yet** this session.

## Immediate next action for successor

1. Read `docs/superpowers/handoffs/2026-08-11-1533-chat-surface-build-relay4.md` §"Phase 2 tests"
   for the 4 required cases (still accurate, do not re-derive). Selectors confirmed this session via
   `grep -n "HistoryList\|Show chat history\|aria-pressed\|onSelect\|is-selected\|Start private
   chat\|chatd-" apps/web/src/chat/chat-drawer.tsx`:
   - Private toggle: `aria-label="Start private chat"`, `aria-pressed={privateMode}` — **only
     renders on `DEFAULT_CHAT_SURFACE`**, not on a module surface.
   - History toggle: `aria-label={showHistory ? "Hide chat history" : "Show chat history"}`,
     `aria-pressed={showHistory}` — always available.
   - `HistoryList` (chat-drawer.tsx:648) renders one row per thread:
     `className="chatd-sess__row${selected ? " is-selected" : ""}"`, `onClick={() =>
     props.onSelect(thread.id)}`, title text in `.chatd-sess__title`. Mock `listChatThreads` with
     `mockResolvedValueOnce({ threads: [{ id: "t1", title: "Old thread", updatedAt:
     "2026-01-01T00:00:00Z" }] })` to get a clickable row (default mock returns `[]`).
   - `resumeChat` mock (currently bare `vi.fn(async () => ({}))`) needs a deferred variant
     (`mockImplementationOnce(() => new Promise(resolve => { resolveResume = resolve; }))`) for test
     cases 2/3, same pattern as the existing "routes Stop to cancelChatTurn" test's deferred
     `sendChatTurn`.
2. Add a `renderer.update(...)`-based rerender helper (NOT a fresh `create`) — existing
   `renderDrawer` always does a fresh mount with a fresh `QueryClient`; the new tests need to reuse
   one `QueryClient`/renderer across a surface flip. Needs its own `QueryClient`/`ReactElement`
   builder so the same `client` instance is passed to both the initial `create(...)` and the later
   `renderer.update(...)`.
3. Import additions needed in the test file: `resumeChat` (from the client mock), `queryKeys` (from
   `../../apps/web/src/api/query-keys.js`) for asserting which surface's `.threads()` key gets
   invalidated. A second/third module surface constant (e.g.
   `moduleChatSurface("job-search", "profile-2")`) is needed for the both-directions case (item 4)
   and to distinguish "old" vs "new" surface in assertions.
4. **Note on relay4's phrasing for test 2** ("invalidates the NEW surface's `.threads()` (not the
   old)"): this reads backwards relative to the mechanism itself (step 3 above, and step 4/5's
   analogous unguarded-invalidation pattern) — the implemented code always invalidates
   `initiatingSurface`/`vars.surface` (the surface the operation started on), never
   `surfaceRef.current`/`props.surface` at resolution time. Treat the **mechanism** as ground truth
   over that one sentence; assert invalidation targets the *initiating* (old) surface, not wherever
   the user has since navigated. If this reading is wrong, it's a fast fix — write the test, see
   which way it actually goes, adjust the assertion, don't block on it.
5. Once tests are written, run (both unpiped, must be `EXIT=0`):
   ```bash
   pnpm vitest run tests/unit/chat-drawer-surface.test.tsx > /tmp/1533-phase2.log 2>&1; echo "EXIT=$?"
   pnpm exec tsc --noEmit > /tmp/1533-phase2-tsc.log 2>&1; echo "EXIT=$?"
   ```
6. Commit (shared-checkout discipline: explicit paths, `git diff` review, `git show --name-only
   HEAD` after) — `apps/web/src/chat/chat-drawer.tsx` and `tests/unit/chat-drawer-surface.test.tsx`
   together or split, either is fine.
7. Phase 3 (`ChatModelPill` surface wiring, plan lines 235-291 — not yet read this or prior
   session), then Phase 4 (full gate + live-path proof + draft PR, plan lines 292-313), then
   `coordinated-wrap-up`. No further Coordinator/Ben check-in needed except the mandatory
   pre-draft-PR report.

## Ground truth

- Branch `build/1533-chat-surface-routing`, worktree `~/Jarv1s/.claude/worktrees/1533-chat-surface-build`.
  Latest commit `cda5b6ca5`; working tree has one uncommitted modified file (`chat-drawer.tsx`,
  Phase 2 production code, see above) — **do not discard it**.
- `node_modules` already installed — never `pnpm install`.
- Coordinator: label `Coordinator` — **re-resolve via `herdr pane list` before messaging**, names
  get reused. Prior lane's pane (label "Issue #1533 chat surface (relay2)",
  session `53494df8-f7e5-446e-91b8-588247bf762a`) was already confirmed reaped by this session
  earlier — not a live target anymore.
