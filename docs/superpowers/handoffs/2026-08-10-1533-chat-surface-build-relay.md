# Relay — #1533 chat-surface routing build

Continuation of `docs/superpowers/handoffs/2026-08-10-1533-chat-surface-build.md`. That doc's
**Start**/**Exit criteria**/**Collision notes** still apply verbatim — read it first, it's short.

## Status

- **Step ½ (verify spec against branch) — DONE.** Every premise in the approved spec
  (`docs/superpowers/specs/2026-08-10-1533-chat-surface-send-routing.md`) was checked against the
  current branch via targeted grep/Read. All confirmed accurate, zero drift. Safe to plan against
  as-is — do not re-verify, the citations below are current as of this relay.
- **Step 1 (plan-build plan) — NOT STARTED.** No plan file written yet. No code written yet. No
  commits made yet (only `pnpm install`, which is done — `node_modules` exists, **do not
  re-install**).
- Coordinator (label `Coordinator`, session `019fef6b-8f40-7453-a6f9-4c3e245dce52`) was told this
  relay is happening and that nothing needs review yet.

## Next action

Write `docs/superpowers/plans/2026-08-10-1533-chat-surface-send-routing.md` per the `plan-build`
skill (decisions only — exact paths/signatures/test cases+why-they'd-fail/unpiped verification
commands with expected exit codes; no function bodies). Use the citations below directly — do not
re-grep. Suggested phase split, with a kill gate after Phase 1:

