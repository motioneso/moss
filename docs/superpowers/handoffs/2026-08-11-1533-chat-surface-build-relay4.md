# Relay 4 — #1533 chat-surface routing build

Continuation of `...-relay3.md` (superseded — Phase 1 is now fully done, including tests).

## Status

- Plan: `docs/superpowers/plans/2026-08-10-1533-chat-surface-send-routing.md` (commit `83ccac7a5`),
  approved by both Coordinator and Ben. Ben's exact instruction: "Plan approved as written. Proceed
  Phase 1 through Phase 4 within the nine-file allowlist... finish with the sensitive live-path
  proof and draft PR." No further per-phase check-in needed — proceed straight through.
- **Phase 1 is DONE — production code and tests, both committed.**
  - Production code: `57f92ce2e` (see relay3 for detail — `query-keys.ts`, `app-shell.tsx`,
    `chat-drawer.tsx` all threading `props.surface`).
  - Tests: `cda5b6ca5` — `tests/unit/app-shell-chat-surface.test.tsx` (3 assertions added) +
    new `tests/unit/chat-drawer-surface.test.tsx` (6 cases: privacy/threads read on module
    surface, private-chat control hidden on module surface, send/Stop/New-Chat routed to module
    surface, default-surface case shows the control and sends on `DEFAULT_CHAT_SURFACE`).
  - Kill gate green: `pnpm vitest run tests/unit/app-shell-chat-surface.test.tsx
    tests/unit/chat-drawer-surface.test.tsx` → 16/16 passed, EXIT=0 (log was at
    `/tmp/1533-phase1.log`, host-local, not committed).
- **Phase 2 (atomic surface-reset + stale-completion guards): NOT STARTED — zero code written.**
  Plan read in full (lines 141-234) and fully internalized this session; do not re-read, implement
  directly from the mechanism below.

## Phase 2 — exact mechanism to implement (from plan lines 141-234, do not re-derive)

All edits are in `apps/web/src/chat/chat-drawer.tsx` (750 lines as of `57f92ce2e`/`cda5b6ca5`,
unedited since). Confirmed via a full re-read this session — line numbers below are accurate as of
that commit:

1. **`surfaceRef`** — add near the top of the component body (after `queryClient`/
   `assistantName`, before other state):
   ```ts
   const surfaceRef = useRef(props.surface);
   surfaceRef.current = props.surface;
   ```
   Updated synchronously in the render body every render (not an effect).

