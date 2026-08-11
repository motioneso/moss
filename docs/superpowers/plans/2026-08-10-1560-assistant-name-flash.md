# Plan — #1560 assistant-name loading flash

**Approved task:** GitHub issue #1560 (acceptance below is the issue body, used directly per
handoff — no separate design spec).
**Risk tier:** routine (copy/loading-state correction, single component).
**Worktree/branch:** `~/Jarv1s/.claude/worktrees/1560-assistant-name-flash`, `fix/1560-assistant-name-flash`.

## Acceptance (from issue #1560)

- The evening prep card interpolates `assistantName` before the persona query resolves; for a
  user with a custom name this briefly shows "Chat with Moss" ("Moss" is the pending fallback,
  not a real default — see seam below).
- Fix: use neutral pending copy until the assistant name resolves; preserve the configured name
  once loaded.
- Add a regression assertion that holds persona loading pending and proves the default name is
  not rendered.

## Seams (file:line, current tree)

- `apps/web/src/today/evening-mode.tsx:211` — `const assistantName = useAssistantName();`
  (`EveningPrepCard`), no pending-fallback override.
- `apps/web/src/today/evening-mode.tsx:222` — `Chat with {assistantName}`, unconditional
  interpolation on the button.
- `apps/web/src/api/use-assistant-name.ts:11,17` — hook signature
  `useAssistantName(pendingFallback = "Moss")`; returns `pendingFallback` while
  `query.isLoading`, else `"Moss"` (resolved-default) or the trimmed configured name. Passing
  `""` is the existing seam for "no name yet" callers.
- `apps/web/src/today/today-page.tsx:571-585` — renders `<EveningPrepCard .../>` only when
  `eveningDefinition?.enabled && todayMode === "evening"`; this is the issue's second cited site
  (`today-page.tsx:572`), the render call, not a second interpolation. One hook call needs
  fixing, not two.
- Established neutral-fallback idiom already shipped for the same hook, same shape, elsewhere:
  `apps/web/src/chat/chat-drawer.tsx:62,400,407` — `useAssistantName("")` +
  `assistantName ? \`Chat with ${assistantName}\` : "Chat"`.
  `apps/web/src/shell/app-shell.tsx:97,384` — same ternary shape for `aria-label`.
  `apps/web/src/chat/composer.tsx:78,449` — same ternary shape for `aria-label`/placeholder.
  This fix reuses that idiom; no new pattern.
- Regression-test precedent for the exact same bug class:
  `tests/unit/app-shell-chat-surface.test.tsx:156` —
  `expect(html).not.toContain("Chat with Moss")`, written for #1451/#1482.
- Test harness already in place: `tests/unit/today-evening-mode.test.tsx`'s `renderToday()`
  helper (lines 188-239) seeds every query the page needs *except*
  `queryKeys.settings.persona` — so the persona `useQuery` inside `useAssistantName` stays
  `isLoading: true` through the synchronous `renderToString()` call. That is already the
  "persona loading pending" state the issue asks to regression-test; no fixture/mock changes
  needed to force it.

## Decision

Edit only `apps/web/src/today/evening-mode.tsx`, `EveningPrepCard` (lines 211, 222):

```
- const assistantName = useAssistantName();
+ const assistantName = useAssistantName("");
```
```
-         Chat with {assistantName}
+         {assistantName ? `Chat with ${assistantName}` : "Chat"}
```

No dependency, no abstraction, no other file touched. Design-system skill checked: text-only
change, no new `jds-*` class, no new markup.

## Test (tests/unit/today-evening-mode.test.tsx)

Add one `it` to the existing `describe("TodayPage evening mode", ...)` block, reusing the
existing `renderToday`/`briefingDefinition`/`briefingRun` helpers already in the file:

1. **"keeps the prep-card CTA neutral while the persona name is pending (#1560)"**
   Render with `definitions: [briefingDefinition({ targetTime: "19:00", timezone:
   locale.timezone })]`, `runs: []`, `tasks: []`, `events: []`,
   `now: new Date("2026-06-30T02:30:00.000Z")` (same evening-mode `now` as the existing
   "leads with the readable evening review" test, so `todayMode === "evening"` and
   `EveningPrepCard` renders). Do **not** seed `queryKeys.settings.persona` — persona query
   stays pending, matching the existing harness behavior.
   Assert: `expect(html).toContain(">Chat<")` (neutral label rendered) and
   `expect(html).not.toContain("Chat with Moss")`.
   **Why it fails today:** current code has no pending guard — `useAssistantName()` returns the
   hardcoded `"Moss"` fallback while `isLoading`, and the button unconditionally renders
   `Chat with {assistantName}`, so `html` contains `"Chat with Moss"` and the assertion fails
   against current `main`.
2. **"still shows the configured assistant name once persona resolves (#1560)"** — same render
   inputs, but additionally `client.setQueryData(queryKeys.settings.persona, { persona: {
   assistantName: "Jarvis", personaText: "" } })` before rendering. Assert
   `expect(html).toContain("Chat with Jarvis")`. Guards against the fix regressing the resolved
   case (empty-string fallback must not suppress a loaded name).

## Verification

```bash
pnpm vitest run tests/unit/today-evening-mode.test.tsx > /tmp/1560-vitest.log 2>&1; echo "EXIT=$?"
```
Expected: `EXIT=0`, both new tests passing (confirm test 1 fails against pre-fix code first —
TDD red/green, not just green-after).

```bash
pnpm format:check && pnpm lint && pnpm typecheck > /tmp/1560-checks.log 2>&1; echo "EXIT=$?"
```
Expected: `EXIT=0`.

## Live-path proof

Dev instance: sign in, set a custom assistant name in Settings → AI persona, land on `/today`
after the evening target time (or with an evening definition/time forced), and confirm via
network-throttled reload that the prep-card button never shows "Chat with Moss" and settles on
"Chat with `<configured name>`". Record the observation in the PR without a screenshot entering
coordinator context, per handoff.

## Kill gate

Single-phase, no phase 2 planned. If the seam citations above turn out stale on re-check (e.g.
`useAssistantName` no longer exists at the cited path), stop and escalate to Coordinator before
editing — do not improvise a different hook contract.
