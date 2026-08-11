# #1533 — Keep chat drawer commands on the subscribed surface

**Date:** 2026-08-10

**Status:** Fable-reviewed, re-grounded after all predecessors landed, and implementation-ready

**Issue:** [#1533](https://github.com/motioneso/moss/issues/1533)

**Grounded on:** `origin/main` = `71149d36e`

**Implementation tier:** Sensitive — this changes routing for chat commands and approval events,
but not authorization, persistence policy, or the gateway contract.

## Problem

The shell already knows which chat surface is active. A mounted external module publishes an opaque
module surface such as `m-3abde0ba43fbd3aa`; on current `origin/main`, `AppShell` passes that value
to `useChatStream` and passes explicit `DEFAULT_CHAT_SURFACE` for the default drawer. The shell
renders the subscribed records in `ChatDrawer`, but the drawer does not receive the surface, so its
`sendMessage` calls `sendChatTurn` without one. The server normalizes that omission to `drawer`.

The submitted turn therefore launches under `<actor>:drawer`, and its MCP token carries that
default `chatSessionId`. When a tool needs confirmation, `ChatGatewayNotifier` parses the token's
session id and emits the immediate `action_request` to the default drawer subscriber bucket. The
browser is listening to the module bucket, so no card appears. A reload later makes the pending row
visible only because REST rehydration fetches it; the approximately 150-second HTTP duration is the
native confirmation timeout, not event latency.

This is not limited to the POST. `ChatDrawer` also omits its surface from Stop, New Chat, model
switch, history, resume, and privacy calls. Fixing only `sendChatTurn` would leave one drawer
controlling two sessions: for example, Stop or a same-provider model switch would target the
default turn while the corrected send runs on the module surface. It would also make private chat
and local fallback state ambiguous across a surface flip. The smallest safe fix is to make the
drawer's already-rendered surface explicit once and reuse it for every drawer operation and local
state lifetime.

## Desired invariant

For one rendered `ChatDrawer`, all of these values are identical:

```text
AppShell activeSurface
  = useChatStream(surface)
  = ChatDrawer.surface
  = every drawer chat command's surface
  = surface in the server session key and MCP token
  = ChatGatewayNotifier destination surface
```

No client or server layer may substitute `drawer` after `AppShell` has selected a module surface.
The only defaulting point is `AppShell`: no active module means the explicit
`DEFAULT_CHAT_SURFACE` value.

## Existing end-to-end flow

1. An external module calls `assistantSurface.setSurfaceKey(key)`.
2. `createAssistantSurfaceHandle` combines the host-bound module id and opaque key through
   `moduleChatSurface`, then publishes the resulting validated `ChatSurface`.
3. `AppShell` reads it with `useSyncExternalStore`, falls back to `DEFAULT_CHAT_SURFACE`, and passes
   that explicit `activeSurface` to `useChatStream`. #1533 reuses the same value for `ChatDrawer`.
4. `ChatDrawer.sendMessage` currently calls `sendChatTurn(text, attachmentIds)` and loses the value.
5. `sendChatTurn` already supports a fourth `surface` argument and serializes it into
   `POST /api/chat/turn`.
6. `readTurnBody` validates/defaults the surface. `ChatSessionManager.submitTurn` and
   `ensureSession` key the engine with `surfaceSessionKey(actorUserId, surface)`; token minting uses
   that composite key as `chatSessionId`.
7. The AI gateway obtains the same `chatSessionId` from the token and emits `action_request` before
   waiting for human confirmation.
8. `ChatGatewayNotifier.emit` parses the actor and surface, then `ChatSessionManager.injectRecord`
   fans out only to subscribers of that exact composite key.
9. `/api/chat/stream?surface=...` registered the browser in that bucket through `useChatStream`.

Steps 5–9 are already surface-correct. The broken seam is the shell-to-drawer interface in steps
3–4.

## Locked design

### 1. Make the drawer surface explicit

Add a required `readonly surface: ChatSurface` prop to `ChatDrawer`. `AppShell` passes its existing
`activeSurface` value—the same value passed to `useChatStream` after PR #1494. Do not introduce a
new store, context, hook, callback adapter, or surface derivation inside the drawer.

The prop is required, not optional. Optional would preserve the exact omission that caused #1533
and make future call sites silently fall back to the wrong bucket.

### 2. Reuse that surface for existing drawer commands

Pass `props.surface` through the interfaces that already accept it:

- `sendChatTurn(text, attachmentIds, undefined, props.surface)`
- `cancelChatTurn(props.surface)`
- `clearChat({ surface: props.surface })`, including the incognito form
- `endPrivateChat(props.surface)`
- `getChatPrivacyState(props.surface)`
- `listChatThreads(props.surface)`
- `listChatThreadMessages(threadId, props.surface)`
- `resumeChat(threadId, props.surface)`
- `switchChatProvider(props.surface)` through `ChatModelPill`

Use the existing surface arguments on `queryKeys.chat.threads` and
`queryKeys.chat.messages`. Change `queryKeys.chat.privacy` into the same small surface-keyed
function shape, because a cached default-drawer privacy result must never be reused for a module
surface. The resume-success, send-success, New Chat, private-chat start, and model-switch thread
invalidations all use `queryKeys.chat.threads(props.surface)`; privacy invalidation uses the matching
surface-keyed privacy key.

Extend `switchChatProvider` with an optional `surface?: ChatSurface`, using the existing
`?surface=` route shape and preserving the unsurfaced default call. Add required
`readonly surface: ChatSurface` to `ChatModelPill`; `ChatDrawer` passes `props.surface`, the
same-provider branch calls `switchChatProvider(props.surface)`, and its thread invalidation uses
`queryKeys.chat.threads(props.surface)`. The cross-provider callback continues through
`ChatDrawer.startNewChat`, which is already surface-bound by the calls above.

Keep `beaconEndPrivateChat` on the default drawer path. Private chat is intentionally drawer-only,
and the control is unavailable on module surfaces as described below; no beacon contract change is
needed.

### 3. Keep private chat drawer-only

`ChatSessionManager` already rejects an incognito session on any surface other than
`DEFAULT_CHAT_SURFACE`. Match that server invariant in the UI: render the private-chat control only
when `props.surface === DEFAULT_CHAT_SURFACE`, and never offer incognito creation on a module
surface. When the surface changes, privacy state is read under the new surface-keyed query and the
local `privateMode` flag must not carry across surfaces.

This is not a new privacy feature. It prevents the routing fix from presenting a module-surface
turn as private while the server persists it as an ordinary module turn.

The private-mode `beforeunload` effect remains registered only while `privateMode` is true. A
surface reset to a module sets it false, so React's effect cleanup removes the beacon handler; the
SPA surface switch must not fire a default-drawer beacon. Closing the old default EventSource
unsubscribes its subscriber, which schedules the existing private-detach cleanup. With no private
subscriber, `reapIdle` also stops exempting that session and may end it through the existing
private cleanup path. Returning during the detach grace period re-subscribes and cancels the timer.
No backend lifecycle change is needed.

### 4. Reset drawer-local state atomically on a surface change

Add one effect keyed by `props.surface` that resets all state containing or selecting records from
the prior surface:

- `fallbackRecords` to `[]`
- `pendingUser` to `null`
- `privateMode` and `privateEnded` to `false`
- `reviewThreadId` to `null`
- `showHistory` to `false`

Also clear transient send/drain/error flags needed to prevent the old surface from blocking the new
one. Do not wait for the new privacy/history queries to settle before clearing old state.

An effect alone is insufficient because an old-surface promise can settle after the flip and mutate
the new surface. Keep the latest surface in a ref updated on render. Every async drawer operation
captures its initiating surface, uses that value for the request and query invalidation, and checks
the ref before any post-await local-state mutation or `props.clearRecords()` call. This applies to
send, resume, private activation, and the cross-provider New Chat continuation. A stale completion
may settle its old-surface request and invalidate only old-surface query keys, but it must not append
records, restore optimistic/private/history state, surface an old error, clear the new live stream,
or change new-surface sending/activation state. Do not cancel or redirect an already-submitted
old-surface request.

Store a queued Stop drain with the surface that produced it and discard it when that surface no
longer matches `props.surface`; clearing the queue in the reset effect alone is insufficient because
the pre-reset drain effect can run from the same render. Pass the captured surface through
`ChatModelPill`'s mutation variables and cross-provider callback so a late model-switch continuation
can clear its old server session without clearing the newly rendered drawer.

### 5. Leave backend routing alone

Do not edit `sendChatTurn`'s interface, route parsing, session-key construction, token minting,
`ChatGatewayNotifier`, `ChatSessionManager` subscriber maps, SSE URLs, persistence, or RLS. Those
modules already preserve a supplied surface end to end. Adding a broadcast or default-subscriber
fallback would hide routing bugs and could expose one surface's transcript on another.

## Default drawer compatibility

Outside a module, `AppShell.activeSurface` is the explicit `DEFAULT_CHAT_SURFACE` (`drawer`). The
drawer will now send `surface: "drawer"` or `?surface=drawer` where some calls previously omitted
the field. This is wire-compatible: `normalizeChatSurface(undefined)` already produces the same
value, the session key remains `<actor>:drawer`, and thread/privacy persistence remains on the same
owner-scoped records.

The default drawer must retain:

- normal sends, attachments, Stop, New Chat, history, and resume;
- same-provider and cross-provider model switching on the active drawer session;
- private-chat start, restore, unload/end, and server-side non-persistence behavior;
- default approval-card SSE and PR #1494's reload rehydration;
- no module transcript after the module releases its surface.

## Privacy and security invariants

- A surface is a routing selector, not authorization. The server continues to derive
  `actorUserId` from the authenticated request and all repositories/RLS remain owner-scoped.
- The host derives module surfaces. External module code receives an opaque `setSurfaceKey`
  interface and cannot choose an actor id or raw subscriber bucket.
- No cross-surface broadcast, fallback injection, or transcript merge is allowed.
- Private/incognito chat remains available only on `DEFAULT_CHAT_SURFACE`; module turns are never
  labelled private or silently redirected to the default surface.
- Attachment lookup, ownership validation, vault handling, and the private-attachment rejection
  remain server-side and unchanged. The route checks privacy using the submitted surface: a module
  attachment is checked against that module surface, not an unrelated default-drawer private
  session. Module surfaces cannot enter incognito mode, so their owned attachments remain allowed
  and are persisted as ordinary module-turn metadata.
- MCP bearer tokens remain server/engine-only. The browser receives only the validated surface;
  no token, credential, prompt, or private tool input is added to responses or logs.
- Approval resolution remains owner-authorized by action id; this change only ensures the request
  event reaches the already-authorized surface subscriber.
- `AccessContext`, job payloads, migrations, module contracts, and provider selection are untouched.

## Regression tests

### Shell pairing: `tests/unit/app-shell-chat-surface.test.tsx`

Extend the existing `ChatDrawer` mock to capture its `surface` prop as well as records. Assert exact
equality with the mocked `useChatStream` argument in three cases:

1. With no module claim, both are `DEFAULT_CHAT_SURFACE`.
2. With `job-search` / `profile-1`, both are
   `moduleChatSurface("job-search", "profile-1")`.
3. After `setSurfaceKey(null)`, both return to `DEFAULT_CHAT_SURFACE` and the module records are no
   longer handed to the drawer.

These assertions fail if the shell ever subscribes and renders the drawer with different surface
values. Apply them on top of PR #1494's explicit-default expectations rather than restoring the old
`undefined` behavior.

### Drawer command routing: new `tests/unit/chat-drawer-surface.test.tsx`

Use the repository's established `react-test-renderer` + query-client pattern. Mock only network
interfaces and heavyweight child views needed to expose the real drawer callbacks. Render an open
drawer with a real module `ChatSurface`, invoke the real composer's `onSend`, and assert:

```ts
expect(sendChatTurn).toHaveBeenCalledExactlyOnceWith(
  "Remote only",
  undefined,
  undefined,
  moduleSurface
);
```

In the same focused suite, invoke Stop and New Chat and assert `cancelChatTurn(moduleSurface)` and
`clearChat({ surface: moduleSurface })`. Assert the initial privacy/thread reads receive the module
surface and that the private-chat control is absent. A default-drawer case asserts the private
control remains present and a send uses `DEFAULT_CHAT_SURFACE`.

Add surface-flip assertions using the same mounted drawer instance:

1. Populate `fallbackRecords` with a completed send, create a `pendingUser` with a deferred send,
   enter private/history review state where legal, then update the prop to a different surface.
   Assert old fallback/pending text is absent, the private banner/end state is absent,
   `reviewThreadId` no longer selects a thread, and history is closed.
2. Resolve and reject deferred old-surface sends after the flip. Neither completion may append an
   old reply, restore the optimistic row, surface an old error, invalidate the new surface's
   queries, or block a new-surface send.
3. Resolve deferred resume and private-activation requests after a flip and drain a queued Stop
   from the old surface. None may clear, repopulate, or submit through the new surface.
4. Flip module A → module B and default → module, not only module → default; all six bound state
   fields reset regardless of direction.

### Model switching: new `tests/unit/chat-model-pill-surface.test.tsx`

Leave the existing pure-function `chat-model-pill.test.ts` suite unchanged. In the new React/query-
client suite, render `ChatModelPill` with `surface={moduleSurface}`, choose a same-provider model,
and assert at runtime that `switchChatProvider` receives `moduleSurface` and invalidation receives
`queryKeys.chat.threads(moduleSurface)`. Also assert at runtime that `ChatDrawer` passes its exact
surface into the pill prop, and that the cross-provider callback clears the same captured surface.
These must be call-argument assertions rather than facts inferred from prop types because `.tsx`
tests are not typechecked in this repository (#1335). Resolve a model mutation after a prop flip and
assert that its continuation does not clear the newly rendered surface.

### Client URL: `tests/unit/chat-api-client.test.ts`

Add one request-shape assertion that `switchChatProvider(moduleSurface)` posts to
`/api/chat/switch?surface=<encoded module surface>`. Retain an unsurfaced call assertion for
`/api/chat/switch`; the optional argument is backward compatible for default-only callers.

Do not add tests for `sendChatTurn` serialization or server session/notifier routing: existing
`chat-api-client`, `assistant-surface-handle`, chat live manager, and gateway tests already cover
those interfaces. The new serialization assertion is only for the newly surfaced model-switch
client. All other regressions belong at the previously missing drawer seam.

### Verification commands

Run the focused files first, then the repository gate using the coordinator's exclusive gate
slot and isolated database procedure:

```bash
pnpm vitest run tests/unit/app-shell-chat-surface.test.tsx tests/unit/chat-drawer-surface.test.tsx tests/unit/chat-model-pill-surface.test.tsx tests/unit/chat-api-client.test.ts
pnpm verify:foundation
```

No DB-touching command may run outside the project's gate coordination rules.

## Live-path proof: action request without reload

This issue is user-facing and cannot merge on unit tests alone.

1. Start from a live dev instance with the job-search module installed/enabled, a working chat
   model, and a profile whose page claims a module surface.
2. Open Job Search → Profile → **Change in chat**. Submit a unique criteria change from the real
   drawer/composer with Enter; use the real `job-search.criteria.set` confirmation path.
3. Do not reload, navigate, close/reopen the drawer, or wait for the 150-second native confirmation
   timeout.
4. Capture browser network evidence showing the live EventSource and the POST use the same module
   surface (`/api/chat/stream?surface=m-...` and request body `surface: "m-..."`).
5. Capture a screenshot of the real approval card visible while that POST is still awaiting human
   confirmation. The card should appear promptly; use five seconds as the observation bound, not
   the 150-second denial timeout.
6. Deny/cancel the card in the UI so the POST settles. Record the action row/request id and bounded
   API log lines tying the screenshot to this run, without recording tokens or private input.
7. Without a module mounted, open the ordinary drawer and send a harmless prompt. Confirm the
   default stream/send remain on `drawer` and the reply appears normally. Start/end a private chat
   once to confirm the drawer-only control remains functional.

The PR comment must state explicitly that the card rendered **without reload**, include the real
exit codes, screenshot/run artifact, matching surface evidence, and teardown. REST rehydration after
reload is not acceptable proof for #1533.

## Dependencies and collision order

All four Wave 5 predecessors are now on `origin/main`. Implement from `71149d36e` or later; do not
reintroduce their superseded shell, drawer, persona, or action-label behavior:

| PR    | Relationship to #1533                                                                                                                                                                                                          |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| #1494 | Landed as `b79b323cf`. It edits `app-shell.tsx`, `app-shell-chat-surface.test.tsx`, and `use-chat-stream` expectations to make the default surface explicit. Preserve that behavior and add send/drawer pairing on top.        |
| #1482 | Landed as `71149d36e`. It edits `chat-drawer.tsx` and adds the route-based availability regression. Apply the surface prop/calls to this final drawer without undoing availability or persona-prefetch work.                   |
| #1493 | Landed as `128a5bed6`. It changes `ChatSessionManager` persona/neutral-dir behavior on the same `(actor, surface)` session key. Treat its composite-key behavior as an invariant; do not edit backend files.                   |
| #1492 | Landed as `9883555d5`. It changes the approval request's human-readable label and provides the job-search confirmation path used for live proof. Routing remains independent of label text; run proof on this merged behavior. |

Do not stack #1533 onto another PR branch or introduce a second surface source.

## One-session implementation boundary

The implementation is bounded to one worktree and one session from current `origin/main`:

- `apps/web/src/shell/app-shell.tsx`
- `apps/web/src/chat/chat-drawer.tsx`
- `apps/web/src/chat/chat-model-pill.tsx`
- `apps/web/src/api/client.ts`
- `apps/web/src/api/query-keys.ts`
- `tests/unit/app-shell-chat-surface.test.tsx`
- `tests/unit/chat-drawer-surface.test.tsx` (new)
- `tests/unit/chat-model-pill-surface.test.tsx` (new)
- `tests/unit/chat-api-client.test.ts`

Expected production change: one required prop plus reuse of existing optional surface parameters and
one surface-keyed privacy query, one optional client parameter, pill prop threading, and one
surface-change reset/late-completion guard. No new package, dependency, module, database object,
endpoint, shared DTO, feature flag, state store, or abstraction.

## Non-goals

- No change to confirmation timeout or native confirmation policy.
- No change to pending-action REST rehydration (#1494/#1253).
- No change to module surface hashing, validation, or external-module host contracts.
- No new multi-stream support or simultaneous default/module drawer.
- No cross-surface transcript migration or history merge.
- No change to `today-page.tsx`'s unsurfaced thread invalidation. Its evening-interview call is a
  default-drawer-only path, and `queryKeys.chat.threads()` already names that default cache.
- No redesign of the drawer, approval card, or private-chat experience.
- No issue/board mutation or implementation bundled with this spec.

## Exit criteria

- Shell tests prove the stream and drawer receive the same exact default/module surface.
- Drawer tests prove send, Stop, New Chat, history/privacy reads, and resume stay on the drawer's
  supplied surface; default/private compatibility remains.
- Surface-flip tests prove all old fallback, optimistic, privacy, and history state clears, and a
  late old-surface send completion cannot repopulate or block the new surface.
- Model-pill/client tests prove same-provider switch and thread invalidation use the drawer surface,
  while the optional unsurfaced client call remains default-compatible.
- Focused tests and the full coordinated gate are green.
- A real job-search `action_request` card renders on the module surface without reload and before
  the confirmation timeout, with matching request/stream evidence posted to the PR.
- No backend routing, authorization, persistence, RLS, token, or module contract changes.
