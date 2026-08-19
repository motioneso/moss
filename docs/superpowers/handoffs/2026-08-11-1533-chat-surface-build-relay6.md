# Relay 6 — #1533 chat-surface routing build

Continuation of `...-relay5.md` (superseded — this session did test design only, wrote zero code).

## Status

- Ground truth unchanged from relay5: branch `build/1533-chat-surface-routing`, worktree
  `~/Jarv1s/.claude/worktrees/1533-chat-surface-build`. Latest commit `814bd5cfc`. Working tree:
  `M apps/web/src/chat/chat-drawer.tsx` only (Phase 2 production code, uncommitted, do not
  discard — confirmed via full re-read this session, matches relay5's description exactly, all 7
  mechanism steps present and correct).
- `tests/unit/chat-drawer-surface.test.tsx`: still only Phase 1's 6 cases (217 lines). **Zero
  test-file edits made this session.** This session spent its whole budget designing the 4 Phase-2
  tests in detail (below) and did not write them — do not re-derive, just implement.
- `node_modules` already installed — never `pnpm install`.

## Immediate next action: implement these 4 tests exactly as designed

Add to `tests/unit/chat-drawer-surface.test.tsx`. Needed new imports: `resumeChat`, `ApiError` from
`../../apps/web/src/api/client.js`; `queryKeys` from `../../apps/web/src/api/query-keys.js`. Add
`const moduleSurfaceB = moduleChatSurface("job-search", "profile-2") as ChatSurface;` near the
existing `moduleSurface` const.

**Shared helper needed** (does not exist yet — build it):
```ts
function buildElement(client: QueryClient, surface: ChatSurface, clearRecords: () => void): ReactElement {
  // same tree as renderDrawer's body, but takes an existing client + clearRecords so the SAME
  // client/renderer can be reused across a surface flip via renderer.update(...), not a fresh create().
}
```
Use `renderer.update(buildElement(client, newSurface, clearRecords))` inside `act(async () => {...; await Promise.resolve(); await Promise.resolve();})` to flip surfaces on one mounted renderer + one QueryClient (existing `renderDrawer` always does a fresh `create` with a fresh client — wrong for these tests).

### Test 1 — "clears local surface state on a surface flip"
Render on `DEFAULT_CHAT_SURFACE`. Populate: deferred `sendChatTurn` (unresolved) via
`typeAndSend` → `pendingUser`/`isSending` set; open history (click "Show chat history"); **before**
the initial render, prime `listChatThreads.mockResolvedValueOnce({ threads: [{ id: "t1", title:
"Old thread", updatedAt: "2026-01-01T00:00:00Z" }] })` so a row is clickable; click the thread row
→ `resumeMutation.mutate({threadId:"t1", surface: DEFAULT_CHAT_SURFACE})` resolves (default
`resumeChat` mock resolves immediately) → sets `reviewThreadId="t1"`, `showHistory` back to false.
State now: `pendingUser` set, `isSending` true, `reviewThreadId="t1"` — all three coexist fine
(resumeMutation's onSuccess doesn't touch pendingUser/isSending). Flip to `moduleSurface`. Assert:
`findByClassName(renderer, "chatd-empty")` is **not null** (this one assertion proves
`pendingUser`, `fallbackRecords`, AND `reviewThreadId` all cleared at once — if any were still set,
the drawer would render `Thread` or the reviewed-messages view, not the empty state, since
`chatRouteQuery` mock reports `available: true`). Also assert `chatd-send` aria-label is back to
`"Send"` (not `"Stop generating"`) and `findByAriaLabel(renderer, "Hide chat history")` is null.
Resolve the stale deferred `sendChatTurn` at the end (guarded no-op) so nothing dangles.

### Test 2 — "guards a stale sendChatTurn resolution after a surface flip"
Render on `moduleSurface`. `vi.spyOn(client, "invalidateQueries")` right after creating the
client (before any action). Deferred `sendChatTurn`; `typeAndSend`. Flip to `moduleSurfaceB`.
Resolve the deferred send with a normal success payload. Assert:
`invalidateSpy` was called with `{ queryKey: queryKeys.chat.threads(moduleSurface) }` (the OLD/
initiating surface — unguarded, runs regardless of the flip; this is the "invalidate the
initiating surface, not wherever the user navigated since" behavior chat-drawer.tsx:247-249 — see
relay5's note: relay4's "invalidates the NEW surface" phrasing was backwards vs. the actual
mechanism, trust the code). Assert `chatd-empty` still renders (no leaked reply appended to
`fallbackRecords` on the new surface) and `chatd-send` aria-label is `"Send"` (not stuck sending).

### Test 3 — "guards stale resumeChat/startPrivateChat and discards a queued Stop after a flip"
Three sequential stages on one renderer, one QueryClient, spying on `clearRecords` (a `vi.fn()`
passed into `buildElement` throughout — must stay THE SAME mock across every `buildElement` call in
this test) and counting `sendChatTurn` calls:
1. Start on `DEFAULT_CHAT_SURFACE`. Deferred `clearChat`
   (`vi.mocked(clearChat).mockImplementationOnce(() => new Promise((resolve) => { resolvePrivate = resolve; }))`).
   Click "Start private chat". Flip to `moduleSurface`. Resolve `clearChat`. Assert `clearRecords`
   was NOT called (guard blocks the success branch since `surfaceRef.current !== initiatingSurface`).
