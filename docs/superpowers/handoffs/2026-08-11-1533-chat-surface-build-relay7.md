# Relay 7 — #1533 chat-surface routing build

Continuation of `...-relay6.md` (superseded — Phase 2 tests done+committed, Phase 3 production
code done+committed, Phase 3 tests and Phase 4 remain).

## Status

- Branch `build/1533-chat-surface-routing`, worktree `~/Jarv1s/.claude/worktrees/1533-chat-surface-build`.
- Latest commits: `cd1cc64cf` (Phase 2 prod+tests, 10/10 vitest green, tsc green),
  `2c35c858d` (Phase 3 production: `ChatModelPill` surface prop, `switchChatProvider(surface?)`,
  `ChatDrawer` wiring — tsc green, existing `chat-model-pill.test.ts` +
  `chat-api-client.test.ts` still pass unmodified).
- Working tree: clean (both commits landed cleanly, `git show --name-only HEAD` confirmed each).
- `node_modules` already installed — never `pnpm install`.

## Immediate next action: Phase 3 tests (plan lines 235-291 in
`docs/superpowers/plans/2026-08-10-1533-chat-surface-send-routing.md`)

1. New `tests/unit/chat-model-pill-surface.test.tsx`: render with `surface={moduleSurface}`,
   choose a same-provider model, assert `switchChatProvider` called exactly once with
   `moduleSurface`, and `.threads(moduleSurface)` invalidated. Also render `ChatDrawer` with a
   mocked `ChatModelPill` capturing props (reuse `chat-drawer-surface.test.tsx`'s harness) to
   assert `ChatDrawer` forwards its exact `props.surface`. Resolve a same-provider mutation after
   a `surface` prop flip and assert it does NOT invalidate/clear the new surface's threads key.
2. Extend `tests/unit/chat-api-client.test.ts`: one new case —
   `switchChatProvider(moduleSurface)` posts to
   `/api/chat/switch?surface=<encodeURIComponent(moduleSurface)>`; keep the existing bare-URL
   assertion for the no-surface call.
3. Verify (unpiped, must be EXIT=0 both):
   ```bash
   pnpm exec tsc --noEmit > /tmp/1533-phase3-tsc.log 2>&1; echo "EXIT=$?"
   pnpm vitest run tests/unit/app-shell-chat-surface.test.tsx tests/unit/chat-drawer-surface.test.tsx tests/unit/chat-model-pill-surface.test.tsx tests/unit/chat-api-client.test.ts > /tmp/1533-phase3.log 2>&1; echo "EXIT=$?"
   ```
4. Commit (shared-checkout discipline: explicit paths, `git diff` review, `git show --name-only
   HEAD` after).

## Known test-env gotchas (from Phase 2, will likely recur)

- No jsdom (`node` env) — no `window` global. If any component effect touches `window`, stub it:
  `vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() })`.
- `vi.mock("api/client.js", ...)` intercepts every importer file-graph-wide — pass real exports
  through via `importOriginal` for anything checked with `instanceof` downstream.
- React Query: prime `mockResolvedValueOnce` before the FIRST render/mount using a given surface
  key — a same-value re-flip doesn't refetch.
- React-test-renderer's `.find()` throws on zero matches; build any "assert absent" helper on
  `.findAll()[0] ?? null`.
- Full detail saved in agentmemory (project `jarv1s`, type `pattern`) — search "node-env vitest".

## Then: Phase 4 (plan lines 292-313)

Full gate + live-path proof + draft PR, then `coordinated-wrap-up`. Invoke `verify-gate` for any
DB-touching/full gate run — never run `pnpm verify:foundation` raw.

## Coordinator

Label `Coordinator` — **re-resolve via `herdr pane list` before messaging**, names get reused.
This session (relay6→7) never messaged it (no blocker, no fork). Prior lane's pane (from relay6's
boot brief, session `0ba62bdf-d339-4947-9045-6298006ff563`) reap status still unconfirmed across
relays 6 and 7 — **the successor should resolve+reap it or confirm already reaped** before or
alongside its first Coordinator message.
