# Implementation plan — #1556: context continuity + notes retrieval

- **Spec (approved):** `docs/superpowers/specs/2026-08-10-1553-context-continuity-and-notes-retrieval.md`
  (Ben approved 2026-08-10, after Codex adversarial review + revision; dispositions in
  `docs/coordination/2026-08-10-1553-1554-codex-review.md`)
- **Task issue:** #1556 (Part of #1553), project board 2
- **Plan authored:** 2026-08-10 (Fable fork). Seams verified against the **current working tree on
  disk** (the tree the build starts from), which may lag origin/main — re-run the seams table's
  greps if the tree moves before build start.
- **Consumers:** #1554/#1557 (persistent runtime) replays through the same `listPriorTurns`
  contract; nothing here may fork per-engine behavior.

## 0. Seams ledger — every capability cited, verified 2026-08-10

| #   | Capability the plan assumes            | Citation (working tree)                                                                                                                                                                                                                                                                  |
| --- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | Replay k resolution, unset→0 (the bug) | `packages/chat/src/live/persistence.ts:419-424` (`getReplayK`, `resolveMossEnv(process.env, "JARVIS_CHAT_REPLAY_K")`)                                                                                                                                                                    |
| S2  | Separate forceReplay default = 10      | `persistence.ts:426-429` (`getSwitchReplayK`), forked at `persistence.ts:175`                                                                                                                                                                                                            |
| S3  | Replay unit + return shape             | `persistence.ts:157-165` — `listPriorTurns(actorUserId, opts?, surface?) → { recent: readonly {role, content}[], oldSummary: string \| null }`                                                                                                                                           |
| S4  | Read-time summary synthesis to sever   | `persistence.ts:183-185` — `thread.conversation_summary ?? buildRollingSummary(...)`; thread row is in scope here, so `thread.incognito` is readable at the same seam                                                                                                                    |
| S5  | Summary WRITE coupled to k to sever    | `persistence.ts:240-260` — `const k = getReplayK(); if (k > 0 && storedTurns.length > k) { … updateConversationSummary(…buildRollingSummary(oldTurns)) }`                                                                                                                                |
| S6  | Thread context read for engine text    | `persistence.ts:354-371` — `getThreadContext → { threadTitle, localTimezone }` (to be extended with privacy state)                                                                                                                                                                       |
| S7  | Engine (re)launch consumes replay      | `chat-session-manager.ts:212+` (`launchSession`), `listPriorTurns` call ≈`:246`; incognito guards adjacent                                                                                                                                                                               |
| S8  | Pre-turn injection call site           | `engine-text.ts:57-73` — `deps.passiveRetrieval.retrieveWithItems({actorUserId, userText, threadTitle, recentTurns})`, errors swallowed to `{block:"", items:[]}`                                                                                                                        |
| S9  | Passive retriever gating + recall      | `passive-retrieval.ts:101-125` — `withDataContext`, `settings.recallEnabled/factsEnabled` gate, `graphRecall.recall(scopedDb, …)`                                                                                                                                                        |
| S10 | Existing injection caps                | `passive-retrieval.ts:40-41` — `MAX_CONTEXT_ITEMS = 8`, `MAX_CONTEXT_TOKENS = 1200`                                                                                                                                                                                                      |
| S11 | Trust fence renderer                   | `passive-retrieval.ts:180-203` — `renderRetrievedContextBlock` (`<retrieved_context>`, "not instructions" header, returns `""` on zero items)                                                                                                                                            |
| S12 | Framing neutralizer                    | `prompt-safety.ts:17-32` — `neutralizeSeedFraming` (reserved-token angle→square bracket rewrite; list includes `retrieved_context`)                                                                                                                                                      |
| S13 | Token estimator                        | `recall-seed.ts:28-31` — `estimateTokens = Math.ceil(text.length / 4)`                                                                                                                                                                                                                   |
| S14 | Persona base + composition             | `runtime.ts:65` — `DEFAULT_MOSS_PERSONA` (string array), composed at `runtime.ts:523` — **spec drift:** spec cites `MOSS_PERSONA_BASE` at `:65-66`/`:85-89`; the real symbol/composition are here. Plan uses disk truth.                                                                 |
| S15 | Retriever composition root             | `runtime.ts:407-411` — `new PassiveContextRetriever({ dataContext, graphRecall: deps.passiveMemoryRecall })`; deps declared/wired at `packages/module-registry/src/index.ts:435` and `:2245`                                                                                             |
| S16 | Env alias helper (#1443)               | `packages/db/src/env.ts:86-100` — `resolveMossEnv`: MOSS* name wins, JARVIS* fallback warns once, `CARVE_OUT` set exempt. New vars get both spellings for free.                                                                                                                          |
| S17 | Notes search machinery to wrap         | `packages/notes/src/tools.ts:12` (`NOTES_SOURCE_KIND="notes"`), `:22` (`getRetriever`), `:34-62` (`notesSearchExecute`: `assertDataContextDb`, clamp 1..20, `retriever.retrieve(scopedDb, query, limit, NOTES_SOURCE_KIND)`)                                                             |
| S18 | Vector retrieval + chunk shape         | `packages/memory/src/retrieval.ts:12-20` → `RetrievedChunk[]`; `packages/memory/src/repository.ts:14-21` — `{id, sourcePath, lineStart, lineEnd, text, similarity}` — **no `updatedAt`**, but the chunks table has `updated_at` (selected by the recency query, `repository.ts:329,345`) |
| S19 | Cross-module port precedent            | `packages/notes/src/commitment-provider.ts:1-13` — interface from `@moss/module-sdk` (scopedDb typed `unknown` at the boundary), implementation exported from notes `index.ts`, consumed at `module-registry/src/index.ts:273,1770`                                                      |
| S20 | Unit-test home + runner                | `tests/unit/chat-switch-replay.test.ts`, `tests/unit/chat-passive-retrieval.test.ts`, `tests/unit/chat-live-manager.test.ts` exist; runner `pnpm test:unit` (`package.json:54` → `tsx scripts/test-unit.ts`)                                                                             |
| S21 | Logging idiom in chat/live             | No structured logger seam exists (verified by grep); idiom is bare `console.warn` (`runtime.ts:108`, `claude-print-chat-engine.ts:167`). See D8.                                                                                                                                         |

**Uncitable / open questions** — see §6. Everything else the plan assumes is in the table.

## 1. Determinism boundary

- Every user-visible surface renders **from the record**. Replay and injection change only the
  engine's input; nothing is rendered into the thread. Visibility is structured log events only
  (D8). The no-prose acceptance check (spec AC-5) asserts a forced relaunch adds zero
  assistant-authored turns.
- The model gets exactly two jobs: **(a)** treat the replayed transcript + capped summary as
  conversational context; **(b)** follow the search-before-asking rule — call `notes.search`
  before claiming ignorance, using injected snippets when present.
- Total new prompt guidance is the one persona instruction in D7 — 43 words, budget 150.
- No model-authored values cross into user data anywhere in this plan (replay and injection are
  read paths), so the four-guard rule is not triggered.

## 2. Decisions

### D1 — Replay window constants and env

- `DEFAULT_REPLAY_MESSAGES = 40`, `REPLAY_TOKEN_CAP = 8000`, `SUMMARY_TOKEN_CAP = 1000`
  (module-level constants in the new `replay-window.ts`, D2).
- `getReplayK()` (S1) semantics change: **unset/empty → 40** (was 0); explicit `"0"` → 0 (valid
  opt-out); non-numeric or negative → 40 plus one `console.warn`. Env name stays
  `JARVIS_CHAT_REPLAY_K` via `resolveMossEnv` (S16) — MOSS alias free, #1443 respected.
- New sibling override `JARVIS_CHAT_REPLAY_TOKENS` (same resolver, same parse rules, default
  8000). No other new env vars.
- `getSwitchReplayK` (S2) is **deleted**; the fork at `persistence.ts:175` collapses to the one
  path. `forceReplay` stops carrying a different k — its remaining meaning (bypass any "already
  replayed" short-circuit, if one exists at call sites) is preserved by callers, not by a second
  default.

### D2 — Pure replay-window module

New file `packages/chat/src/live/replay-window.ts`, exports:

```ts
export interface ReplayMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export function selectReplayWindow(
  messages: readonly ReplayMessage[], // chronological, oldest first
  opts: { readonly maxMessages: number; readonly maxTokens: number }
): ReplayMessage[]; // chronological subset per spec rules

export function capSummary(summary: string, maxTokens: number): string;
```

Contract (from spec, restated as the function's law): take newest `maxMessages`; token-measure
each message as `estimateTokens(`\`${role}: ${content}\``)` (S13); drop **whole oldest** messages
until under `maxTokens`; if the single newest message alone exceeds the cap, truncate it
**head-first (keep the tail)**; an unpaired user-only newest message is kept as-is; output is
chronological. `capSummary` truncates the **tail** to `SUMMARY_TOKEN_CAP` and is applied to the
stored summary only. Pure functions — no DB, no env — so the deterministic tests (T1) need no
fakes.

`listPriorTurns` (S3) keeps its signature and return shape; internally it feeds
`selectReplayWindow` and returns the stored summary through `capSummary`. #1554's runtime
inherits the contract unchanged.

### D3 — Summary decoupled, read-only

- Read (S4): `oldSummary = thread.conversation_summary` capped by `capSummary`; **no**
  `buildRollingSummary` synthesis at read time. Absent/empty → `null`, nothing prepended.
- Write (S5): the gate changes from `k > 0 && storedTurns.length > k` to
  `storedTurns.length > DEFAULT_REPLAY_MESSAGES` (the constant, not the env) — summaries keep
  accruing for long threads regardless of operator replay overrides, and an opt-out operator
  (`k=0`) no longer silently kills summary maintenance. `buildRollingSummary` survives only on
  this write path.

### D4 — Incognito replays nothing, enforced server-side

In `listPriorTurns`, if `thread.incognito` (readable at S4's seam): return
`{ recent: [], oldSummary: null }` before any window work. The existing launch-time guards (S7)
stay; this makes the guarantee hold even if a future call site forgets. Passive injection skip
for incognito is D9.

### D5 — Notes-recall port (declared public API, module isolation)

Interface in `@moss/module-sdk` (mirror S19's precedent, `scopedDb: unknown` at the boundary):

```ts
export interface NotesRecallSnippet {
  readonly notePath: string; // owner-scoped path relative to the notes root
  readonly modifiedAt: Date;
  readonly score: number; // similarity, 0..1
  readonly text: string; // sanitized snippet text
}

export interface NotesRecallProvider {
  readonly sourceKind: "notes";
  search(
    scopedDb: unknown,
    actorUserId: string,
    query: string,
    opts: { readonly limit: number }
  ): Promise<NotesRecallSnippet[]>;
}
```

Implementation `packages/notes/src/recall-provider.ts`, exported from
`packages/notes/src/index.ts` as `notesRecallProvider`. It asserts `assertDataContextDb`, then
wraps `getRetriever(...).retrieve(scopedDb, query, limit, NOTES_SOURCE_KIND)` (S17/S18). Chat
never imports notes internals; it sees only the sdk interface.

**Supporting memory change:** `RetrievedChunk` (S18) gains `readonly updatedAt: Date`, populated
by adding `updated_at` to `vectorSearch`'s SELECT — the column exists (`repository.ts:329`).
Additive field; no migration, no DDL. Existing consumers are unaffected by an added field.

**Wiring:** `ChatRoutesDependencies` gains `notesRecall?: NotesRecallProvider`
(`module-registry/src/index.ts:435` block); implementation supplied beside `passiveMemoryRecall`
(`:2245` block) from the notes export; threaded into `new PassiveContextRetriever({...})` at
`runtime.ts:407-411`. RLS scoping rides the existing `withDataContext` call (S9) — the port is
always called under the actor's scoped db, owner-only per the notes RLS class.

### D6 — Timeboxed search-quality research step (before tuning)

Phase 2 opens with a **4-hour timeboxed spike** on the live dev instance against a realistic
vault. Protocol: 10 fixed queries (5 fact-lookup, 3 recent-work, 2 vague-recall) written down
before running; for each, record top-5 from (a) `vectorSearch` as-is and (b) recency-blended
(`retrieveRecent` union, S18); judge relevance manually; output
`docs/research/2026-08-10-1556-notes-retrieval-quality.md` with per-query judgments and two
outcomes: the minimum-score threshold for injection, and whether recency blending is in or out
of scope for this build. **The Phase 3 constants ship only with values the spike justifies**;
absent a clear result, ship threshold-only (no blending) and file a follow-up issue.

### D7 — Persona rule (the only prompt change)

Append one string to `DEFAULT_MOSS_PERSONA` (S14). Exact text (43 words, provider-neutral):

> When the user asks about facts, plans, or details that might be in their notes, search notes
> first instead of asking them or saying you don't know. Open a matching note if the snippet is
> not enough. Ask the user only when search finds nothing.

### D8 — Structured log events (visibility)

No logger seam exists (S21); inventing one is out of scope. Decision: single-line JSON on
`console.info`, shape `{ event, threadId, ... }` — never message/snippet content. Events:

- `chat.replay.injected` — `{ threadId, messageCount, tokenCount, summaryTokens, trigger: "launch" | "relaunch" | "switch" }`
- `chat.notes_recall.injected` — `{ threadId, snippetCount, tokenCount, latencyMs }`
- `chat.notes_recall.skipped` — `{ threadId, reason: "latency" | "error" | "incognito" | "recall_disabled" | "empty" }`
- `chat.notes_recall.snippet_dropped` — `{ threadId, notePath, reason: "credential" }`

### D9 — Pre-turn injection path

- `getThreadContext` (S6) return gains `readonly incognito: boolean` (thread absent → `false`
  path unchanged). `engine-text.ts` (S8) passes it into the retriever input.
- `PassiveContextRetriever` deps gain `notesRecall?: NotesRecallProvider`. Input gains
  `incognito: boolean`. Gating, asserted **at the port** (spec): if `incognito` or
  `!settings.recallEnabled` (S9), the notes port is **never called** — tested with a spy (T3).
  Incognito also skips the whole passive block (spec: injection skipped).
- Constants in `passive-retrieval.ts` beside S10: `NOTES_MAX_SNIPPETS = 5`,
  `NOTES_MAX_TOKENS = 2000`, `NOTES_LATENCY_BUDGET_MS = 500`. Latency enforced by racing the
  port call against a 500 ms timer; on timeout or thrown error the notes contribution is dropped
  (graph recall unaffected) and a `skipped` event logs. Values below the score threshold from D6
  are filtered before capping.
- Rendering: notes snippets join the existing `<retrieved_context>` fence (S11) as items tagged
  `` `${notePath} (modified ${isoDate})` ``; snippet text passes through `neutralizeSeedFraming`
  (S12) before rendering. One fence, one trust header — no second framing vocabulary.

### D10 — Fail-closed credential screen

New file `packages/chat/src/live/secret-screen.ts` (no existing utility — verified S21 sweep):

```ts
export function looksLikeCredential(text: string): boolean;
```

Pattern set (a plan decision; the fail-closed disposition is spec, not negotiable): PEM blocks
(`-----BEGIN\s[A-Z ]*KEY`), AWS key ids (`AKIA[0-9A-Z]{16}`), GitHub tokens
(`gh[pousr]_[A-Za-z0-9]{20,}` / `github_pat_`), Slack (`xox[baprs]-`), JWTs
(`eyJ[A-Za-z0-9_-]{10,}\.eyJ`), generic assignment
(`(password|passwd|secret|api[_-]?key|token)\s*[:=]\s*\S{8,}`), and private-key-material base64
runs ≥ 40 chars on a line matching a key-ish label. A match drops the **whole snippet** (log
event D8, path only) — never truncate-and-keep. Applied to every snippet before rendering.
Regression test T3-d is mandatory (spec).

## 3. Phases

Phase 1 ships alone and is judged at the kill gate before Phases 2–3 are built.

### Phase 1 — Replay contract (D1–D4, D8 replay event)

Files: `persistence.ts`, new `replay-window.ts`, `chat-session-manager.ts` (only if the
forceReplay collapse touches its call), tests.

**Tests (T1, T2)** — `tests/unit/chat-replay-window.test.ts` (new, pure) and updates to
`tests/unit/chat-switch-replay.test.ts` + the fake-engine input assertions in the existing
manager tests (S20). Each stated as behaviour + why it fails against a broken build:

- T1-a **Normative example**: 50 messages × ~300 tokens → exactly messages 25–50 (newest 26),
  chronological. Fails if the window takes 40 without token-trimming, trims newest-first, or
  returns reversed order.
- T1-b **Message bound**: 60 × 10-token messages → exactly newest 40. Fails if only the token
  cap is applied.
- T1-c **Oversized newest**: single 12k-token message → one message, head-truncated to 8k,
  tail preserved (assert the tail substring survives, the head substring does not). Fails on
  tail-truncation or drop-entirely implementations.
- T1-d **Unpaired user turn**: newest message user-role with no assistant pair → included
  as-is. Fails if the window insists on pairs.
- T1-e **Explicit opt-out**: `JARVIS_CHAT_REPLAY_K=0` → empty replay; unset → 40. Fails against
  "0 and unset both mean default" or the old "unset means 0" behavior.
- T1-f **Summary cap**: 2k-token stored summary → tail-truncated to 1,000 tokens, prepended
  outside the 8k budget (window still gets full 8k). Fails if summary eats the replay budget.
- T2-a **Decoupling, no write**: with replay opt-out (`k=0`) and 45 stored turns, the summary
  write still fires; with 30 stored turns it does not (threshold is the constant 40). Fails
  against the old `k > 0` gate.
- T2-b **Read is read-only**: thread with no stored summary → `oldSummary === null` and
  `buildRollingSummary` is not invoked on the read path (spy). Fails against S4's synthesis.
- T2-c **Incognito zero-replay**: incognito thread with 50 stored turns → engine input contains
  no prior turns and no summary (asserted from the fake engine's received input). Fails if only
  the launch-time guard (S7) is relied on and the persistence path leaks.
- T2-d **forceReplay collapse**: with unset env, forceReplay and plain launch produce identical
  windows (40); `getSwitchReplayK` no longer exists (compile-level). Fails if the 10-default
  survives.

**Verification** (expected `EXIT=0` on each):

```bash
pnpm test:unit tests/unit/chat-replay-window.test.ts > /tmp/1556-p1a.log 2>&1; echo "EXIT=$?"
pnpm test:unit tests/unit/chat-switch-replay.test.ts tests/unit/chat-live-manager.test.ts > /tmp/1556-p1b.log 2>&1; echo "EXIT=$?"
```

Full gate before PR (DB-touching — **run only under the `verify-gate` skill**):

```bash
pnpm verify:foundation > /tmp/1556-p1-gate.log 2>&1; echo "EXIT=$?"
```

**e2e (live-path gate, executed and recorded on the PR):** on a live dev instance — seed a
drawer thread past 40 turns with an early distinctive fact, kill the engine session (forced
relaunch), then ask a continuity question that only the replayed window can answer; assert and
record the correct answer text. Same run performs the **no-prose check** (spec AC-5): the forced relaunch
adds zero visible turns; and a `chat.replay.injected` log line with plausible counts is captured
from the server log.

### KILL GATE (after Phase 1) — owner: **Ben**

Named observation: on the live dev instance with replay default-on, either **(a)** the
continuity e2e above fails or regresses existing drawer behavior, or **(b)** relaunch becomes
noticeably slower to first token in normal drawer use (Ben's judgment on dev), or **(c)**
replay-driven token overhead is deemed not worth it at up-to-8k input per relaunch. Any of
these ends the line here: Phase 1 is still a strict improvement (bug fix: unset no longer means 0) and can stand alone; Phases 2–3 do not start until Ben clears the gate.

### Phase 2 — Notes port + spike + persona (D5, D6, D7)

Files: `packages/module-sdk` (interface), `packages/notes/src/recall-provider.ts` + `index.ts`,
`packages/memory/src/repository.ts` + `retrieval.ts` (`updatedAt`), `module-registry/src/index.ts`
(wiring), `runtime.ts` (persona string + dep threading), spike doc.

Order inside the phase: spike (D6) first — its threshold/blending outcome is an input to Phase 3
constants and may adjust the port's `opts` (e.g. add a `minScore`).

**Tests:**

- T-port-a: port returns owner-scoped `notePath`, `modifiedAt`, `score`, `text` for seeded
  chunks (integration-style against the existing notes test fixtures). Fails if `updatedAt`
  never reaches `RetrievedChunk` or paths leak absolute roots.
- T-port-b: empty query → `[]` without a retriever call (mirror `tools.ts:34-62` behavior).
- T-persona: unit assert `DEFAULT_MOSS_PERSONA` joined text contains the D7 sentence once —
  guards accidental drop at the `runtime.ts:523` composition. (Substring-of-prose assertions are
  a known smell; one stable sentence, one assertion, no per-round growth.)

**Verification** (expected `EXIT=0`; integration run under `verify-gate` skill):

```bash
pnpm test:unit tests/unit/chat-persona.test.ts > /tmp/1556-p2a.log 2>&1; echo "EXIT=$?"
pnpm test:integration tests/integration/notes-recall-port.test.ts > /tmp/1556-p2b.log 2>&1; echo "EXIT=$?"
```

**e2e (live-path gate):** live dev — seed a note containing a fact, ask the drawer a question
answerable only from that note, observe the model call `notes.search` **before** answering (tool
call visible in transcript/log) and answer correctly; record on PR. This proves D7 through the
real wiring (`wired-not-just-defined`), not just the manifest.

### Phase 3 — Pre-turn injection (D8–D10)

Files: `passive-retrieval.ts`, `engine-text.ts`, `persistence.ts` (`getThreadContext`), new
`secret-screen.ts`, `runtime.ts`/`module-registry` (dep already threaded in Phase 2), tests.

**Tests (T3)** — extend `tests/unit/chat-passive-retrieval.test.ts` with a fake
`NotesRecallProvider`:

- T3-a **Caps + provenance + fence**: 8 fake snippets → exactly 5 rendered, ≤2,000 tokens, each
  tagged with path + modified date, all inside one `<retrieved_context>` fence, snippet text
  neutralized (S12). Fails if caps are unenforced, provenance dropped, or a second fence
  vocabulary appears.
- T3-b **Latency budget**: port resolving after 600 ms → zero notes items, graph items intact,
  `skipped(reason:"latency")` logged. Fails if the turn blocks on the port or the whole
  injection dies.
- T3-c **Port error**: port rejects → turn proceeds, graph items intact, `skipped(reason:
"error")` logged. Fails if the S8 catch-all is the only guard (it would also eat graph items).
- T3-d **Credential drop (regression-mandatory)**: snippet containing an AWS key / PEM block →
  snippet absent entirely (not truncated), `snippet_dropped` logged without content. Fails
  against truncate-and-keep or pattern-miss.
- T3-e **Server-truth gating**: incognito input, and separately `recallEnabled=false` → port
  spy never called. Fails if gating happens after the call or only in the UI.

**Verification** (expected `EXIT=0`):

```bash
pnpm test:unit tests/unit/chat-passive-retrieval.test.ts > /tmp/1556-p3a.log 2>&1; echo "EXIT=$?"
pnpm verify:foundation > /tmp/1556-p3-gate.log 2>&1; echo "EXIT=$?"   # verify-gate skill only
```

**e2e (live-path gate):** live dev — (1) seed a note with a distinctive fact, ask a related
question **without** naming the note: answer reflects the fact with no explicit search request
(injection working), `chat.notes_recall.injected` captured; (2) same question in an incognito
thread: no injection event, `skipped(reason:"incognito")` present; answer assertions + log excerpts
on the PR.

## 4. Rollout

Default-on behavior change; no migration, no new tables, no feature flag (spec). Operator
opt-outs: `JARVIS_CHAT_REPLAY_K=0` (replay), existing `recallEnabled` setting (injection).
Release-note line for the PR: "Moss now remembers the current conversation across restarts and
quietly checks your notes before answering — private chats stay stateless."

## 5. Rulings ledger (facts that outlive this plan)

- Spec citation drift: `MOSS_PERSONA_BASE` does not exist; the symbol is `DEFAULT_MOSS_PERSONA`
  (`runtime.ts:65`), composed at `runtime.ts:523`.
- `RetrievedChunk` carries no timestamp today; the chunks table does (`repository.ts:329`).
- No structured logger seam exists in `packages/chat/src/live` — console idiom only.
- No credential/secret-pattern screen exists anywhere in `packages/chat` or `packages/shared`
  today — the injection path currently has **no** secret filter (the fence header is the only
  defence).
- `forceReplay`'s 10-message default (`getSwitchReplayK`) exists solely because `getReplayK`
  defaults to 0 — collapse is safe once the real default is 40.
- The engine-text catch-all (`engine-text.ts:57-73`) hides _all_ retrieval errors — per-source
  error handling must live inside the retriever (T3-c), or notes failures silently kill graph
  recall too.
- Codex review dispositions for #1553 (all accepted): window unit defined as persisted message;
  summary read-only + decoupled; port + fail-closed credential filter; server-truth gating —
  ledgered in `docs/coordination/2026-08-10-1553-1554-codex-review.md`.

## 6. Open questions

1. **Summary write threshold constant** (D3): the constant-40 gate is this plan's decision, not
   spec text — spec only demands decoupling. Flagged for the plan reviewer; if rejected, the
   fallback is "always write when `storedTurns.length > 40 ∧ length changed", same constant.
   Owner: plan reviewer (Fable review pass), escalate to Ben only if contested.
2. **Recency blending in scope?** Deliberately deferred to the D6 spike's outcome. Owner: the
   build agent, bound by the spike doc; follow-up issue if out.
3. **`JARVIS_CHAT_REPLAY_TOKENS` naming** — new var, not in the #1443 `CARVE_OUT` set, so
   `resolveMossEnv` gives it MOSS-preferred dual spelling automatically. No action unless the
   carve-out list is meant to enumerate every new var — owner: build agent to confirm against
   `packages/db/src/env.ts` `CARVE_OUT` comment at build time.

## Checklist (plan-build)

- [x] Spec approved (Ben, 2026-08-10) and task issue #1556 open
- [x] Every assumed capability cited `file:line` (S1–S21) or listed in §6
- [x] No function bodies — signatures, constants, contracts, test cases only
- [x] Determinism boundary stated; prompt guidance 43/150 words
- [x] Each phase names its e2e test on a live dev instance
- [x] Every verification command unpiped with expected exit code; DB-touching runs marked verify-gate-only
- [x] Kill gate after Phase 1 named, owner Ben
- [x] Design forks steelmanned in-line (D3 threshold, D6 blending); milestone-level adversarial review already done at spec stage (Codex)
