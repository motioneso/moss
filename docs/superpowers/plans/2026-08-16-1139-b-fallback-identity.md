# Plan — 1139-B: Reconcile fallbacks by record identity

Part of #1519 (child of #1139). Spec:
`docs/superpowers/specs/2026-08-10-1139-chat-export-ui-followups.md` § "Child 1139-B" (lines
139-183). Risk tier: `routine`.

## Seams check (file:line, current tree)

- `sameTranscriptRecord` — `apps/web/src/chat/chat-drawer.tsx:634-636` — private function, today
  `a.kind === b.kind && a.text === b.text` (no identity awareness). Confirmed still the current
  body; premise not stale.
- Callers of `sameTranscriptRecord`, both to be left as one-predicate call sites:
  - state cleanup after a POST resolves — `apps/web/src/chat/chat-drawer.tsx:229-233`
    (`setFallbackRecords` filter against `props.records`)
  - render-time suppression — `apps/web/src/chat/chat-drawer.tsx:270-272`
    (`visibleFallbackRecords` filter against `displayRecords`)
- `TranscriptRecord.messageId?: string` — `apps/web/src/chat/use-chat-stream.ts:37` — already
  optional on the shared type; POST-fallback records get real ids from `sendChatTurn` result
  (`chat-drawer.tsx:221,225`), SSE-delivered records get ids via `parseRecord`
  (`use-chat-stream.ts:233`) and history rehydration (`use-chat-stream.ts:181,206`). No type change
  needed.
- Test harness precedent for POST-fallback + SSE races — `tests/e2e/chat-drawer.spec.ts:656-723`
  (`#664` test): `page.route("**/api/chat/turn", ...)` resolves with
  `{reply, userMessageId, assistantMessageId}`; `page.route("**/api/chat/stream", ...)` fulfills a
  one-shot `text/event-stream` body. Same two mocks are reused here, just with SSE payloads that
  carry matching/non-matching `messageId`s instead of an empty body.
- SSE wire format — `data: {"kind":"reply","text":"...","messageId":"..."}\n\n`, consumed by
  `parseRecord` (`apps/web/src/chat/use-chat-stream.ts:224-240`); confirmed by existing fixtures at
  `tests/e2e/chat-drawer.spec.ts:57-58,509,622`.
- No new platform capability required — this is a same-file predicate tightening plus one new e2e
  scenario in the already-exclusive test file.

## Determinism boundary

N/A — no model output involved. Pure client-side record-identity comparison; UI feedback already
renders from POST/SSE response data, not from any model turn.

## Task 1 — Tighten `sameTranscriptRecord`

**File:** `apps/web/src/chat/chat-drawer.tsx`

Replace the body of `sameTranscriptRecord` (kept private, same call sites, same signature):

```ts
function sameTranscriptRecord(a: TranscriptRecord, b: TranscriptRecord): boolean {
  if (a.kind !== b.kind) return false;
  if (a.messageId || b.messageId) return a.messageId === b.messageId;
  return a.text === b.text;
}
```

No other lines in `chat-drawer.tsx` change. Do not touch `visibleFallbackRecords` or the
`setFallbackRecords` filter bodies — both already call the one predicate.

## Task 2 — e2e scenario: identical fallbacks reconcile by id, not by text

**File:** `tests/e2e/chat-drawer.spec.ts` (1139-B's exclusive named scenario)

New test, name must contain `"identical fallbacks"` (matches the spec's focused-command grep):

`test("identical fallbacks reconcile by messageId, not by kind+text", async ({ page }) => ...)`

Fixture, following the `#664` test's mock shape:

1. Mock `**/api/chat/stream` as a _held-open, empty_ SSE route initially (mirrors `#664`'s
   `route.fulfill({ body: "" })`) so both POST turns land in `fallbackRecords` before any SSE
   record arrives.
2. Mock `**/api/chat/turn` to resolve two sends with the **same reply text** but distinct
   `userMessageId`/`assistantMessageId` per turn (e.g. `turn-1-user`/`turn-1-reply` and
   `turn-2-user`/`turn-2-reply`), analogous to `#664:685-699`.
3. Send the same text twice (e.g. "Ping") so both turns resolve into two identical-looking
   `{kind:"user", text:"Ping"}` + `{kind:"reply", text:"Reply to Ping"}` fallback pairs, four
   fallback records total, two with `turn-1-*` ids and two with `turn-2-*` ids.
4. Re-route `**/api/chat/stream` (Playwright allows re-registering) or use a controllable body
   source to deliver, one at a time, `data: {"kind":"reply","text":"Reply to
Ping","messageId":"turn-1-reply"}\n\n` — assert exactly one "Reply to Ping" bubble remains
   removed from fallbacks (i.e. still one rendered from the SSE-delivered record, the `turn-2`
   fallback pair still present) — then deliver the `turn-2-reply` record and assert the second
   fallback is now also gone with no duplicate/flicker.
5. Assert visible reply-bubble count is exactly 2 throughout (never 1, never 3) — the regression
   this closes is either bubble vanishing prematurely (old kind+text match killed both) or a
   flicker (both temporarily removed then one re-added).
6. Legacy id-less fixture: one additional fallback pair built with no `messageId` on either side
   (simulating pre-#1482 records) confirms `sameTranscriptRecord` still matches on kind+text when
   neither side carries an id — must NOT survive an SSE delivery of the same kind+text with no id.

Focused command (from spec, must pass, exit 0):

```bash
cd ~/Jarv1s
pnpm exec playwright test tests/e2e/chat-drawer.spec.ts --grep "identical fallbacks" > /tmp/1139b-focused.log 2>&1; echo "EXIT=$?"
```

## Kill gate

If the test cannot deterministically observe "exactly one fallback disappears per matching SSE
delivery" against a live EventSource-driven `page.route` stream (Playwright SSE re-routing proves
too flaky to sequence two distinct deliveries), stop and escalate to the coordinator with the
concrete failure — do not weaken the assertion to something that would pass under the old
kind+text-only predicate. Owner: this lane; escalate via `herdr-pane-message` if hit.

## Verification

```bash
cd ~/Jarv1s
pnpm --filter web typecheck > /tmp/1139b-typecheck.log 2>&1; echo "EXIT=$?"
pnpm exec playwright test tests/e2e/chat-drawer.spec.ts --grep "identical fallbacks" > /tmp/1139b-focused.log 2>&1; echo "EXIT=$?"
```

Both expected `EXIT=0`. Full gate (`verify:foundation`, isolated DB, per `verify-gate` skill) and
live-path artifact happen at `coordinated-wrap-up`, per handoff exit criteria.
