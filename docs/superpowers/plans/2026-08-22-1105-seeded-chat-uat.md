# Plan: #1105 — deterministic seeded chat/thread UAT path (convert the 1089/1090 fixmes)

**Issue:** #1105 (Part of #1000). **Plan authority:** Fable 5, 2026-08-22.
**Governing specs:** `docs/superpowers/specs/2026-07-12-dev-uat-harness.md` (harness),
`docs/superpowers/specs/2026-08-10-1121-scriptable-uat-chat.md` (scripted engine).

## Spec-sufficiency ruling (binding)

No new standalone spec is needed. The infrastructure #1105 asked for in "What's needed (1)" — a
deterministic, credential-free chat-capable engine — was designed, approved, and **shipped by
#1121** after this issue was filed (scripted provider fixture `tests/uat/fixtures/scripted-provider/`,
seed chunk `tests/uat/seed/chunks/chat-script.ts`, `chatScript` in `uatLevel`, registry
`UAT_CHAT_SCRIPTS` in `tests/uat/seed/types.ts`). The issue body's remaining scope is a spec
conversion on existing approved infrastructure plus two design decisions, which this plan rules:

1. **#1121's non-goals do not bind #1105.** The #1121 spec's non-goals ("Changing either
   intentionally-fixme'd drawer-private UAT case or solving #1089 with latency injection") were
   scope fences for that implementation PR, not permanent harness rulings — #1105 is precisely the
   tracked issue that owns closing them (the issue's own Acceptance requires both fixmes gone).
2. **#1090 path: real scripted turn, not seeded thread rows.** A persisted thread is created by
   driving one real turn through the drawer against the scripted engine. No new seed chunk, no
   direct SQL into chat tables, no `UatSeedChunk` vocabulary change. This exercises the real
   persistence path (`chat-session-manager` → `ChatRepository`) instead of fabricating rows that
   could drift from it.
3. **#1089 path: Playwright route-hold on the real clear request, not a mocked transport.** The
   spec holds `POST /api/chat/clear` via `page.route`, asserts the blocked state, then
   `route.continue()`s to the **real backend** — the response, when delivered, is entirely real;
   only delivery timing is test-controlled, and the release is gated on assertions, not sleeps
   (fully deterministic, no race window guessing). This does not violate the harness's
   "no webServer/mocks" design: nothing is fulfilled with fabricated data. In-harness precedent:
   `tests/uat/specs/job-search-board.uat.spec.ts:347` already uses `page.route` +
   `route.continue()` on `/api/chat/turn`. The 1089 fixme's premise ("timing-control requires a
   mocked transport") is factually wrong — hold-then-continue is delay injection at the browser
   edge, not a mock.

## Engine-session invariant (load-bearing; derived from code, verify at build)

- `claude-print-chat-engine.ts:255` — first submit of an engine instance passes `--session-id`
  (new session), later submits `--resume`.
- The scripted fixture (`claude-main.ts:158-179`) starts a **new** session at script turn index 0
  and requires the unique `expectIncludes`-eligible turn to sit exactly at the cursor index;
  any mismatch fails closed with a named failure class in
  `/data/cli-auth/uat-scripted-provider-failures.log`.
- `chat-session-manager.ts:688` — an explicit thread resume **drops the live engine**, so the next
  turn launches a fresh engine session (index 0), with bounded prior context replayed into the
  prompt.

Consequence: design the script as a **single turn** with one marker present in every message the
spec sends, and ensure every scripted send is the *first* submit of a fresh engine session:

- Turn A (#1090 seed turn): fresh stack → fresh engine → index 0. ✓
- Turn B (#1090 post-resume turn): resume dropped the engine → fresh → index 0. ✓
- Turn C (#1089 closure turn): private activation's clear started a new server session → fresh
  engine → index 0. ✓

A single-turn script also removes the multi-turn ambiguity hazard: replayed prior context after a
resume contains earlier markers, and a multi-turn script would trip
`ambiguous-or-zero-eligible-turns`. Never send two scripted turns back-to-back inside one live
session in this spec — that would need index 1 and fail `turn-index-out-of-range` (loudly).

## Exact file changes

1. **`tests/uat/fixtures/chat-scripts/1105-drawer-private.json`** (new)
   ```json
   {"version":1,"turns":[{"expectIncludes":["UAT-1105"],"calls":[],"reply":"Scripted UAT-1105 reply."}]}
   ```
   `calls: []` is valid per `script-schema.ts` (only `turns` must be non-empty). Every message the
   spec sends contains the literal `UAT-1105`.

2. **`tests/uat/seed/types.ts`** — append `"1105-drawer-private"` to `UatChatScript` /
   `UAT_CHAT_SCRIPTS` (additive-registry pattern documented beside it). No other seed, provisioner,
   run-uat, compose, or Dockerfile change: `readUatLevel`'s regex and `writeUatEnvFile` already
   thread any registered id.

3. **`tests/uat/specs/1089-1090-chat-drawer-private.uat.spec.ts`** — full rewrite. Header:
   ```ts
   export const uatLevel = {
     level: "admin+data",
     without: [],
     withoutNewsJsonBinding: true,
     chatScript: "1105-drawer-private"
   } as const;
   ```
   - `admin+data` (not solo-admin): lands on AppShell, no onboarding wizard.
   - `withoutNewsJsonBinding: true` is **required**, same trap 1533 hit live: without it two active
     assistant providers leave no resolvable default and Send stays disabled
     (see `1533-chat-surface-live-path.uat.spec.ts` header, 2026-08-11 trace).
   - Field order in the header must match `run-uat.ts`'s anchored regex (level, without,
     withoutNewsJsonBinding, chatScript).
   - Copy (not import) the sign-in helper per UAT convention; `test.describe.configure({ mode:
     "serial" })`, **#1090 test first, #1089 second** (order is load-bearing: #1089 ends in an
     active private session; nothing runs after it).

## Test A — #1090 resume clears stale privateMode (real stack)

1. Sign in, open drawer ("Chat with Moss" dialog, as in the e2e).
2. Send `"UAT-1105 first persisted message"`; await the scripted reply text visible. A persisted
   (non-incognito) thread now exists via the real write path.
3. Click "Start private chat"; await the `.chatd-private` banner with "not saved" visible and the
   toggle `aria-pressed="true"` (real `POST /api/chat/clear {incognito:true}` round-trip).
4. Click "Show chat history"; the thread row for the step-2 message is listed (locate by a
   distinctive substring of the first message; confirm exact title derivation at build — the real
   `listThreads` filters `incognito = false`, so its very presence is the persistence proof).
5. Click the row (real `POST .../resume`, 204). Assert: step-2 message text visible (history
   hydration), toggle `aria-pressed="false"`, banner absent — mirror of
   `tests/e2e/chat-drawer.spec.ts` "#1090" assertions, now against real server truth.
6. Send `"UAT-1105 continue in resumed thread"`; await scripted reply; assert the "not saved"
   banner still absent — this post-send state is the exact regression surface #1090 fixed.

## Test B — #1089 private activation blocks send until real server confirm

1. Arm routes **before** clicking: (a) a held route on `**/api/chat/clear` capturing the route
   object without fulfilling or continuing; (b) a counting pass-through on `**/api/chat/turn`
   (`route.continue()`), as in job-search-board.
2. Click "Start private chat". While the clear is held: banner absent; fill composer with
   `"UAT-1105 send during activation"`, press Enter; assert turn counter is 0 (bounded
   `expect.poll`/short settle, same shape as the e2e's check).
3. Release: `route.continue()` the held clear → the **real backend** clears/creates the incognito
   session → banner with "not saved" appears, toggle `aria-pressed="true"`.
4. Closure: send `"UAT-1105 after activation"`; assert exactly one `POST /api/chat/turn` fired and
   the scripted reply renders — blocked-then-allowed proven end-to-end on the live stack.
5. `page.unroute` both routes at test end.

## Checks and acceptance

- **Automated:** eslint + prettier + tsc + file-size on the three touched files; targeted vitest
  for `tests/uat/seed` (registry/validation tests) and the scripted-provider fixture tests. Any
  DB-touching or gate command only via the `verify-gate` skill; never unscoped.
- **Live proof (the point of the issue):** one full harness run of this spec file via the standard
  `run-uat.ts` path with Playwright-result parsing (not exit-code trust). Evidence on the PR:
  scenario names, pass counts, screenshots; no prompts/replies beyond the fixture's own markers,
  no secrets. This run *is* the live-path gate for test infrastructure.
- **Acceptance (from #1105):** both scenarios run as real pass/fail — zero `test.fixme` in the
  file; the harness drives a real chat turn and opens a real persisted thread; default
  credential-free CI seed unchanged (registry addition is inert unless a spec opts in).
- **Explicitly out of scope:** `packages/chat/**` and all production code; provisioner/compose/
  Dockerfile; new env vars; new seed chunks; `1520-chat-drawer-queued-drain.uat.spec.ts` (its fixme
  cites the same stale premise but needs a second concurrent session design — file a follow-up
  note on #1520 rather than widening this PR); the e2e file (keeps its mocked-REST coverage).
- **Release note:** `Category: N/A` (test infrastructure, not user-visible).
- **PR hygiene:** reference #1105 with `Closes`; note in the PR body that the merged-with-waiver
  ruling from PR #1104 is retired by this conversion.

## Failure playbook (build agent)

Scripted-engine failures are fail-closed and named: read
`/data/cli-auth/uat-scripted-provider-failures.log` (script id, turn index, failure class only).
`ambiguous-or-zero-eligible-turns` → a sent message is missing the `UAT-1105` marker, or replayed
context broke uniqueness (should be impossible with a single-turn script);
`turn-index-out-of-range` → two sends hit one live engine session — restructure so each scripted
send follows a fresh-session boundary (stack boot, clear, or thread resume). "No AI provider is
connected yet" in the composer → the `withoutNewsJsonBinding` trap above. Two identical failures →
stop and report, do not retry-loop.

Plain-English handoff rule: any spawn prompt or status written from this plan must follow the
box-wide "Plain English, every agent" instruction in the operator's global CLAUDE.md — name things
by what they do; keep exact identifiers only where the reader must act on them. PASS THIS ON.
