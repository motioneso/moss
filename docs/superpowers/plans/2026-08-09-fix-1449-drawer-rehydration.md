# Plan — #1449: default chat drawer never rehydrates approval cards

**Spec:** `docs/superpowers/specs/2026-08-09-wave-5-chat-surface-correctness.md` (Lane A section)
**Issue:** #1449 — "Default chat drawer never rehydrates approval cards (surface is always null in
the shell)"
**Risk tier:** sensitive
**Branch:** `w5a-chat-surface` (existing worktree, off `origin/main`)

## Problem (verified against branch)

`apps/web/src/shell/app-shell.tsx:139` computes `activeSurface = activeModuleSurfaceBranded ??
DEFAULT_CHAT_SURFACE` but `app-shell.tsx:144-146` passes a different expression into the hook:

```ts
const { records, clearRecords, streamErrorCount } = useChatStream(
  activeModuleSurfaceBranded ?? undefined
);
```

`useChatStream` (`apps/web/src/chat/use-chat-stream.ts:88-89`, `surface?: ChatSurface`) has a
rehydration effect gated `if (!surface || !enabled) return;` (`use-chat-stream.ts:133`) that calls
`listChatThreads(surface)` (`:138`) and (via the thread) approval-card state from #1253. Passing
`undefined` for the default drawer (no module surface claimed) means this effect's guard is always
true and the fetch never runs — approval cards never rehydrate on the default drawer on reload.

`DEFAULT_CHAT_SURFACE` is `"drawer"` (`packages/shared/src/chat-api.ts:12`), already imported in
`app-shell.tsx:62`, and `normalizeChatSurface` (`chat-api.ts:17`) already maps an absent/undefined
surface to `DEFAULT_CHAT_SURFACE` server-side — so passing the defined `activeSurface` string
instead of `undefined` is a strict no-op on the wire (same resolved surface, now made explicit
client-side) and a pure caller-side fix.

## Seams check (file:line)

- `activeSurface` — already computed and correctly defaulted, `app-shell.tsx:139`. No new
  computation needed, only reuse at the call site.
- `useChatStream(surface?: ChatSurface)` signature — `use-chat-stream.ts:88-89`. Accepts a
  `ChatSurface` or `undefined`; `activeSurface` (branded `ChatSurface`) satisfies this without a
  cast.
- Rehydration effect dependency array `[enabled, surface]` — `use-chat-stream.ts:130` (SSE
  connect effect) and `:169` (rehydration effect). Passing a stable, always-defined `activeSurface`
  string does not change re-run cadence versus the current `activeModuleSurfaceBranded` value —
  both are `useSyncExternalStore`-derived and change only when the module surface claim changes.
- `chatStreamUrl(surface)` — `use-chat-stream.ts:104`. Already takes `surface?: ChatSurface`;
  passing `"drawer"` explicitly instead of `undefined` produces `?surface=drawer` on the SSE URL
  instead of an absent query param. Server-side `normalizeChatSurface` treats these identically
  (`chat-api.ts:17`), so no behavior change, only an explicit param on the wire.
