# Plan: 1139-D — keep private chat closed during focus refetch

GitHub #1521 (child of #1139). Part of #1521.
Spec: `docs/superpowers/specs/2026-08-10-1139-chat-export-ui-followups.md`, "Child 1139-D" section.
Dependency #1520/PR #1666 (1139-C) merged 2026-08-17.

## Seams check (verified on this tree)

- `privateModeDecidedLocally` ref: `apps/web/src/chat/chat-drawer.tsx:91`. Set `true` by
  `startPrivateChat` (line 415) and `closePrivateChat` (line 441). Reset to `false` only on
  surface change (line 191, inside the `[props.surface]` effect at 189-204).
- Privacy-query success effect that the ref guards: `chat-drawer.tsx:99-102` — once the ref is
  true, this effect permanently no-ops for the current surface, regardless of what the query
  refetches.
- `closePrivateChat` (chat-drawer.tsx:440-447): synchronous, does not await `endPrivateChat`,
  never invalidates `queryKeys.chat.privacy`, has no catch/failure branch. Confirmed no other
  call site touches this query after close.
- `queryKeys.chat.privacy(surface?)`: `apps/web/src/api/query-keys.ts:86` — key is
  `["chat", "privacy", surface ?? "drawer"]`.
- `endPrivateChat(surface?)`: `apps/web/src/api/client.ts:976-979` — POST
  `/api/chat/private/end${surface query}`, returns void, throws on non-2xx (via `requestJson`).
- `surfaceRef`: `chat-drawer.tsx:66-67`, kept current every render. Existing race-guard pattern
  used by `startPrivateChat` (line 423, 428, 433): capture `initiatingSurface` before the async
  call, check `surfaceRef.current === initiatingSurface` before applying results.
- `privacyStateQuery`: `chat-drawer.tsx:93-97`, plain `useQuery`, no per-query
  `refetchOnWindowFocus` override.
- Global `QueryClient`: `apps/web/src/main.tsx:16-24` sets `refetchOnWindowFocus: false` for all
  queries. Grepped `apps/web/src` for `visibilitychange`/`focus` listeners touching this query —
  none found (only `packages/sports/src/web/sports-page.tsx:96`, unrelated page, already
  overrides `refetchOnWindowFocus` locally — confirms the override is an established, safe
  per-query pattern, not a new one).
- e2e mock for `GET /api/chat/privacy`: `tests/e2e/mock-chat-api.ts:71-79`, returns
  `{ incognito: state.incognito ?? false }` from `MockChatApiState.incognito` (static per test).
  No existing mock route for `POST /api/chat/private/end` — grepped, none found. No existing e2e
  test exercises `closePrivateChat` / the "End" button at all — grepped `tests/e2e/chat-drawer.spec.ts`
  for "private" and "End", no hits.
