# Relay 3 — #1533 chat-surface routing build

Continuation of `docs/superpowers/handoffs/2026-08-10-1533-chat-surface-build.md` (Start/Exit
criteria/Collision notes still apply verbatim) and `...-relay2.md` (superseded — plan is now
committed AND Phase 1 is partway implemented).

## Status

- Plan: `docs/superpowers/plans/2026-08-10-1533-chat-surface-send-routing.md` (commit `83ccac7a5`),
  approved by both Coordinator and Ben. Ben's exact instruction: "Plan approved as written. Proceed
  Phase 1 through Phase 4 within the nine-file allowlist... finish with the sensitive live-path
  proof and draft PR." No further per-phase check-in needed — proceed straight through.
- **Phase 1 production code is DONE**, committed at `57f92ce2e`:
  - `query-keys.ts`: `chat.privacy` is now `(surface?: string) => [...]`.
  - `app-shell.tsx`: `<ChatDrawer surface={activeSurface} />` wired.
  - `chat-drawer.tsx`: `props.surface` threaded through every call site (privacy/threads/messages
    queries, sendMessage, resumeMutation, startNewChat, startPrivateChat, closePrivateChat,
    stopSending). "Start private chat" button gated to
    `props.surface === DEFAULT_CHAT_SURFACE` only.
  - `tsc --noEmit`: EXIT=0. `vitest run tests/unit/app-shell-chat-surface.test.tsx`: 10/10 passed
    (mock now captures `props.surface` into `chatDrawerSurfaceCalls` but no new assertions yet).
- **Phase 1 tests are NOT done** — this is the only remaining Phase 1 work:
  1. In `tests/unit/app-shell-chat-surface.test.tsx`, add 3 assertions using the now-populated
     `chatDrawerSurfaceCalls` array (plan lines 99-109 — full text below, do not re-derive):
     - No module claim → `chatDrawerSurfaceCalls.at(-1) === DEFAULT_CHAT_SURFACE` **and**
       `=== lastSurfaceArg()`.
     - `renderWithModuleMount("job-search", "profile-1")` →
       `chatDrawerSurfaceCalls.at(-1) === moduleChatSurface("job-search", "profile-1")` **and**
       `=== lastSurfaceArg()`.
     - After `setSurfaceKey(null)` → both back to `DEFAULT_CHAT_SURFACE`.
     File already has `DEFAULT_CHAT_SURFACE`, `moduleChatSurface`, `renderWithModuleMount`,
     `lastSurfaceArg` in scope (grepped, confirmed present at lines 25, 70, 100, 121 as of this
     commit) — reuse them, don't re-import.
  2. Create new `tests/unit/chat-drawer-surface.test.tsx` (routing half only — plan lines 110-126):
     render with `surface={moduleChatSurface("job-search","profile-1")}`, assert `sendChatTurn`
     called with `(text, undefined, undefined, moduleSurface)`, `cancelChatTurn`/`clearChat`/
     `getChatPrivacyState`/`listChatThreads` all receive `moduleSurface`, and the private-chat
     button (`aria-label="Start private chat"`) is absent. Plus a default-drawer case: button
     present, send uses `DEFAULT_CHAT_SURFACE`. (Full plan text has exact expectations — read
     `docs/superpowers/plans/2026-08-10-1533-chat-surface-send-routing.md` lines 110-126 verbatim,
     it's short.)
  3. Run kill-gate verification:
     ```bash
     pnpm vitest run tests/unit/app-shell-chat-surface.test.tsx tests/unit/chat-drawer-surface.test.tsx > /tmp/1533-phase1.log 2>&1; echo "EXIT=$?"
     ```
     Expected `EXIT=0`. If not green, or an unaccounted 9th call site turns up, stop — do not start
     Phase 2 (plan's Phase 1 kill gate, owner: self).

## Next action

Finish the 2 Phase 1 test items above, hit the kill gate, then proceed straight into **Phase 2**
(atomic surface-reset + stale-completion guards — full mechanism already decided in the plan,
lines 141-234, do not re-derive) and **Phase 3** (`ChatModelPill` surface — plan lines 235-291),
then **Phase 4** (full gate + live-path proof + draft PR — plan lines 292-313). No new
Coordinator/Ben check-in needed per Ben's standing approval; message Coordinator only at
significant kill-gate/blocker points or before opening the draft PR.

## Ground truth

- Branch: `build/1533-chat-surface-routing`. Latest commit `57f92ce2e` (Phase 1 production code +
  partial test).
- Merge-base with `origin/main` was `abfe0478b` as of 2026-08-10 — re-check with
  `git merge-base HEAD origin/main` if stale.
- Coordinator: label `Coordinator`, session id `019fef6b-8f40-7453-a6f9-4c3e245dce52` — re-resolve
  current registered name via `herdr pane list`/`herdr agent list` before messaging (names get
  reused by newer agents).
- `node_modules` already installed — never `pnpm install`.
- Shared checkout: always commit by explicit path (`git commit <paths> -m ...`), never `-A`/bare;
  verify with `git show --name-only HEAD` after every commit.