2. **Reset effect** — new `useEffect(() => {...}, [props.surface])`, placed after all the state
   hooks it touches exist (state block is lines 66-135; place after the existing "clear stale
   fallbackRecords on new props.records" effect at ~144-164). Resets: `fallbackRecords` → `[]`,
   `pendingUser` → `null`, `privateMode` → `false`, `privateEnded` → `false`, `reviewThreadId` →
   `null`, `showHistory` → `false`, `isSending` → `false`, `sendError` → `null`, `needsProvider` →
   `false`, `activatingPrivate` → `false`, `privateActivationError` → `null`,
   `drainAfterStopText` → `null`. NOT gated on query settlement — fires unconditionally on every
   `props.surface` change (including mount).

3. **`sendMessage`'s async IIFE** (lines 192-259, call to `sendChatTurn` at ~213-247): capture
   `const initiatingSurface = props.surface;` immediately before the `void (async () => {...})()`
   call. Pass `initiatingSurface` (not `props.surface`) into `sendChatTurn(...)` and into the
   `.threads(...)` invalidation. Guard every post-await local-state mutation
   (`setPendingUser`/`setFallbackRecords`/`setSendError`/`setNeedsProvider`) in `then`/`catch` with
   `if (surfaceRef.current !== initiatingSurface) return;` placed right after the awaited call
   resolves/rejects (invalidateQueries runs unconditionally, BEFORE that guard). The `finally`
   block's `setIsSending(false)` is also guarded (`if (surfaceRef.current === initiatingSurface)`).

4. **`resumeMutation`** (lines 106-122): change `mutationFn` to
   `(vars: { readonly threadId: string; readonly surface: ChatSurface }) =>
   resumeChat(vars.threadId, vars.surface)`. Call site (~line 466, `resumeMutation.mutate(id)`)
   becomes `resumeMutation.mutate({ threadId: id, surface: props.surface })`. `onSuccess`/
   `onError` receive `(_data, vars)`/`(_error, vars)`; guard `props.clearRecords()`/
   `setShowHistory`/`setPrivateMode`/`setPrivateEnded`/`setReviewThreadId` behind
   `vars.surface === surfaceRef.current`; the `.threads(vars.surface)`/`.privacy(vars.surface)`
   invalidation calls stay unguarded (run always).

5. **`startPrivateChat`'s async IIFE** (lines 354-380): capture `const initiatingSurface =
   props.surface;` before the IIFE. Pass `initiatingSurface` into `clearChat({ incognito: true,
   surface: initiatingSurface })` and into the `.threads(...)` invalidation (unguarded). Guard
   `setFallbackRecords([])`/`props.clearRecords()`/`setPrivateMode(true)` in the success branch and
   `setPrivateActivationError(...)` in the catch behind `surfaceRef.current === initiatingSurface`.
   `finally`'s `setActivatingPrivate(false)` is also guarded.

6. **Queued Stop drain**: change `drainAfterStopText` state type (declared near
   `stopSending`, ~line 392) from `string | null` to
   `{ readonly text: string; readonly surface: ChatSurface } | null`. `stopSending` (lines
   392-399) stores `{ text: queuedText, surface: props.surface }` instead of the bare string. The
   drain effect (lines 261-266) discards (`setDrainAfterStopText(null)`, does NOT call
   `sendMessage`) when `drainAfterStopText.surface !== props.surface`; otherwise drains as today
   (call `sendMessage(drainAfterStopText.text)`, then `setDrainAfterStopText(null)`). Every other
   existing `setDrainAfterStopText(null)` call site (startNewChat ~340, startPrivateChat ~360,
   stream-disconnect effect ~308, and the new reset effect) stays `null` — still valid for the new
   type.

7. **`switchToNewModelChat`** (lines 350-352, currently just calls `startNewChat()`): change
   signature to `(surface: ChatSurface) => void`. If `surface === surfaceRef.current`, run today's
   full `startNewChat()` body unchanged. Otherwise, only `void clearChat({ surface })` — no local
   state touched. **Its one current call site** is `onCrossProviderSwitch={switchToNewModelChat}`
   on the `ChatModelPill` element (~line 586). **`ChatModelPill`'s current prop type is
   `onCrossProviderSwitch: () => void`** (confirmed via
   `grep -n "onCrossProviderSwitch" apps/web/src/chat/chat-model-pill.tsx` this session — line 27
   declares it, line 56 calls `props.onCrossProviderSwitch()` with no args) — Phase 2 must NOT
   break this call site into passing `undefined` as the surface. Per the plan: **"Phase 2 updates
   the signature and its one current call site; Phase 3 wires the new caller."** So Phase 2's call
   site fix is `onCrossProviderSwitch={() => switchToNewModelChat(props.surface)}` (closes over the
   current surface, preserving today's exact runtime behavior since `surface === surfaceRef.current`
   is always true when the pill itself triggers this synchronously) — Phase 3 later changes
   `ChatModelPill` to know its own surface and call `onCrossProviderSwitch(newSurface)` for a
   genuine cross-surface case. Do not skip the Phase 2 call-site fix — leaving
   `onCrossProviderSwitch={switchToNewModelChat}` as-is will not typecheck once the signature
   changes.

### Phase 2 tests (add to `tests/unit/chat-drawer-surface.test.tsx`, same file Phase 1 created)

4 surface-flip cases, spec lines 248-260, using one mounted drawer + `rerender` with a new
`surface` prop (react-test-renderer's `renderer.update(...)`, not a fresh `create`):

1. Populate `fallbackRecords`/`pendingUser`/private-mode/history-review state, then rerender with a
   different surface → assert all cleared (old text gone, private banner gone, `reviewThreadId`
   cleared, `showHistory` false). Fails today (no reset effect).
2. Resolve/reject a deferred old-surface `sendChatTurn` AFTER the surface prop changes → assert no
   record appended, no `pendingUser` restore, no `sendError`, invalidates the NEW surface's
   `.threads()` (not the old), `isSending` not left true for the new surface. Fails today (no
   guard).
3. Resolve a deferred `resumeChat` and a deferred `startPrivateChat` after a flip, and drain a
   queued Stop stored before the flip → none of the three mutate/submit through the new surface
   (drain must not call `sendChatTurn` at all). Fails today.
4. Flip module A → module B AND default → module (both directions) → all six state fields reset
   both ways. Fails today.

### Phase 2 verification (unpiped, run before commit)

```bash
pnpm vitest run tests/unit/chat-drawer-surface.test.tsx > /tmp/1533-phase2.log 2>&1; echo "EXIT=$?"
pnpm exec tsc --noEmit > /tmp/1533-phase2-tsc.log 2>&1; echo "EXIT=$?"
```
Both must be `EXIT=0`. The `tsc` run is repo-wide (not per-file — `.tsx` tests aren't typechecked
per #1335, but `chat-drawer.tsx` itself is a production `.ts`-adjacent file and IS typechecked).

### Phase 2 kill gate

If the surface-flip cases can't pass without introducing a second surface source (new store/
context/hook/callback adapter — spec explicitly forbids this in §1), **stop and escalate to
Coordinator** rather than improvising outside the ref/effect mechanism above.

## Next action for successor

1. Implement Phase 2 exactly per the mechanism above (all in `chat-drawer.tsx`) — no further plan
   reading needed, this doc is complete.
2. Add the 4 surface-flip tests to `tests/unit/chat-drawer-surface.test.tsx`.
3. Run the Phase 2 verification commands above; both must be EXIT=0.
4. Commit Phase 2 (production + tests together or split — either is fine, shared-checkout rules
   apply either way: explicit paths, `git diff` review before commit on any co-edited file,
   `git show --name-only HEAD` after).
5. Continue to **Phase 3** (`ChatModelPill` surface — plan lines 235-291, not yet read this
   session; known Phase-2-created gap: `switchToNewModelChat` now takes `(surface: ChatSurface)`
   and its Phase-2 call site closes over `props.surface`, so Phase 3's job is giving
   `ChatModelPill` its own surface awareness and a real cross-surface call).
6. Then **Phase 4** (full gate + live-path proof + draft PR — plan lines 292-313), then invoke
   `coordinated-wrap-up`.
7. No further Coordinator/Ben check-in needed per Ben's standing approval, EXCEPT the Phase 2 kill
   gate escalation condition above, and the mandatory pre-draft-PR report.

## Ground truth

- Branch: `build/1533-chat-surface-routing`. Latest commit `cda5b6ca5` (Phase 1 tests). Working
  tree clean (verified via `git status --short` immediately before writing this doc).
- Merge-base with `origin/main`: re-check with `git merge-base HEAD origin/main` — was `abfe0478b`
  as of 2026-08-10, likely stale now.
- Coordinator: label `Coordinator`, session id `019fef6b-8f40-7453-a6f9-4c3e245dce52` — **re-resolve
  current registered name via `herdr pane list`/`herdr agent list` before messaging** (names get
  reused by newer agents — this was flagged in relay3 and still applies, not yet done in this or
  the prior segment).
- `node_modules` already installed — never `pnpm install`.
- Shared checkout: always commit by explicit path (`git commit <paths> -m ...`), never `-A`/bare;
  `git diff` any co-edited file before committing; verify with `git show --name-only HEAD` after
  every commit.