2. Still on `moduleSurface`. Prime `listChatThreads.mockResolvedValueOnce({threads:[{id:"t1",...}]})`
   BEFORE this stage's surface became active is too late — thread queries only fire once per
   surface per QueryClient, so prime this mock **before the very first render that uses
   `moduleSurface`** (i.e., move this `mockResolvedValueOnce` to before the initial `create()` in
   step-1's setup, not here — reorder so both thread-list needs are primed up front, in call order,
   since `mockResolvedValueOnce` consumes in FIFO order across the test). Deferred `resumeChat`.
   Open history, click the thread row. Flip to `moduleSurfaceB`. Resolve `resumeChat`. Assert
   `clearRecords` STILL not called (accumulated assertion), and `invalidateSpy`-equivalent (or just
   trust test 2 covers the invalidate-target assertion — don't over-test here) — keep this stage's
   assertion to just the `clearRecords` guard to avoid redundancy.
3. Still on `moduleSurfaceB`. Get `isSending` true via a fresh deferred `sendChatTurn` +
   `typeAndSend`. Queue a second message: `textarea.props.onChange({target:{value:"queued"}})` then
   `textarea.props.onKeyDown({key:"Enter", shiftKey:false, preventDefault:() => undefined})` (this
   is composer.tsx's `send()` path when `props.isSending` is true — it queues instead of sending,
   see composer.tsx:226-247). Click the send button (now showing "Stop generating") to invoke
   `stop()` → `props.onStop(queuedText)` → drawer's `stopSending` sets
   `drainAfterStopText = {text, surface: moduleSurfaceB}`. Record
   `const callsBefore = vi.mocked(sendChatTurn).mock.calls.length;`. Flip to `DEFAULT_CHAT_SURFACE`.
   Assert `vi.mocked(sendChatTurn).mock.calls.length === callsBefore` (drain effect discarded,
   never called `sendMessage`/`sendChatTurn` for the queued text — chat-drawer.tsx:293-299). Resolve
   the still-pending original deferred `sendChatTurn` at the end (guarded no-op) so nothing dangles.

### Test 4 — "resets state on a flip in both directions"
Two independent sub-scenarios, same test:
- `moduleSurface` → `moduleSurfaceB`: populate `showHistory=true` (toggle) and `sendError` (reject
  the deferred `sendChatTurn` with a plain `new Error("boom")` via `typeAndSend` + reject) — after
  the catch's guard fields are irrelevant since same-surface; just let it resolve/reject BEFORE the
  flip this time (not deferred-past-flip — that's tests 2/3's job) so `sendError` is actually set
  pre-flip. Flip. Assert no error text rendered (find the error node — check `Composer`'s
  `sendError` display, likely a `chatd-*` class; grep composer.tsx for how `sendError` renders if
  unsure) and `findByAriaLabel(renderer, "Hide chat history")` is null.
- `DEFAULT_CHAT_SURFACE` → `moduleSurface`: populate `privateMode=true` (start private chat,
  resolved) and `showHistory=true` (toggle, independent). Flip. Assert
  `findByAriaLabel(renderer, "Start private chat")` is null (module surface hides the control
  regardless, so also assert via the OTHER surface later if you want a stronger check — optional)
  and `findByAriaLabel(renderer, "Hide chat history")` is null.

### Verification (after all 4 tests written, unpiped, must be EXIT=0)
```bash
pnpm vitest run tests/unit/chat-drawer-surface.test.tsx > /tmp/1533-phase2.log 2>&1; echo "EXIT=$?"
pnpm exec tsc --noEmit > /tmp/1533-phase2-tsc.log 2>&1; echo "EXIT=$?"
```
Expect some assertion misses on first run (e.g. exact `sendError` rendering class, exact timing of
`await Promise.resolve()` counts needed per stage) — fix mechanically against actual output, the
mechanism itself (chat-drawer.tsx) is correct and already verified twice by full re-read (relay5
and this session). Don't re-verify the production code again, just make the tests pass against it.

### Then
Commit Phase 2 (production + tests, shared-checkout discipline: explicit paths, `git diff` review,
`git show --name-only HEAD` after). Then Phase 3 (`ChatModelPill` surface, plan lines 235-291) and
Phase 4 (full gate + live-path proof + draft PR, plan lines 292-313) per
`docs/superpowers/plans/2026-08-10-1533-chat-surface-send-routing.md`. No further Coordinator/Ben
check-in needed except the mandatory pre-draft-PR report (per relay5/Ben's standing approval).

## Coordinator

Label `Coordinator` — **re-resolve via `herdr pane list` before messaging**, names get reused.
This session never messaged it (no plan fork, no blocker hit — pure test-design work). Prior
lane's pane (label "Issue #1533 chat surface (relay4)", session
`0ba62bdf-d339-4947-9045-6298006ff563`) was the reap target named in this session's boot brief —
**not yet confirmed reaped**; the successor should resolve+reap it (or confirm already reaped)
before or alongside its first Coordinator message.
