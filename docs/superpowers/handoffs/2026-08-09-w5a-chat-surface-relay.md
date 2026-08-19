# Relay — w5a-chat-surface (#1449)

**Trigger:** context-meter 70% warning, before any code written. No plan-build plan exists yet, no
coordinator plan approval requested yet. Tree is clean (nothing to commit).

**Spec:** `docs/superpowers/specs/2026-08-09-wave-5-chat-surface-correctness.md` (Lane A section).
**Issue:** #1449 — "Default chat drawer never rehydrates approval cards (surface is always null in
the shell)". Tier: `sensitive`.
**Worktree/branch:** this worktree, branch `w5a-chat-surface`, off `origin/main`.
**Coordinator:** label `Coordinator` — re-resolve fresh via `herdr pane list` (session id rotates on
coordinator relays; do not reuse any id written in a doc). Already notified of this relay.

## Root cause (verified by direct code read, not just spec)

`apps/web/src/shell/app-shell.tsx` computes `activeSurface = activeModuleSurfaceBranded ??
DEFAULT_CHAT_SURFACE` (~line 139) but passes a **different** expression into the hook (~line 145):
```ts
const { records, clearRecords, streamErrorCount } = useChatStream(
  activeModuleSurfaceBranded ?? undefined   // BUG — should be activeSurface
);
```
`useChatStream` (`apps/web/src/chat/use-chat-stream.ts`) has a rehydration effect gated
`if (!surface || !enabled) return;` (~line 133) that fetches `listChatThreads` +
`listPendingActionRequests()` (#1253 approval-card rehydration). Passing `undefined` for the
default drawer means this effect never runs — approval cards never rehydrate on the default drawer.
`DEFAULT_CHAT_SURFACE` is already imported in app-shell.tsx (line 62). Backend already treats an
absent surface identically to `"drawer"` (`normalizeChatSurface` in `packages/shared/src/chat-api.ts`),
so this is a pure caller-side fix — no server change, no behavior change beyond fixing the bug.

## The fix (not yet applied)

One-line change in `apps/web/src/shell/app-shell.tsx`: replace
`useChatStream(activeModuleSurfaceBranded ?? undefined)` with `useChatStream(activeSurface)`.
No changes needed in `use-chat-stream.ts` (confirmed by full read — "fix the caller, not the hook").

## Test debt to fix in the same change

`tests/unit/app-shell-chat-surface.test.tsx` currently **codifies the bug**. Three tests assert
`expect(lastSurfaceArg()).toBeUndefined()` for the no-module-surface (default drawer) case:
- `"opens the drawer surface by default"` (~line 130-133)
- `"hands the drawer nothing once the module releases the surface"` (~line 182-192)
- `"returns the shell to the drawer once a module releases its surface"` (~line 194-202)

These must change to assert `DEFAULT_CHAT_SURFACE` (`"drawer"`) once the fix lands. Also add one
new explicit regression test asserting the shell passes a **defined** surface to `useChatStream` on
default mount — this satisfies the spec's exit criterion "a shell-level test that fails if the
default drawer stops fetching." `use-chat-stream.test.tsx` needs no changes (reference-only, already
read in full — demonstrates the `react-test-renderer` + `act()` pattern for testing real effects
without a DOM).

## Lane ownership (do not touch other files)

Exclusively own: `apps/web/src/shell/app-shell.tsx`, `apps/web/src/chat/use-chat-stream.ts` (+ their
tests). Lanes B/C/D are building concurrently against disjoint files — see spec's collision map.
Merge order A → C → D → B (coordinator's call, not yours).

## Next steps for successor

1. `[ -d node_modules ] || pnpm install` (likely already present — skip).
2. Write the `plan-build`-formatted plan to
   `docs/superpowers/plans/2026-08-09-fix-1449-drawer-rehydration.md` (not yet created). Keep it to
   decisions per `plan-build`: exact diff description, the 3 test-assertion changes + 1 new test
   case with rationale, verification commands with expected exit codes (unpiped). Determinism
   boundary note: this is pure wiring, no model output involved. Kill gate: none needed — single
   phase, single file pair.
3. Message the coordinator (re-resolve fresh by label `Coordinator`, confirm exactly one pane) with
   the plan path. **STOP and wait for approval before writing code.**
4. On approval: TDD — update the 3 assertions + add the regression test (red), then make the
   one-line `app-shell.tsx` fix (green). Commit with `git add` on exactly those files (never `-A`).
5. Pre-push trio: `pnpm format:check && pnpm lint && pnpm typecheck ; echo "EXIT=$?"`, then
   `git fetch origin main && git rebase origin/main`.
6. `coordinated-wrap-up`: isolated-gate-DB verify, push, open PR rebased on `origin/main`, live-path
   proof (seed a pending approval row, sign in, open default drawer, reload, reopen — card present,
   API log shows `GET /api/ai/assistant-actions`) as a `gh pr comment`, or report **code-complete,
   unverified** if no live instance reachable. Report PR + evidence to coordinator. Do not merge,
   close #1449, or touch the board.

Relay trigger for the successor is the same meter 70% warning — do not invent a higher personal
threshold, and don't full-read the spec; read it by section for the current task only.
