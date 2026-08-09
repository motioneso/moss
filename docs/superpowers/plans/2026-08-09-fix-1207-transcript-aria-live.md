# Plan — fix-1207-transcript-aria-live

**Spec:** `docs/superpowers/specs/2026-08-08-non-feature-wave-2.md` (row #1207)
**Issue:** Part of #1207 (a11y: restore `aria-live` on embedded assistant transcript container)
**Risk tier:** routine

## Seams check (file:line citations)

- Transcript container missing the live region: `apps/web/src/chat/assistant-surface/surface.tsx:145`
  — `<div className="assistant-surface__thread">` wraps `props.localRows`, `<Thread records={...}/>`,
  the typing row, and `props.activeControl`. It carried no `aria-live`.
- Existing (narrower) live region: `apps/web/src/chat/assistant-surface/surface.tsx:266-270` —
  the `TypingRow` inner `<div>` already has `aria-live="polite"`. This is a _different_ element;
  it stays as-is (removing it is out of scope and would regress the typing announcement).
- `Thread` (in `apps/web/src/chat/message-row.tsx:45`) also independently carries its own
  `aria-live="polite"` on `chatd-thread`. It covers `props.records` only, not `localRows`,
  `activeControl`, or the typing row — all siblings of `<Thread>` inside
  `assistant-surface__thread`. This is why the outer container still needs its own live region:
  it's the one element whose subtree covers every kind of appended row.
- Render-test convention (no DOM env in this repo): `tests/unit/app-shell-chat-surface.test.tsx:1-20`
  — uses `renderToString` from `react-dom/server`, wraps in `QueryClientProvider` +
  `MemoryRouter`. `AssistantSurface` additionally needs `AssistantSurfaceHostProvider`
  (`apps/web/src/chat/assistant-surface/host-context.ts:17-26`) supplying `records`,
  `registerComposer`, `subscribeRecords`.
- `useAssistantName` (`apps/web/src/api/use-assistant-name.ts:11-18`) resolves to fallback
  `"Moss"` synchronously on first render when the react-query call hasn't settled — no extra
  mocking needed under `renderToString`, matching the existing test's approach.
- UAT coverage already exists for this seam — no new UAT spec or trigger-map row needed.
  `.claude/skills/coordinate/uat-trigger-map.tsv` rows 22-24 and 47 all match
  `apps/web/src/chat/**` as `blocking`:
  - `tests/uat/specs/1089-1090-chat-drawer-private.uat.spec.ts`
  - `tests/uat/specs/1133-chat-attachments.uat.spec.ts`
  - `tests/uat/specs/runtime-context.uat.spec.ts`
  - `tests/uat/specs/moss-assistant-name.uat.spec.ts`

## Determinism boundary

N/A — this is a static `aria-live` attribute on an existing DOM element. No model call, no new
user-facing copy, no injected turns.

## Phase 1 (only phase — single-file, single-attribute fix)

1. **`apps/web/src/chat/assistant-surface/surface.tsx:145`** — add `aria-live="polite"` to the
   `assistant-surface__thread` div. **Done.**
2. **Amend existing `tests/unit/assistant-surface.test.tsx`** (coordinator amendment: this file
   already carries the `renderToString` + `QueryClientProvider` + `AssistantSurfaceHostProvider`
   harness — do not create a second duplicate-harness file). Added one `it(...)` case asserting
   the rendered HTML contains `'class="assistant-surface__thread" aria-live="polite"'`. **Done** —
   confirmed red against the pre-fix tree, green after.

## Kill gate

None needed — single-attribute change, tier `routine`, no design fork possible.

## Verification commands

```bash
pnpm exec vitest run tests/unit/assistant-surface.test.tsx > /tmp/1207-test.log 2>&1; echo "EXIT=$?"
# EXIT=0 confirmed
pnpm format:check > /tmp/1207-format.log 2>&1; echo "EXIT=$?"      # EXIT=0 confirmed
pnpm lint > /tmp/1207-lint.log 2>&1; echo "EXIT=$?"                # EXIT=0 confirmed
pnpm typecheck > /tmp/1207-typecheck.log 2>&1; echo "EXIT=$?"      # EXIT=0 confirmed
```

Full gate (`pnpm verify:foundation`, isolated gate DB) run per `coordinated-wrap-up` at wrap-up,
not here.

## Live-path proof

Run all four blocking UAT specs listed above against a live dev instance and post a `gh pr
comment` with:

- the UAT run output (all four specs passing), and
- proof the `aria-live="polite"` attribute is present in the **live rendered DOM**, not just a
  visual screenshot of the chat UI — e.g. a devtools Elements-panel screenshot with the attribute
  visible on `assistant-surface__thread`, or an `element.outerHTML`/`getAttribute` snippet
  captured from the live page (coordinator amendment: a plain UI screenshot doesn't prove the
  attribute exists, since `aria-live` has no visual rendering).

Per spec exit criteria, #1207 cannot merge without this.