- No changes needed in `use-chat-stream.ts` (confirmed by full prior read in relay handoff — "fix
  the caller, not the hook").

## Non-goals

No change to `useChatStream`'s signature, effects, or SSE URL construction logic. No change to
module-surface derivation (`activeModuleSurfaceBranded`, `activeModuleSurface`,
`useSyncExternalStore` wiring). No server-side change — `normalizeChatSurface` already treats
absent and `"drawer"` identically.

## The fix

One-line change, `app-shell.tsx:144-146`:

```ts
const { records, clearRecords, streamErrorCount } = useChatStream(activeSurface);
```

(Replaces `useChatStream(activeModuleSurfaceBranded ?? undefined)`.)

## Test cases (`tests/unit/app-shell-chat-surface.test.tsx`)

Three existing tests currently codify the bug by asserting `lastSurfaceArg()` is `undefined` for
the no-module-surface (default drawer) case. Change each to assert `DEFAULT_CHAT_SURFACE`
(imported from `@moss/shared`, value `"drawer"`):

1. **`"opens the drawer surface by default"`** (`:130-133`) — change
   `expect(lastSurfaceArg()).toBeUndefined()` to
   `expect(lastSurfaceArg()).toBe(DEFAULT_CHAT_SURFACE)`. Fails against current code (`app-shell.tsx`
   passes `undefined`); passes once the fix lands.

2. **`"hands the drawer nothing once the module releases the surface"`** (`:182-192`) — change the
   `expect(lastSurfaceArg()).toBeUndefined()` assertion (`:190`) to
   `expect(lastSurfaceArg()).toBe(DEFAULT_CHAT_SURFACE)`. The second assertion
   (`chatDrawerRecordsCalls.at(-1)).toEqual([])`, `:191`) is unchanged — it tests
   `recordsForSurface` drawer isolation, not the surface argument, and stays correct because the
   mock's default `records: []` doesn't depend on which defined surface string was passed.

3. **`"returns the shell to the drawer once a module releases its surface"`** (`:194-202`) — change
   `expect(lastSurfaceArg()).toBeUndefined()` (`:202`) to
   `expect(lastSurfaceArg()).toBe(DEFAULT_CHAT_SURFACE)`.

4. **New regression test — `"passes a defined surface to useChatStream so the default drawer's
rehydration effect can run"`** — added directly after test 1. Renders with no module surface
   claimed (`renderWithModuleMount(undefined, null)`) and asserts
   `expect(lastSurfaceArg()).toBeDefined()` **and** `expect(lastSurfaceArg()).not.toBeUndefined()`
   independent of the `DEFAULT_CHAT_SURFACE` equality check in test 1 — this is the spec's exit
   criterion "a shell-level test that fails if the default drawer stops fetching," stated as its
   own case so it keeps failing on any future regression that passes a defined-but-wrong value
   through, not only a literal `undefined`. Fails against current code (`lastSurfaceArg()` is
   `undefined`); passes once the fix lands.

Import `DEFAULT_CHAT_SURFACE` from `@moss/shared` at the top of the test file (already exported,
`chat-api.ts:12`, and already the same package the file imports `normalizeChatSurface` from at
`:24`).

`use-chat-stream.test.tsx` needs no changes (reference-only, already read in full per relay
handoff).

## Verification

```bash
pnpm exec vitest run tests/unit/app-shell-chat-surface.test.tsx > /tmp/1449-unit.log 2>&1; echo "EXIT=$?"
```

Expected: `EXIT=0`, all 9 cases pass (6 unchanged + 3 modified + 1 new), including the 4 assertions
that fail against current `main`.

Full gate (isolated DB, via `verify-gate` skill) at wrap-up:

```bash
pnpm verify:foundation > /tmp/1449-gate.log 2>&1; echo "EXIT=$?"
```

Expected: `EXIT=0`.

## Determinism boundary

Pure wiring fix — passes an already-computed, deterministic string (`activeSurface`) through an
existing hook parameter. No model output involved anywhere in this change; nothing in the fix or
its tests touches AI-generated content.

## Kill gate

None needed — single phase, single file pair (`app-shell.tsx` + its test), ~10 lines changed. If
the new regression test (case 4) cannot be made to fail against current `main`, stop and escalate
to `Coordinator` rather than force a green test — owner: this build agent.

## Live-path proof (wrap-up)

Seed a pending approval row for a test user, sign in, open the default (drawer) chat surface with
no module active, reload the page, reopen the drawer. Expect: the approval card is present, and the
API access log shows a `GET` request for pending action requests / `listChatThreads` fired on
mount (not only after a manual send). Record as a `gh pr comment`, or report **code-complete,
unverified** if no live dev instance is reachable.