- **Phase 1**: `ChatDrawer` gains a `surface: ChatSurface` prop; `AppShell` passes
  `surface={activeSurface}` into it; all 8 non-model-pill `ChatDrawer` call sites
  (`sendChatTurn`, `cancelChatTurn`, `clearChat`, `endPrivateChat`, `getChatPrivacyState`,
  `listChatThreads`, `listChatThreadMessages`, `resumeChat`) pass `props.surface`;
  `queryKeys.chat.privacy` becomes a function keyed by surface (mirroring `.threads`/`.messages`);
  private-chat "Start private chat" button gated to `props.surface === DEFAULT_CHAT_SURFACE`;
  extend `tests/unit/app-shell-chat-surface.test.tsx` (capture `props.surface` in the `ChatDrawer`
  mock, 3 new assertions per spec's regression-test section) + new
  `tests/unit/chat-drawer-surface.test.tsx`.
- **Phase 2**: `ChatModelPill` gains a `surface: ChatSurface` prop from `ChatDrawer`;
  `switchChatProvider()` in `client.ts` gains an optional `surface?: ChatSurface` param
  (`?surface=` query string, matching the pattern of the other already-surface-correct client
  functions); its `queryKeys.chat.threads()` invalidation passes surface; new
  `tests/unit/chat-model-pill-surface.test.tsx` with Fable's required **runtime call-argument
  assertions** (this repo doesn't typecheck `.tsx`, so assert the actual call args, not just types)
  — e.g. `expect(sendChatTurn).toHaveBeenCalledExactlyOnceWith("Remote only", undefined, undefined,
  moduleSurface)` per the spec's exact assertion text.
- Kill gate after Phase 1: if the extended `app-shell-chat-surface.test.tsx` +
  `chat-drawer-surface.test.tsx` don't pass, or the drawer-prop threading reveals a call site the
  seams check missed, stop and re-plan Phase 2 rather than pushing forward — named owner: whoever
  is driving this build lane (self).

After the plan is written: message Coordinator (pane resolved fresh by label `Coordinator` +
confirm session id `019fef6b-8f40-7453-a6f9-4c3e245dce52` via `herdr pane list` — do not reuse a
baked-in pane number) with the plan's path, per `coordinated-build` step 1. **STOP and wait** for
approval before writing any code. Then proceed through `coordinated-build` steps 2–4
(TDD build → self-monitor → `coordinated-wrap-up` to a draft PR). Read the spec **by section**
only when a phase needs it, never front-to-back again.

## Seams-check citations (do not re-derive)

### Spec, handoff, task brief

- Task brief: `/tmp/boot-1533-chat-surface-build.txt` (read in full already).
- Handoff: `docs/superpowers/handoffs/2026-08-10-1533-chat-surface-build.md` (read in full
  already — Coordinator label/session id, exit criteria, collision notes all there).
- Approved spec: `docs/superpowers/specs/2026-08-10-1533-chat-surface-send-routing.md` (378
  lines, already read in full this build — re-read by section only, not again in full). Sections
  that matter for planning: "Locked design" (5 numbered call-site signatures), "Regression tests"
  (exact file names + exact `expect()` text), "Live-path proof" (7 manual steps),
  "One-session implementation boundary" (exact 9-file allowlist — **stay inside it**), "Non-goals".

### Frontend files (all in-scope per the spec's 9-file allowlist)

- `apps/web/src/shell/app-shell.tsx`
  - Line 141: `const activeSurface = activeModuleSurfaceBranded ?? DEFAULT_CHAT_SURFACE;`
  - Line 146: `useChatStream(activeSurface)`
  - Lines 192–193: `recordsForSurface` closure
  - Lines 425–445: `<ChatDrawer>` JSX — currently passes `open`, `onClose`, `records`,
    `clearRecords`, `streamErrorCount`, `isFounder`, `initialText`, `focusActionRequestId`,
    `onActionRequestFocused` — **no `surface` prop**. Add `surface={activeSurface}`.

- `apps/web/src/chat/chat-drawer.tsx` (742 lines; lines 595–742, the `HistoryList`/`EmptyState`
  helper components, were NOT read in this build — low risk, spec never lists them as needing
  surface awareness since they're presentational, but do a final bounded check before Phase 1 is
  called done)
  - Props type starts line 45: `open`, `onClose`, `records`, `clearRecords`, `streamErrorCount`,
    `isFounder`, `initialText?`, `focusActionRequestId?`, `onActionRequestFocused?` — no `surface`
    field. Add it.
  - Line 70–74: `privacyStateQuery` calls `getChatPrivacyState()` — no surface arg.
  - Line 103–119: `resumeMutation` calls `resumeChat(threadId)` — no surface; invalidates
    `queryKeys.chat.threads()` / `.privacy` at lines 112–113 — no surface.
  - Line 171–175: `threadsQuery` calls `listChatThreads()` — no surface.
  - Line 176–180: `messagesQuery` calls `listChatThreadMessages(reviewThreadId ?? "")` — no
    surface.
  - Line 189 onward, `sendMessage` callback: line 212–215 calls
    `sendChatTurn(trimmed, attachments?.map(...))` — only 2 of 4 possible args (missing the
    surface-position arg); line 231 invalidates `queryKeys.chat.threads()` — no surface.
  - Line 329–343 `startNewChat`: line 340 `clearChat()`, line 342 `queryKeys.chat.threads()`
    invalidation — no surface.
  - Line 345–347 `switchToNewModelChat`.
  - Line 349–375 `startPrivateChat`: line 362 `clearChat({incognito:true})` — no surface.
  - Line 377–383 `closePrivateChat`: line 382 `endPrivateChat()` — no surface.
  - Line 387–394 `stopSending`: line 391 `cancelChatTurn()` — no surface.
  - Lines 419–428: "Start private chat" ShieldOff button — currently **always** rendered; spec
    requires gating on `props.surface === DEFAULT_CHAT_SURFACE`.
  - Lines 576–580: `<ChatModelPill disabled=... privateMode=... onCrossProviderSwitch=... />` —
    no `surface` prop passed; add it.

- `apps/web/src/chat/chat-model-pill.tsx` (168 lines, read in full)
  - Props type lines 24–28: `disabled`, `privateMode`, `onCrossProviderSwitch` — no `surface`.
  - `mutation` lines 49–63: line 54 calls `switchChatProvider()` — no arg — inside
    `if (choice.relation === "same-provider")`; lines 58–61 invalidate
    `queryKeys.ai.chatModelOverride` + `queryKeys.chat.threads()` — no surface.
  - Line 56: cross-provider branch calls `props.onCrossProviderSwitch()` (→ `ChatDrawer`'s
    `switchToNewModelChat` → `startNewChat`, already surface-bound once Phase 1 lands).

- `apps/web/src/api/client.ts` — every relevant export already accepts optional
  `surface?: ChatSurface` **except** `switchChatProvider`:
  - `listChatThreads(surface?)` line 767
  - `listChatThreadMessages(threadId, surface?)` lines 772–774
  - `sendChatTurn(text, attachmentIds?, ?, surface?)` lines 854–858
  - (briefing-related surface param) line 880
  - `input: { readonly briefingRunId?: string; readonly surface?: ChatSurface } = {}` line 925
  - `cancelChatTurn(surface?)` line 934
  - `clearChat(options?: { ...; surface?: ChatSurface })` lines 939–941
  - `endPrivateChat(surface?)` line 950
  - `getChatPrivacyState(surface?)` lines 955–956
  - `resumeChat(threadId, surface?)` line 966
  - `chatStreamUrl(surface?)` line 973
  - **`switchChatProvider()` lines 1161–1163 — NO surface param.** Body:
    `await requestJson<{ ok: true }>("/api/chat/switch", { method: "POST" });` — needs an
    optional `surface?: ChatSurface` param → `?surface=` query string, matching the other
    functions' pattern.

- `apps/web/src/api/query-keys.ts` lines 81–90:
  ```ts
  chat: {
    settings: ["chat", "settings"] as const,
    threads: (surface?: string) => ["chat", "threads", surface ?? "drawer"] as const,
    privacy: ["chat", "privacy"] as const,   // FIXED key — must become a function per spec
    messages: (threadId: string, surface?: string) =>
      ["chat", "threads", threadId, "messages", surface ?? "drawer"] as const,
    memorySettings: ["chat", "memory-settings"] as const,
    memoryFacts: ["chat", "memory-facts"] as const,
    memoryCorrections: ["chat", "memory-corrections"] as const,
    skills: ["chat", "skills"] as const
  }
  ```
  Make `privacy` a function `(surface?: string) => ["chat", "privacy", surface ?? "drawer"] as const`
  to mirror `threads`/`messages`.

- `packages/shared/src/chat-api.ts`
  - Line 11: `export type ChatSurface = string & { readonly __chatSurface: unique symbol };`
  - Line 12: `export const DEFAULT_CHAT_SURFACE = "drawer" as ChatSurface;`
  - Lines 16–17: `normalizeChatSurface` (defaults undefined → `DEFAULT_CHAT_SURFACE`).

- `apps/web/src/shell/chat-surface-key.ts` line 51:
  `export function moduleChatSurface(moduleId: string, key: string): string`.

### Tests

- `tests/unit/app-shell-chat-surface.test.tsx` (229 lines, read in full — reuse this
  understanding, don't re-read unless a detail is needed):
  - `renderToString`-based, no DOM env.
  - Mocks `useChatStream` at exact resolved specifier `../../apps/web/src/chat/use-chat-stream.js`
    — wrong specifier silently no-ops, don't "simplify" it.
  - Mocks `ChatDrawer` at `../../apps/web/src/chat/chat-drawer.js`, currently only capturing
    `props.records` into `chatDrawerRecordsCalls` — **extend to also capture `props.surface`**.
  - Helpers: `renderWithModuleMount(moduleId, key)` (uses REAL
    `createAssistantSurfaceHandle(() => () => undefined, moduleId)` +
    `handle.setSurfaceKey(key)` before `renderToString`), `lastSurfaceArg()`.
  - `afterEach` resets the module-level singleton via
    `createAssistantSurfaceHandle(() => () => undefined, "cleanup").setSurfaceKey(null)`.
  - 10 existing `it()` blocks pass already; none yet assert `ChatDrawer`'s `surface` prop — that's
    the gap Phase 1's 3 new assertions fill (per spec's regression-test section).
- `tests/unit/chat-api-client.test.ts`, `tests/unit/chat-model-pill.test.ts` exist (618B, 2244B) —
  not read in detail. `chat-model-pill.test.ts` is explicitly "leave unchanged" per spec — a new
  sibling `-surface` suite is added instead (Phase 2's `chat-model-pill-surface.test.tsx`).
- `tests/unit/chat-drawer-surface.test.tsx`, `tests/unit/chat-model-pill-surface.test.tsx`:
  confirmed **do not exist yet** (`ls` exit 2) — both are new files per spec.

### UAT coverage (no new UAT spec file needed)

`.claude/skills/coordinate/uat-trigger-map.tsv` already has blocking rows covering this build's
changed paths: `apps/web/src/chat/**` → `tests/uat/specs/1089-1090-chat-drawer-private.uat.spec.ts`
(+ `1133-chat-attachments.uat.spec.ts`, `runtime-context.uat.spec.ts`); `apps/web/src/shell/app-shell.tsx`
→ `tests/uat/specs/moss-assistant-name.uat.spec.ts`. This satisfies coordinated-build's "plan MUST
include the UAT spec" clause via existing coverage — the spec itself prescribes a manual
"Live-path proof" procedure (7 steps, in the spec's own section) instead of a new automated UAT
spec file. Don't add one.

### Live-path proof target (for later, step 4)

`external-modules/job-search/src/web/screens/profile.tsx` line 168,
`external-modules/job-search/src/web/root.tsx` lines 12 and 455,
`external-modules/job-search/src/worker/registry.ts` line 76 — the "Change in chat" UI action and
`job-search.criteria.set` tool/handler already exist and are live; this is the flow to drive
during the live-path proof.

## Type-safety note (memory lesson, confidence 0.80)

`vitest` alone does NOT prove a new `.ts` file is type-safe in this repo — its transform skips
full `tsc` checking (`noUncheckedIndexedAccess`, `TS2352` etc. only surface under `pnpm typecheck`
or the full gate). Run `pnpm exec tsc --noEmit` standalone on any new/edited `.ts` production file
(`client.ts`, `query-keys.ts`) before the first `pnpm verify:foundation` gate attempt — don't rely
on `pnpm vitest run` alone. `.tsx` files aren't typechecked per-file (issue #1335) so the new test
files need the runtime call-argument assertions instead (already planned into Phase 2 above).

## Ground truth

- Branch: `build/1533-chat-surface-routing`, merge-base with `origin/main` = `abfe0478b`
  (confirmed same as `origin/main` HEAD at verification time — re-check with
  `git merge-base HEAD origin/main` if time has passed).
- `node_modules` already installed — **do not re-run `pnpm install`**.
- No commits made in this build yet. No code edits made yet.