- Existing race-test pattern to reuse: `tests/e2e/chat-drawer.spec.ts:98-146` ("private
  activation blocks send...") — a `clearGate`-style held-open promise plus `page.route` override
  registered after `mockApi`, which Playwright treats as higher precedence (comment at
  `mock-chat-api.ts:59-61`).

## Decision

Two independent gaps, both in scope for this child issue per its title
("...during focus refetch"):

1. `closePrivateChat` doesn't confirm the end-request against the server and can't recover from
   a failure.
2. The privacy query never refetches on focus today, so the spec's named regression scenario
   (a focus event whose privacy GET still returns `true` after close) has no real trigger to
   exercise — the child issue's title implies this query is supposed to refetch on focus.

Resolution: add a **second**, transient guard ref (`closingPrivateChatRef`) alongside the
existing permanent `privateModeDecidedLocally`. The existing ref keeps meaning "the user has
locally decided privacy for this surface" (unchanged, still permanent per surface). The new ref
means "an end-request is in flight right now" and is always cleared in a `finally`, so once the
close settles, the privacy-query effect resumes writing `setPrivateMode` from server truth again
— closing the gap where a failed close silently claims "closed" forever.

## Tasks

### Task 1 — `chat-drawer.tsx`: transient closing guard + await/invalidate in `closePrivateChat`

File: `apps/web/src/chat/chat-drawer.tsx`

- Add `const closingPrivateChatRef = useRef(false);` near `privateModeDecidedLocally` (~line 91).
- Privacy-query success effect (currently lines 99-102): also skip while
  `closingPrivateChatRef.current` is true, in addition to the existing
  `privateModeDecidedLocally.current` check.
- Rewrite `closePrivateChat` (lines 440-447) to:
  - Set `privateModeDecidedLocally.current = true` and `closingPrivateChatRef.current = true`
    synchronously (unchanged ordering intent: claim before the request goes out).
  - Apply the existing optimistic UI updates synchronously (`setPrivateMode(false)`,
    `setPrivateEnded(false)`, `props.clearRecords()`, `setFallbackRecords([])`) — unchanged
    behavior, so the "End" click still feels instant.
  - Capture `const initiatingSurface = props.surface;` before the async call (matches
    `startPrivateChat`'s pattern).
  - `await endPrivateChat(initiatingSurface)` inside an async IIFE (matching the existing
    `startPrivateChat` structure at lines 417-437), wrapped in `try`.
  - On failure: if `surfaceRef.current === initiatingSurface`, set `privateActivationError`
    (reuse the existing error-message state — no new UI state) so the failure is visible instead
    of silent.
  - In `finally`: if `surfaceRef.current === initiatingSurface`, clear
    `closingPrivateChatRef.current = false` and invalidate
    `queryClient.invalidateQueries({ queryKey: queryKeys.chat.privacy(initiatingSurface) })`.
    The subsequent refetch lands through the now-unguarded effect: success with `incognito:
false` confirms the close; success with `incognito: true` (server never actually ended it)
    or a network failure resurrects the true state instead of a stale "closed" UI.
  - Surface-change effect (lines 189-204): also reset `closingPrivateChatRef.current = false`,
    matching the existing reset of `privateModeDecidedLocally.current` on the same line.

Signature (unchanged, still no params, still returns `void`):

```ts
const closePrivateChat = () => {
  /* ... */
};
```

### Task 2 — `chat-drawer.tsx`: enable focus refetch for the privacy query only

File: `apps/web/src/chat/chat-drawer.tsx`, `privacyStateQuery` (lines 93-97).

- Add `refetchOnWindowFocus: true` to this one `useQuery` call. No change to `main.tsx`'s global
  default (stays `false` for every other query, matching the `sports-page.tsx:96` precedent of a
  local override rather than a global flip).

### Task 3 — e2e mock: add a route for `POST /api/chat/private/end`

File: `tests/e2e/mock-chat-api.ts`

- Extend `MockChatApiState` with an optional field to control the end-request's outcome, e.g.:
  ```ts
  /** Response for POST /api/chat/private/end. Defaults to 204 success. */
  endPrivateChatStatus?: number;
  ```
- Register a route in `registerMockChatRoutes` matching `url.pathname.endsWith("/api/chat/private/end")`,
  fulfilling with `state.endPrivateChatStatus ?? 204` (empty body on success; on a non-2xx
  status, any JSON body `requestJson` can parse as an error, e.g. `{ "error": "..." }`).

### Task 4 — e2e test: closing private chat re-confirms against a focus refetch

File: `tests/e2e/chat-drawer.spec.ts`

New test, placed after the existing "reloading the page restores private-mode..." test
(~line 168), following the `mockApi(...)` + `page.route` override convention from the
"private activation blocks send..." test (lines 98-146):

- **Test name:** `"closing private chat that fails server-side is not shown as closed after a
focus refetch"`.
- **Setup:** `mockApi` with `incognito: true` (start already in a server-confirmed private
  session, matching the "reloading the page restores..." test's setup). Register a
  `page.route` for `POST /api/chat/private/end` (after `mockApi`, so it takes precedence) that
  fulfills with a 500 status — the close request fails server-side.
- **Steps:**
  1. Load the drawer; assert the private banner ("Private chat: not saved to history...") is
     visible (server truth: `incognito: true`).
  2. Click the "End" button.
  3. Assert the banner disappears immediately (optimistic UI, unchanged behavior).
  4. Wait for the failed request to resolve, then assert `privateActivationError` text appears
     (the new failure branch) — confirms the failure isn't silent.
  5. Dispatch a browser focus event: `await page.evaluate(() => window.dispatchEvent(new Event("focus")))`.
     Confirmed no existing focus-dispatch helper exists anywhere in `tests/e2e/*.ts` (grepped for
     `dispatchEvent` / `new Event("focus")`, no hits) — this is the first test to need one, written
     inline rather than as a new shared helper (single call site).
  6. Assert the privacy query refetches (`GET /api/chat/privacy` called again — count via a
     `page.route` counter, or assert on network activity) and the banner reappears, showing
     `incognito: true` from server truth — proving the close's optimistic "closed" state does
     not survive a focus refetch when the server never actually closed it.
- **Why this fails against a broken implementation:** with the current code (guard never
  clears, no invalidate, no failure branch), step 4 has no error text to find, and step 6 either
  finds nothing to refetch (no `refetchOnWindowFocus`) or, if focus refetch is added without the
  new transient guard, the permanent `privateModeDecidedLocally` ref would keep it from
  reappearing at step 6 even if the refetch fires — either half of the fix missing fails this
  test.

## Determinism boundary

Not applicable — this fix touches only deterministic UI state driven by server responses to
`GET /api/chat/privacy` and `POST /api/chat/private/end`. No model output is involved.

## Verification

```bash
pnpm --filter @moss/web exec tsc --noEmit > /tmp/1521-typecheck.log 2>&1; echo "EXIT=$?"
```

Expected: `EXIT=0`.

```bash
pnpm exec playwright test tests/e2e/chat-drawer.spec.ts > /tmp/1521-e2e.log 2>&1; echo "EXIT=$?"
```

Expected: `EXIT=0`, including the new Task 4 test passing and all pre-existing tests in the file
still passing (in particular the two private-mode tests at lines 98-146 and 148-168, which touch
the same ref and effect this plan modifies).

Pre-push trio, unpiped, each with its own exit code check:

```bash
pnpm format:check > /tmp/1521-format.log 2>&1; echo "EXIT=$?"
pnpm lint > /tmp/1521-lint.log 2>&1; echo "EXIT=$?"
pnpm typecheck > /tmp/1521-typecheck-full.log 2>&1; echo "EXIT=$?"
```

Expected: `EXIT=0` for each.

## Kill gate

None — this is a scoped bug-fix child issue (two-task diff in one file plus one test file), not
a new surface. If Task 4's e2e test cannot be made to pass after a reasonable debugging pass (a
few iterations), stop and relay rather than reshaping the fix; the owner for that call is
whoever is driving this lane, escalate to the coordinator if it recurs.

## Coordinator confirmation

Coordinator confirmed all three parts (a)(b)(c) as originally proposed, including Task 2
(`refetchOnWindowFocus: true` on the privacy query): the spec's named regression scenario only
means something if a real browser focus event can trigger a refetch on this query, and the child
issue's own title implies focus refetch is supposed to happen here. No redirect — this plan is
final as written.
