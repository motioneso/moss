# Relay 8 — #1533 chat-surface routing build

Continuation of `...-relay7.md` (superseded — Phase 3 test files now WRITTEN but NOT YET
VERIFIED, NOT YET COMMITTED).

## Status

- Branch `build/1533-chat-surface-routing`, worktree `~/Jarv1s/.claude/worktrees/1533-chat-surface-build`.
- Latest commit still `2c35c858d` (Phase 3 production code). The two Phase 3 test changes below
  are **uncommitted working-tree changes**, not yet verified.
- `node_modules` already installed — never `pnpm install`.

## What relay7 did (uncommitted)

1. **Created** `tests/unit/chat-model-pill-surface.test.tsx` (new file, ~320 lines). Two describe
   blocks:
   - `ChatModelPill mutation surface routing (#1533)` — same-provider mutation calls
     `switchChatProvider(moduleSurface)` + invalidates `.threads(moduleSurface)`; a same-provider
     mutation that resolves *after* a `surface` prop flip must not invalidate the new surface's
     threads key.
   - `ChatDrawer forwards its surface into ChatModelPill (#1533)` — mocks `ChatModelPill` via
     `vi.fn(actual.ChatModelPill)` (spy-wraps the real component so it still renders), captures
     `.mock.calls`, asserts `ChatDrawer` passes its exact `props.surface` through, both for a
     module surface and for `DEFAULT_CHAT_SURFACE`.
   - New gotcha discovered (not in relay7's doc): `ChatModelPill`'s dropdown menu uses
     `useDismissableMenu`, which registers real `document.addEventListener` once opened — needed
     `vi.stubGlobal("document", { addEventListener: vi.fn(), removeEventListener: vi.fn() })` in
     addition to the already-known `window` stub.
2. **Edited** `tests/unit/chat-api-client.test.ts` — added two new `it(...)` cases (file
   previously had ONLY a `sendChatTurn` test, ZERO prior `switchChatProvider` coverage, contrary
   to relay7's doc which assumed a "keep the existing bare-URL assertion" case already existed —
   there was none, so both a no-surface and a surfaced case were written from scratch):
   - `switches chat provider with a bare URL when no surface is given` → asserts
     `fetch("/api/chat/switch", { method: "POST", ... })`.
   - `switches chat provider scoped to the given surface` → asserts
     `` fetch(`/api/chat/switch?surface=${encodeURIComponent(surface)}`, { method: "POST", ... }) ``
     using `moduleChatSurface("job-search", "profile-1")`.

## NOT DONE YET — next action for successor

**Neither `tsc` nor vitest has been run against these changes in this session.** Do this first,
unpiped, exactly as specified in the plan (`docs/superpowers/plans/2026-08-10-1533-chat-surface-send-routing.md`
lines 235-291, read that section only):

```bash
pnpm exec tsc --noEmit > /tmp/1533-phase3-tsc.log 2>&1; echo "EXIT=$?"
pnpm vitest run tests/unit/app-shell-chat-surface.test.tsx tests/unit/chat-drawer-surface.test.tsx tests/unit/chat-model-pill-surface.test.tsx tests/unit/chat-api-client.test.ts > /tmp/1533-phase3.log 2>&1; echo "EXIT=$?"
```

Both must be `EXIT=0`. **Expect first-pass failures** — the new test file was written but never
run; likely trouble spots to check first if red:
- Import paths use `.js` extensions matching this repo's ESM convention (verify against
  `chat-drawer-surface.test.tsx`'s actual imports if anything 404s).
- `ChatDrawer` props shape in `renderDrawer()` (open/onClose/records/clearRecords/streamErrorCount/isFounder/surface) — copied from memory of `chat-drawer-surface.test.tsx`'s harness, not re-verified against the current prop list; re-check `apps/web/src/chat/chat-drawer.tsx`'s prop type if TS complains.
- `vi.mocked(ChatModelPill).mock.calls[...][0]` typing — may need an explicit cast if TS can't
  infer through the `vi.fn(actual.ChatModelPill)` wrapper.
- Menu-button index assumptions (button[1] = same-provider choice, relies on
  `settingsFixture()`'s `selectableOverrideModels: [sameProviderModel, crossProviderModel]`
  ordering) — logic is sound but unverified end-to-end.

Iterate to green, **then**:

1. Commit both files via `shared-checkout` skill discipline (explicit paths — do NOT `git add -A`;
   review `git diff`; confirm with `git show --name-only HEAD` after committing). This is a shared
   worktree — assume other sessions may be mid-run.
2. Proceed to Phase 4 (plan lines 292-313, read that section only): full gate via `verify-gate`
   skill (never raw `pnpm verify:foundation`) + live-path proof through job-search module's
   "Change in chat" action (`external-modules/job-search/src/web/screens/profile.tsx:168`,
   `root.tsx:12,455`, `worker/registry.ts:76`) with network/screenshot evidence within a 5-second
   observation bound + sensitive-tier check (`git diff --stat` — confirm no `AccessContext`/RLS/
   persistence/gateway-contract files touched) + draft PR via `coordinated-wrap-up` (do not
   merge).

## Coordinator

Label `Coordinator` (was resolved by relay7 as codex agent `coord-relay2`,
session `019fefbd-5852-71d2-b0b1-4da3cdbbf1d1`) — **re-resolve fresh via `herdr pane list` /
`herdr agent list` before messaging, names get reused, do not trust this doc's session id.**
Relay7 sent one confirmation message to it (Coordinator identity resolved, prior lane's pane
`0ba62bdf-...` confirmed already reaped, stated plan to proceed with Phase 3 tests then Phase 4).
No reply required unless blocked.

## Known test-env gotchas (still applicable)

- No jsdom (`node` env) — stub any global a component effect touches: `window`, and now also
  `document` (see above) for anything that opens `ChatModelPill`'s menu.
- `vi.mock("api/client.js", ...)` intercepts file-graph-wide — pass `ApiError` through via
  `importOriginal` for `instanceof` checks downstream (`composer.tsx`, `chat-availability.ts`).
- `vi.mock` factories cannot reference outer `const` fixtures declared later in the file (TDZ) —
  bare `vi.fn()` in the factory, set `.mockResolvedValue(...)` in `beforeEach`.
- React-test-renderer's `.find()` throws on zero matches — use `.findAll()[0] ?? null`.
