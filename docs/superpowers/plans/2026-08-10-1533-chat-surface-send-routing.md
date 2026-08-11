# Build plan — #1533 chat-surface routing

**Spec:** `docs/superpowers/specs/2026-08-10-1533-chat-surface-send-routing.md` (approved, Fable
comment on PR #1563).
**Task issue:** #1533.
**Boundary:** 9-file allowlist from the spec's "One-session implementation boundary" — no other
file is touched.
**Determinism boundary:** N/A in the strict model-output sense — this build has no model call. The
equivalent invariant here is: no drawer state update may be driven by which surface *used to be*
active. Every render reflects `props.surface` only; stale async completions are guarded (Phase 2).

## Seams already confirmed (do not re-derive)

All citations below were re-verified against the current tree in this session (line numbers may
drift ±1 from the relay doc but content matches):

- `ChatSurface` / `DEFAULT_CHAT_SURFACE` exported from `@moss/shared`
  (`packages/shared/src/chat-api.ts:11-17`); `apps/web/src/shell/app-shell.tsx` already imports
  both (lines 61-62) and computes `activeSurface` (line 141) fed to `useChatStream` (line 146).
  Neither `chat-drawer.tsx` nor `chat-model-pill.tsx` nor `query-keys.ts` import `ChatSurface` yet.
- `apps/web/src/api/client.ts` — every drawer-relevant client fn already takes optional
  `surface?: ChatSurface` (`listChatThreads` L767, `listChatThreadMessages` L772-774,
  `sendChatTurn` L854-858, `cancelChatTurn` L934, `clearChat` L939-941, `endPrivateChat` L950,
  `getChatPrivacyState` L955-956, `resumeChat` L966) **except** `switchChatProvider`
  (L1161-1163: `switchChatProvider(): Promise<void>` — no param, posts to `/api/chat/switch`
  unconditionally). The `?surface=` pattern to copy is `listChatThreads`
  (L767-769: `const query = surface ? \`?surface=${encodeURIComponent(surface)}\` : ""`).
- `apps/web/src/api/query-keys.ts:81-91` — `chat.privacy` is a bare tuple
  (`["chat", "privacy"] as const`); `chat.threads`/`chat.messages` are already surface-keyed
  functions defaulting to `"drawer"`.
- `apps/web/src/chat/chat-drawer.tsx` (742 lines) props type starts line 45 (no `surface` field).
  Confirmed state inventory for the Phase 2 reset effect: `reviewThreadId` (L63),
  `showHistory` (L64), `privateMode` (L65), `privateEnded` (L66), `activatingPrivate` (L67),
  `privateActivationError` (L68), `isSending` (L121), `sendError` (L122), `needsProvider` (L123),
  `drainAfterStopText` (L124), `pendingUser` (L128-131), `fallbackRecords` (L132). Confirmed call
  sites: `privacyStateQuery` L70-74 (`getChatPrivacyState()`, key `queryKeys.chat.privacy`),
  `resumeMutation` L103-119 (`resumeChat(threadId)`, invalidates `.threads()`/`.privacy`),
  `threadsQuery` L171-175, `messagesQuery` L176-180, `sendMessage` async IIFE L189-254
  (`sendChatTurn(trimmed, attachments?.map(...))`, invalidates `.threads()`), `startNewChat`
  L329-343 (`clearChat()`, invalidates `.threads()`), `switchToNewModelChat` L345-347 (currently
  just calls `startNewChat()`), `startPrivateChat` L349-375 async IIFE (`clearChat({incognito:
  true})`), `closePrivateChat` L377-383 (`endPrivateChat()`), `stopSending` L387-394
  (`cancelChatTurn()`). "Start private chat" button L419-428 currently unconditional — no
  surrounding gate. `<ChatModelPill>` usage L576-580 passes `disabled`, `privateMode`,
  `onCrossProviderSwitch` — no `surface`.
- `apps/web/src/chat/chat-model-pill.tsx` (168 lines, read in full). Props L24-28: `disabled`,
  `privateMode`, `onCrossProviderSwitch: () => void` — no `surface`. `mutation` L49-63:
  `mutationFn: async (choice: ModelChoice) => {...}`, same-provider branch calls
  `switchChatProvider()` (no arg) L54, cross-provider branch calls `props.onCrossProviderSwitch()`
  L56, invalidates `queryKeys.ai.chatModelOverride` + `queryKeys.chat.threads()` L58-61.
- Tests: `tests/unit/app-shell-chat-surface.test.tsx` confirmed — `chatDrawerRecordsCalls` array
  (L58-61) captures only `props.records` from the mocked `ChatDrawer`; `lastSurfaceArg()` (L119)
  reads the mocked `useChatStream` call args. `tests/unit/chat-drawer-surface.test.tsx` and
  `tests/unit/chat-model-pill-surface.test.tsx` confirmed not to exist (`ls` exit 2 in prior
  session, unchanged).

## Phase 1 — surface prop threading + private-chat gating

**Scope:** wire `props.surface` through every existing drawer call site and query key; gate the
private-chat control; extend the shell pairing test. Does **not** yet include the atomic
reset/stale-completion guard (Phase 2) or `ChatModelPill` (Phase 3) — Phase 1 leaves
`switchToNewModelChat`/`startNewChat` and the model pill untouched beyond what's listed below.

### Changes

- `apps/web/src/api/query-keys.ts`: change `chat.privacy` from `["chat", "privacy"] as const` to
  `privacy: (surface?: string) => ["chat", "privacy", surface ?? "drawer"] as const`, mirroring
  `threads`/`messages`.
- `apps/web/src/shell/app-shell.tsx`: add `surface={activeSurface}` to the `<ChatDrawer>` JSX
  (currently passes `open`, `onClose`, `records`, `clearRecords`, `streamErrorCount`, `isFounder`,
  `initialText`, `focusActionRequestId`, `onActionRequestFocused`).
- `apps/web/src/chat/chat-drawer.tsx`:
  - Import `type ChatSurface` from `@moss/shared`.
  - Add `readonly surface: ChatSurface;` to the props type (required, no default).
  - `privacyStateQuery`: key `queryKeys.chat.privacy(props.surface)`, call
    `getChatPrivacyState(props.surface)`.
  - `resumeMutation`: `mutationFn: (threadId: string) => resumeChat(threadId, props.surface)`;
    `onSuccess` invalidates `queryKeys.chat.threads(props.surface)` and
    `queryKeys.chat.privacy(props.surface)`.
  - `threadsQuery`: `queryKeys.chat.threads(props.surface)`, `listChatThreads(props.surface)`.
  - `messagesQuery`: unchanged key shape (already surface-agnostic by thread id) — no surface
    param exists on `listChatThreadMessages`'s call in this drawer today per spec item 2, but the
    client fn takes one: call `listChatThreadMessages(reviewThreadId ?? "", props.surface)` and
    key `queryKeys.chat.messages(reviewThreadId ?? "", props.surface)`.
  - `sendMessage`: `sendChatTurn(trimmed, attachments?.map((a) => a.id), undefined,
    props.surface)`; invalidate `queryKeys.chat.threads(props.surface)`.
  - `startNewChat`: `clearChat({ surface: props.surface })`; invalidate
    `queryKeys.chat.threads(props.surface)`.
  - `startPrivateChat`: `clearChat({ incognito: true, surface: props.surface })`; invalidate
    `queryKeys.chat.threads(props.surface)`.
  - `closePrivateChat`: `endPrivateChat(props.surface)`.
  - `stopSending`: `cancelChatTurn(props.surface)`.
  - "Start private chat" button (L419-428): wrap in
    `{props.surface === DEFAULT_CHAT_SURFACE && ( ... )}` — import `DEFAULT_CHAT_SURFACE` from
    `@moss/shared` alongside the type import.

### Tests

- Extend `tests/unit/app-shell-chat-surface.test.tsx`: extend the `chat-drawer.js` mock to also
  push `props.surface` into a new `chatDrawerSurfaceCalls: string[]` array (mirroring the existing
  `chatDrawerRecordsCalls` pattern at L58-61). Add 3 assertions (spec's exact 3 cases):
  1. No module claim → `chatDrawerSurfaceCalls.at(-1) === DEFAULT_CHAT_SURFACE` **and**
     `=== lastSurfaceArg()`.
  2. `renderWithModuleMount("job-search", "profile-1")` →
     `chatDrawerSurfaceCalls.at(-1) === moduleChatSurface("job-search", "profile-1")` **and**
     `=== lastSurfaceArg()`.
  3. After `setSurfaceKey(null)` → both back to `DEFAULT_CHAT_SURFACE`.
  These fail today because the mock never captures a `surface` prop — `ChatDrawer` doesn't receive
  one.
- New `tests/unit/chat-drawer-surface.test.tsx` (routing half only in this phase — the
  surface-flip assertions in this same file belong to Phase 2's guard mechanism, but the file is
  authored once, so this phase writes the file and Phase 2 adds the flip cases to it):
  - Render with `surface={moduleSurface}` (a `moduleChatSurface("job-search", "profile-1")`
    value), invoke the composer's real `onSend`, assert
    `expect(sendChatTurn).toHaveBeenCalledExactlyOnceWith("Remote only", undefined, undefined,
    moduleSurface)`. Fails today: `sendChatTurn` is called with 2 args, no surface.
  - Invoke Stop, assert `cancelChatTurn` called with `moduleSurface`. Fails today: called with 0
    args.
  - Invoke New Chat, assert `clearChat` called with `{ surface: moduleSurface }`. Fails today:
    called with 0 args.
  - Assert initial privacy/thread reads (`getChatPrivacyState`, `listChatThreads`) receive
    `moduleSurface`. Fails today: called with 0 args.
  - Assert the private-chat control (`aria-label="Start private chat"`) is absent when
    `surface === moduleSurface`. Fails today: always rendered.
  - Default-drawer case: assert the private control is present and a send uses
    `DEFAULT_CHAT_SURFACE`.

### Verification (unpiped, exit code recorded)

```bash
pnpm vitest run tests/unit/app-shell-chat-surface.test.tsx tests/unit/chat-drawer-surface.test.tsx > /tmp/1533-phase1.log 2>&1; echo "EXIT=$?"
```
Expected `EXIT=0`.

### Kill gate (owner: whoever is driving this build lane — self)

If either file above doesn't reach green, or wiring `props.surface` through these 8 call sites
surfaces a 9th call site the seams check missed, **stop** — do not start Phase 2. Re-plan against
what was actually found instead of pushing forward on a stale file inventory.

## Phase 2 — atomic surface-reset + stale-completion guards

**Scope:** spec's "Locked design" §4 (`docs/superpowers/specs/2026-08-10-1533-chat-surface-send-
routing.md:138-166`) and the surface-flip regression tests
(same spec, lines 248-260). This is listed in the spec's "Expected production change" as "one
surface-change reset/late-completion guard" — it is required production code, not optional
hardening.

### Mechanism (decision, not implementation)

- Add `const surfaceRef = useRef(props.surface); surfaceRef.current = props.surface;` — updated
  synchronously in the render body (not an effect), so any closure created during this render can
  read the *current* value even after a later render changes `props.surface` before the closure
  runs.
- Add one `useEffect(() => { ...resets... }, [props.surface])` that on every surface change sets:
  `fallbackRecords` → `[]`, `pendingUser` → `null`, `privateMode` → `false`, `privateEnded` →
  `false`, `reviewThreadId` → `null`, `showHistory` → `false`, plus the transient flags
  `isSending` → `false`, `sendError` → `null`, `needsProvider` → `false`, `activatingPrivate` →
  `false`, `privateActivationError` → `null`, `drainAfterStopText` → `null`. Do not gate this
  effect on the privacy/history queries settling — spec: "Do not wait for the new privacy/history
  queries to settle before clearing old state."
- Every async operation that mutates local state after an `await` captures its initiating surface
  in a local `const initiatingSurface = props.surface` (or receives it as a mutation variable —
  see `resumeMutation` below) **before** the await, and guards every post-await local-state
  mutation / `props.clearRecords()` call with `if (surfaceRef.current !== initiatingSurface)
  return;` (or an equivalent per-branch check). Query invalidation using the captured
  `initiatingSurface` still runs even when stale — only local state and `clearRecords()` are
  guarded. Applies to:
  - `sendMessage`'s async IIFE (L189-254): capture `initiatingSurface` before
    `sendChatTurn(...)`; guard the `setPendingUser`/`setFallbackRecords`/`setSendError`/
    `setNeedsProvider` calls in the `then`/`catch`. The `finally` clearing `isSending` is also
    guarded (a stale completion must not touch the new surface's `isSending`).
  - `resumeMutation`: change `mutationFn` to `(vars: { threadId: string; surface: ChatSurface })
    => resumeChat(vars.threadId, vars.surface)`; call site becomes
    `resumeMutation.mutate({ threadId, surface: props.surface })`; `onSuccess`/`onError` receive
    `(_data, vars)` and guard `props.clearRecords()`/`setShowHistory`/`setPrivateMode`/
    `setPrivateEnded`/`setReviewThreadId` behind `vars.surface === surfaceRef.current`; the
    `.threads(vars.surface)`/`.privacy(vars.surface)` invalidation is unguarded.
  - `startPrivateChat`'s async IIFE (L349-375): capture `initiatingSurface` before
    `clearChat({ incognito: true, surface: initiatingSurface })`; guard
    `setFallbackRecords`/`props.clearRecords()`/`setPrivateMode` in the success branch and
    `setPrivateActivationError` in the catch; `setActivatingPrivate(false)` in `finally` is also
    guarded (must not flip the new surface's activating flag).
  - Queued Stop drain: change `drainAfterStopText` state type from `string | null` to
    `{ readonly text: string; readonly surface: ChatSurface } | null`; `stopSending` stores
    `{ text: queuedText, surface: props.surface }`; the drain effect
    (L256-261) discards (sets `null`, does not call `sendMessage`) when
    `drainAfterStopText.surface !== props.surface`, otherwise drains as today.
- `switchToNewModelChat` changes signature to `(surface: ChatSurface) => void`: if
  `surface === surfaceRef.current`, run today's full `startNewChat()` body (local resets +
  `clearChat({ surface })` + `clearRecords()` + invalidate); otherwise only
  `void clearChat({ surface })` (clear the stale server session, touch no local state). This
  signature change is consumed by Phase 3's `ChatModelPill` prop threading — Phase 2 updates the
  signature and its one current call site; Phase 3 wires the new caller.

### Tests

Add to `tests/unit/chat-drawer-surface.test.tsx` (same file Phase 1 created) the spec's 4
surface-flip cases (spec lines 248-260), using the same mounted drawer instance across a
`rerender` with a new `surface` prop:

1. Populate `fallbackRecords` via a completed send, create a `pendingUser` via a deferred send,
   enter private mode and a history-review state, then rerender with a different surface. Assert:
   old fallback/pending text absent from `effectiveRecords`, private banner/end state absent,
   `reviewThreadId` cleared (no thread selected), `showHistory` false. Fails today: no reset effect
   exists, so all five carry over.
2. Resolve and reject deferred old-surface `sendChatTurn` promises after the surface prop changes.
   Assert neither settlement appends a record, restores `pendingUser`, surfaces `sendError`,
   invalidates the new surface's `.threads()` key, or leaves `isSending` true for the new surface.
   Fails today: `sendMessage`'s IIFE has no surface guard, so a late resolve always mutates state.
3. Resolve a deferred `resumeChat` and a deferred `startPrivateChat` after a flip, and drain a
   queued Stop stored before the flip. Assert none of the three clears, repopulates, or submits
   through the new surface (e.g., the drain must not call `sendChatTurn` at all post-flip). Fails
   today: none of the three paths check surface before mutating.
4. Flip module A → module B and default → module (not only module → default); assert all six
   state fields listed above reset in both directions. Fails today: no reset effect.

### Verification (unpiped)

```bash
pnpm vitest run tests/unit/chat-drawer-surface.test.tsx > /tmp/1533-phase2.log 2>&1; echo "EXIT=$?"
pnpm exec tsc --noEmit > /tmp/1533-phase2-tsc.log 2>&1; echo "EXIT=$?"
```
Expected `EXIT=0` for both (the `tsc` run is the type-safety note from the relay — `.tsx` files
aren't per-file typechecked (#1335) but this phase also touches no `.ts` production file, so this
run is a repo-wide sanity check before Phase 3 adds one).

### Kill gate (owner: self)

If the surface-flip cases can't be made to pass without reintroducing a second surface source
(e.g. a context or store) — which the spec explicitly forbids (§1: "Do not introduce a new store,
context, hook, callback adapter") — stop and escalate to Coordinator rather than improvising a
workaround outside the ref/effect mechanism above.

## Phase 3 — `ChatModelPill` surface + `switchChatProvider` client param

### Changes

- `apps/web/src/api/client.ts`: `switchChatProvider(surface?: ChatSurface): Promise<void>` —
  `const query = surface ? \`?surface=${encodeURIComponent(surface)}\` : ""`; POST to
  `` `/api/chat/switch${query}` ``. `ChatSurface` is already imported in this file (L99).
- `apps/web/src/chat/chat-model-pill.tsx`:
  - Import `type ChatSurface` from `@moss/shared`.
  - Add `readonly surface: ChatSurface;` to props (L24-28).
  - Change `mutation`'s `mutationFn` to `async (vars: { choice: ModelChoice; surface: ChatSurface
    }) => {...}` using `vars.choice`/`vars.surface` in place of the current bare `choice` param;
    same-provider branch calls `switchChatProvider(vars.surface)`; cross-provider branch calls
    `props.onCrossProviderSwitch(vars.surface)`; invalidation becomes
    `queryKeys.chat.threads(vars.surface)` (chatModelOverride invalidation is surface-agnostic,
    unchanged).
  - `selectChoice`: `mutation.mutate({ choice, surface: props.surface })` in place of
    `mutation.mutate(choice)`.
  - `props.onCrossProviderSwitch` type becomes `(surface: ChatSurface) => void`.
- `apps/web/src/chat/chat-drawer.tsx`: `<ChatModelPill>` usage (L576-580) gains
  `surface={props.surface}`; `onCrossProviderSwitch={switchToNewModelChat}` unchanged (already
  `(surface: ChatSurface) => void` per Phase 2).

### Tests

- New `tests/unit/chat-model-pill-surface.test.tsx`: render `ChatModelPill` with
  `surface={moduleSurface}`, choose a same-provider model, assert at runtime:
  `expect(switchChatProvider).toHaveBeenCalledExactlyOnceWith(moduleSurface)` and
  `queryClient`'s `.threads` invalidation call included `queryKeys.chat.threads(moduleSurface)`.
  Fails today: the file/component don't accept or forward a surface. Also assert `ChatDrawer`
  passes its exact `props.surface` into the pill's `surface` prop (render `ChatDrawer` directly
  with mocked `ChatModelPill` capturing props, matching the `chat-drawer-surface.test.tsx`
  harness), and that the cross-provider callback receives that same captured surface. Resolve a
  same-provider mutation after a `surface` prop flip and assert the continuation does not
  invalidate or clear the newly rendered surface's threads key.
  Leave `tests/unit/chat-model-pill.test.ts` unchanged (spec explicit).
- Extend `tests/unit/chat-api-client.test.ts`: one new assertion —
  `switchChatProvider(moduleSurface)` posts to
  `` /api/chat/switch?surface=<encodeURIComponent(moduleSurface)> ``; retain the existing
  unsurfaced-call assertion against bare `/api/chat/switch`. Fails today: `switchChatProvider`
  takes no argument, so the surfaced call can't be expressed.

### Verification (unpiped)

```bash
pnpm exec tsc --noEmit > /tmp/1533-phase3-tsc.log 2>&1; echo "EXIT=$?"
pnpm vitest run tests/unit/app-shell-chat-surface.test.tsx tests/unit/chat-drawer-surface.test.tsx tests/unit/chat-model-pill-surface.test.tsx tests/unit/chat-api-client.test.ts > /tmp/1533-phase3.log 2>&1; echo "EXIT=$?"
```
Expected `EXIT=0` for both. Run `tsc` first per the relay's type-safety note — `client.ts` is a
production `.ts` file this phase edits, and `vitest`'s transform alone won't catch
`noUncheckedIndexedAccess`/`TS2352`-class errors in it.

### Kill gate (owner: self)

If the pill/client changes can't stay inside the 9-file boundary (e.g. a shared mutation-variables
type needs to live outside `chat-model-pill.tsx`), stop and escalate — do not add a 10th file.

## Phase 4 — full gate + live-path proof (no new code, evidence only)

- Run the full focused suite plus `pnpm verify:foundation` under the coordinator's exclusive gate
  slot and isolated DB procedure (per `verify-gate` skill — never run ad hoc):
  ```bash
  pnpm vitest run tests/unit/app-shell-chat-surface.test.tsx tests/unit/chat-drawer-surface.test.tsx tests/unit/chat-model-pill-surface.test.tsx tests/unit/chat-api-client.test.ts > /tmp/1533-focused.log 2>&1; echo "EXIT=$?"
  pnpm verify:foundation > /tmp/1533-gate.log 2>&1; echo "EXIT=$?"
  ```
  Expected `EXIT=0` for both.
- Live-path proof: spec's "Live-path proof: action request without reload" section (lines
  296-319) — 7 numbered steps, driven through the job-search module's "Change in chat" action
  (`external-modules/job-search/src/web/screens/profile.tsx:168`,
  `external-modules/job-search/src/web/root.tsx:12,455`,
  `external-modules/job-search/src/worker/registry.ts:76`). Capture network evidence (matching
  surface on the EventSource URL and the POST body), a screenshot of the approval card within a
  5-second observation bound, and the default-drawer regression pass (normal send + one
  private-chat start/end cycle). REST rehydration after reload does **not** satisfy this — must be
  live, no reload.
- Sensitive-tier invariant check (per the handoff's exit criteria): confirm the diff touches no
  `AccessContext`, RLS, persistence, or gateway-contract file — the 9-file boundary makes this a
  `git diff --stat` read, not a judgment call.
- `coordinated-wrap-up` to a draft PR; do not merge.

## Non-goals (restated from spec, binding on this plan)

No confirmation-timeout change, no REST-rehydration change, no module-surface hashing/validation
change, no multi-stream support, no cross-surface transcript migration, no `today-page.tsx` change,
no approval-card/private-chat redesign, no issue/board mutation bundled with this build.
