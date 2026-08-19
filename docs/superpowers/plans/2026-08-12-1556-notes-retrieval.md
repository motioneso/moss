# Plan — #1556 Notes-default retrieval (Phase 2 of #1553 spec)

Spec: `docs/superpowers/specs/2026-08-10-1553-context-continuity-and-notes-retrieval.md` §"Notes
retrieval defaulting" (lines 119-159) + acceptance criteria 2, 4, 5 (lines 170-182). Task issue:
#1556 ("Part of #1556"), risk tier **sensitive** (standard QA + invariant check + matched e2e-UAT,
no Ben merge-sign-off pause). Phase 1 of the parent spec (replay) already merged, PR #1562 — not
this plan's scope.

Seams check for this plan lives in `docs/superpowers/handoffs/2026-08-12-1556-notes-retrieval-relay.md`
and `...-relay-2.md` — citations below are pulled from there plus this session's confirming reads;
not re-derived.

## Determinism boundary

- The persona gets exactly one new instruction: search notes before asking, when the message
  plausibly touches stored information. That's the model's only new job here — everything else
  (snippet selection, ranking, truncation, redaction, gating) is deterministic code, not a model
  decision.
- No UI feedback in this feature is model-authored: there is no user-visible acknowledgement of
  "notes were searched" — injection is silent pre-turn context, same as existing passive fact
  recall. Nothing here routes a deterministic confirmation through a model turn.
- Injected snippets are wrapped in the existing `<retrieved_context>`-style fence +
  `neutralizeSeedFraming` (`packages/chat/src/live/passive-retrieval.ts:180-204`,
  `packages/chat/src/live/prompt-safety.ts:17-32`) — data, never instructions.
- Persona addition budget: well under 150 words (see Task 8 exact text).

## Phase 1 — notes-recall port + provenance + fail-closed filter + server-truth gating (kill-gated)

All deterministic, fake-engine/fake-port unit tests only. No live wiring. Ships and is evaluated
alone before Phase 2 is planned in further detail.

**Kill gate:** if the fail-closed credential filter or the incognito/recallEnabled gating cannot be
proven correct by deterministic test (acceptance 2d, 2e) before Phase 2 starts, Phase 2 does not
proceed until it is. Owner: whoever picks up Phase 2 build — re-run Task 5's and Task 7's tests and
confirm green before starting Task 9.

### Task 1 — expose `updated_at` on `vectorSearch()`

File: `packages/memory/src/repository.ts`.

- `RetrievedChunk` (line 14-21) gains `readonly updatedAt: Date`.
- `vectorSearch()` (line 115-149): add `c.updated_at` to the `SELECT` list (alias `updated_at`),
  add `updatedAt: r.updated_at` to the mapped return. Column already exists and defaults
  `DEFAULT now()` (`packages/memory/sql/0030_memory_index.sql:14`); `upsertFileChunks`
  (repository.ts:55-79) always delete-then-inserts per chunk (never in-place `UPDATE`), so the
  column is reliably fresh on every re-ingest — no trigger, no migration needed.
- No other `vectorSearch()` caller (`listRecentChunks`, briefings' hybrid vault retrieval) breaks:
  it's an additive field on an existing return type.

Test: extend `tests/unit/` memory-repository coverage (or add adjacent to existing vectorSearch
tests) — insert a chunk, call `vectorSearch`, assert `updatedAt` is a `Date` matching the DB row's
`updated_at`. This is the one DB-touching test in Phase 1; run under the `verify-gate` skill only.

### Task 2 — declared public notes-recall port on `@moss/notes`

New file `packages/notes/src/recall.ts`, exported from `packages/notes/src/index.ts`. This is the
module-isolation boundary: chat consumes only this export, never `packages/notes` internals or its
tables directly (mirrors the existing `notesSearchExecute` tool boundary in
`packages/notes/src/tools.ts:34-62`, which itself goes through `MemoryRetriever`/`MemoryRepository`
— the new port is a second, differently-shaped entry point onto the same underlying retrieval, not
a new data path).

```ts
export interface NotesRecallSnippet {
  readonly sourcePath: string; // owner-scoped relative note path
  readonly updatedAt: Date; // modified time, from memory_chunks.updated_at
  readonly score: number; // vectorSearch() similarity
  readonly text: string; // sanitized snippet text (pre-secret-filter; filter runs in chat)
}

export interface NotesRecallPort {
  recall(
    scopedDb: DataContextDb,
    ownerUserId: string,
    query: string,
    options: { readonly limit?: number }
  ): Promise<{ readonly snippets: readonly NotesRecallSnippet[] }>;
}

export function createNotesRecallPort(): NotesRecallPort;
```

`createNotesRecallPort()` implementation mirrors `getRetriever`/`notesSearchExecute`
(`packages/notes/src/tools.ts:22-51`): resolve embedding config, build a `MemoryRetriever`, call
`.retrieve(scopedDb, query, limit, "notes")`, map `MemoryRepository`'s `RetrievedChunk` (now
carrying `updatedAt` per Task 1) to `NotesRecallSnippet` (`sourcePath`, `updatedAt`, `score:
similarity`, `text`). Cap `limit` the same way (`DEFAULT_LIMIT = 8`, `MAX_LIMIT = 20`) — the 5-item
injection cap is applied later, in chat, not here (this port can return more than 5; the retriever
selects the top 5 that fit the token budget).

Test: `tests/unit/notes-recall.test.ts` (new) — fake `MemoryRetriever`-shaped dependency, assert
the port maps fields correctly and respects the limit clamp. No DB.

### Task 3 — fail-closed credential/secret filter

New file `packages/chat/src/live/notes-secret-filter.ts`. Runs in chat (not in `@moss/notes`)
because the invariant it enforces — secrets never reach an AI prompt — is a chat/prompt-boundary
concern, not a notes-storage concern; notes are allowed to store credential-shaped text, chat is
never allowed to inject it.

```ts
export function isCredentialShaped(text: string): boolean;
```

Pattern set (plan decision, spec only fixes the fail-closed _disposition_): private-key/PEM block
headers (`-----BEGIN ... PRIVATE KEY-----`), `password[:=]`-shaped lines with a non-trivial value,
common token shapes (`Bearer `, `Authorization:`, `api[_-]?key`, `secret`, long
base64/hex-looking runs adjacent to those keywords), env-var-assignment lines whose key name
contains `KEY`/`SECRET`/`TOKEN`/`PASSWORD`. No existing repo-wide detector exists to extend —
`packages/ai/src/adapters/redact.ts:12-19` is narrow (MCP-token/Bearer/`jst_` shapes only, scoped
to multiplexer error text) and not reusable here.

Disposition: a matching snippet is **dropped entirely**, never truncated-and-kept, and the drop is
logged (event only, no snippet content in the log line). Applied by the retriever (Task 5) per
snippet, before any snippet counts toward the 5-item / 2,000-token cap.

Test: `tests/unit/notes-secret-filter.test.ts` (new) — table of credential-shaped and
non-credential-shaped strings; assert classification. This is the acceptance-2d falsifier
(credential-shaped snippet ⇒ dropped, never reaches engine input) at the unit level; Task 5's
retriever test re-proves it at the integration (port → block) level.

### Task 4 — server-truth incognito gating

Files: `packages/chat/src/live/persistence.ts`, `packages/chat/src/live/chat-session-ports.ts`,
`packages/chat/src/live/engine-text.ts`.

- `ChatPersistencePort.getThreadContext` (`chat-session-ports.ts:73-76`) return type gains
  `incognito: boolean`.
- `ChatLivePersistence.getThreadContext` (`persistence.ts:384-401`) already has `thread` in scope
  (line 391, from `this.chat.getCurrentThread(...)`) — add `incognito: thread?.incognito ?? false`
  to the returned object. Same pattern already used at `getCurrentThreadState`
  (`persistence.ts:346-355`) and `persistence.ts:353`.
- `EngineTextDeps.persistence` (`engine-text.ts:23`) stays `Pick<ChatPersistencePort,
"listPriorTurns" | "getThreadContext">` — no change needed there, the `Pick` already carries
  whatever `getThreadContext` returns. `buildEngineText`'s `threadCtx` destructuring
  (`engine-text.ts:41,49,52,62,69,81,101`) gains access to `threadCtx.incognito`.

Test: extend `tests/unit/` coverage for `getThreadContext`/`ChatLivePersistence` (fake `chat`
collaborator) asserting `incognito` round-trips from `getCurrentThread`'s row. No behavior change
yet for existing callers (additive field) — this task only threads the value through; Task 5 uses
it.

### Task 5 — `NotesContextRetriever`

New class in a new file `packages/chat/src/live/notes-retrieval.ts`, mirroring
`PassiveContextRetriever`'s constructor-injection shape exactly
(`packages/chat/src/live/passive-retrieval.ts:55-152`, test fixture shape confirmed in
`tests/unit/chat-passive-retrieval.test.ts:174-190,235-256,279-290`).

```ts
export interface NotesContextRetrieverDeps {
  readonly dataContext: Pick<DataContextRunner, "withDataContext">;
  readonly notesRecall: NotesRecallPort; // from @moss/notes (Task 2)
  readonly settingsRepo?: {
    getOrCreate(scopedDb: DataContextDb, userId: string): Promise<UserMemorySettings>;
  };
}

export class NotesContextRetriever {
  constructor(deps: NotesContextRetrieverDeps);
  retrieveWithItems(input: {
    readonly actorUserId: string;
    readonly userText: string;
    readonly threadTitle: string | null;
    readonly recentTurns: readonly { role: "user" | "assistant"; content: string }[];
    readonly incognito: boolean;
  }): Promise<{ block: string; items: readonly NotesRecallSnippet[] }>;
}
```

Behavior:

- Gate first, before any query: `input.incognito ⇒ return { block: "", items: [] }` immediately
  (asserted at the port per spec — "never inferred from the UI"). Then
  `settingsRepo.getOrCreate(...).recallEnabled` — same repo/method as
  `PassiveContextRetriever` (`ChatUserMemorySettingsRepository`,
  `packages/chat/src/memory-settings-repository.ts:23-39`), independent of `factsEnabled` (notes
  gating doesn't check `factsEnabled` — that flag is fact-recall-specific).
  Acceptance 2e.
- Own 500 ms timeout, reusing `withPassiveRetrievalTimeout` (`passive-retrieval.ts:227-242`) —
  spec requires notes' own 500 ms budget distinct from the outer 750 ms passive-retrieval timeout.
  Acceptance 2b: timeout ⇒ `{ block: "", items: [] }`, turn proceeds.
- Query construction: reuse `planPassiveRetrieval`'s decision text as the query when
  `shouldRetrieve` (no separate notes-specific trigger heuristic — same "does this plausibly touch
  stored information" signal drives both fact-recall and notes-recall). If `!shouldRetrieve`,
  skip the notes call too (consistent with the persona's own "search when plausible" framing, and
  avoids a query on every turn).
- On success: run each `NotesRecallSnippet.text` through `isCredentialShaped` (Task 3); drop
  matches, log the drop event. From the remainder, keep at most 5, capped at 2,000 tokens total
  (`estimateTokens`, `packages/chat/src/live/recall-seed.ts`), highest `score` first.
- Any port error (including `notesRecall.recall` throwing) ⇒ caught, `{ block: "", items: [] }`,
  logged. Acceptance 2c.
- Render via new `renderNotesContextBlock` (Task 6).

Test: `tests/unit/chat-notes-retrieval.test.ts` (new), same fixture shape as
`chat-passive-retrieval.test.ts` — fake `dataContext.withDataContext`, fake `settingsRepo`, fake
`notesRecall`. Cases: incognito skips the port entirely (2e); `recallEnabled: false` skips the
port entirely (2e); slow port (timeout) ⇒ empty block, port promise not awaited further (2b); port
throws ⇒ empty block (2c); >5 snippets or >2,000 tokens ⇒ truncated to cap with provenance intact
(2a); credential-shaped snippet ⇒ dropped, remaining snippets still injected (2d).

### Task 6 — `renderNotesContextBlock`

File: `packages/chat/src/live/chat-context-blocks.ts` (currently 33 lines, full file read — see
seams check), next to `combineHiddenContextBlocks`.

```ts
export function renderNotesContextBlock(
  snippets: readonly { sourcePath: string; updatedAt: Date; text: string }[]
): string;
```

Not the fact-shaped `MemoryRecallItem` schema (confidence/status/provenance tiers don't apply —
notes provenance is path + modified-time, plan decision already made, not re-litigated). Structure
mirrors `renderRetrievedContextBlock` (`passive-retrieval.ts:180-204`): a
`<retrieved_context>`-fenced block, each line tagged `[<sourcePath> modified=<ISO date>]
<neutralizeSeedFraming(text)>`, empty snippet list ⇒ `""`. Reuses `neutralizeSeedFraming`
(`prompt-safety.ts:17-32`) per snippet — same untrusted-content fence as fact recall.

`combineHiddenContextBlocks` (`chat-context-blocks.ts:23-32`) gains a third optional parameter:

```ts
export function combineHiddenContextBlocks(
  passiveBlock: string,
  crossToolBlock: string,
  notesBlock?: string
): string;
```

Combined cap stays 2,000 tokens across all present blocks (extend the existing pairwise
token-budget logic to the 2/3-block case: sum all present blocks' tokens; if over cap, drop lowest
priority first — order of priority: passive (facts) > cross-tool > notes, since facts/cross-tool
existed first and notes is strictly additive this phase). State the exact drop order in code
comments, not prose, since it's a tie-breaking decision a future reader needs at the call site.

Test: extend whatever existing test file covers `chat-context-blocks.ts` (or add
`tests/unit/chat-context-blocks.test.ts` if none exists — confirm via search before creating) with
2-block and 3-block combination cases, including the new drop-order case.

### Task 7 — Phase 1 verification

```bash
pnpm --filter @moss/memory test -- run > /tmp/1556-memory.log 2>&1; echo "EXIT=$?"
pnpm --filter @moss/notes test -- run > /tmp/1556-notes.log 2>&1; echo "EXIT=$?"
pnpm --filter @moss/chat test -- run > /tmp/1556-chat.log 2>&1; echo "EXIT=$?"
```

Expected exit code: `0` for all three. The one DB-touching test (Task 1) runs under the
`verify-gate` skill, not ad hoc — do not run `pnpm verify:foundation` directly (project CLAUDE.md
hard rule).

**Kill-gate checkpoint:** before starting Task 9, re-confirm Task 3's and Task 5's tests are green
on the branch head. Owner: builder starting Phase 2.

## Phase 2 — persona rule, live wiring, UAT

### Task 8 — persona search-before-asking instruction

File: `packages/chat/src/live/runtime.ts`. Real symbols (spec's own citation,
`DEFAULT_MOSS_PERSONA`/`:523`, is stale/doesn't exist on this branch — confirmed drift, use these
instead): `MOSS_PERSONA_BASE` (`runtime.ts:71`), composed by `composeMossPersona(surface)`
(`runtime.ts:90-95`), used at `runtime.ts:687`.

Add one new persona constant, included in `composeMossPersona` for every surface (unlike
`MOSS_PERSONA_APP_MAP`, which is drawer-only):

```ts
export const MOSS_PERSONA_NOTES_SEARCH =
  "When the user's message plausibly touches something they may have written down — people, " +
  "meetings, decisions, plans — search their notes first and answer from what you find; ask " +
  "only when the search comes up empty.";
```

Provider-neutral, no vendor names, no tool name mentioned (the tool itself, `notes.search`, is
already declared to the model via its own schema — the persona line is the "search first, ask
second" behavioral instruction, not tool documentation). ~45 words — well under the 150-word
guidance budget.

`composeMossPersona` (`runtime.ts:90-95`) gains this in `parts`, all surfaces:

```ts
function composeMossPersona(surface: ChatSurface): string {
  const parts = [MOSS_PERSONA_BASE, MOSS_PERSONA_NOTES_SEARCH];
  if (surface === DEFAULT_CHAT_SURFACE) parts.push(MOSS_PERSONA_APP_MAP);
  parts.push(MOSS_PERSONA_TOOL_RESULT_DEFENSE);
  return parts.join("\n");
}
```

Test: extend whatever unit test covers `composeMossPersona`/persona composition (search before
creating new) — assert the new line is present in composed output for both drawer and non-drawer
surfaces.

### Task 9 — live wiring

Composition root, mirroring `passiveMemoryRecall`/`PassiveContextRetriever` exactly at each layer:

1. **`packages/chat/src/live/runtime.ts`** — deps type (near line 340) gains
   `readonly notesRecall?: NotesRecallPort;`. Construction (near lines 555-560) gains:

   ```ts
   notesRetrieval: deps.notesRecall
     ? new NotesContextRetriever({ dataContext: deps.dataContext, notesRecall: deps.notesRecall })
     : undefined,
   ```

   passed alongside `passiveRetrieval` into whatever constructs `EngineTextDeps` downstream (same
   call site that assembles `passiveRetrieval`/`crossToolRead`/`priorityModel` today).

2. **`packages/chat/src/live/engine-text.ts`** — `EngineTextDeps` gains
   `readonly notesRetrieval?: NotesContextRetriever;` (or a narrower `Pick`, matching the
   `passiveRetrieval?: PassiveRetrievalPort` pattern at line 24). `buildEngineText`'s early-return
   guard (line 35, `if (!deps.passiveRetrieval && !deps.crossToolRead)`) extends to include
   `&& !deps.notesRetrieval`. The `Promise.all` at lines 56-84 gains a third parallel fetch —
   notes runs concurrently with passive + cross-tool, not sequentially after — passing
   `threadCtx.incognito` (Task 4) into the call. `combineHiddenContextBlocks` call (line 115)
   gains the third `notesBlock` argument (Task 6). `pendingItems` (lines 110-113) gains a mapped
   entry for notes items, following the same `idx++` pattern as `memoryItems`/`crossToolItems` —
   needs an `AnswerSourceSupport`-shaped mapper for `NotesRecallSnippet`
   (`sourcePath`/`updatedAt` in, provenance chip out); name it `notesItemToSupport` in
   `answer-provenance.js`, matching `memoryItemToSupport`/`crossToolItemToSupport`
   (`engine-text.ts:11`).

3. **Real caller wiring** — `packages/chat/src/routes.ts` (`ChatRoutesDependencies`, near line
   103 where `passiveMemoryRecall` is declared, and near line 285 where it's forwarded) gains a
   parallel `notesRecall?: NotesRecallPort` declared + forwarded field.
   `packages/module-registry/src/index.ts` (re-declaration near line 437, real construction near
   line 2329) gains the real object: `notesRecall: createNotesRecallPort()` (Task 2's factory),
   next to the existing inline `passiveMemoryRecall: { async recall(...) {...} }` object literal
   (`index.ts:2329-2334`) — confirmed this session as the actual composition-root pattern to
   mirror.

Test: unit test at the `buildEngineText` level (extend existing `engine-text` test file, or add
one if none exists — confirm via search) with a fake `NotesContextRetriever`-shaped
`notesRetrieval`, asserting the three-way parallel fetch and combined block. This is the acceptance
criterion 2a/2b/2c/2d/2e re-proof at the orchestration layer, not just the retriever-unit layer.

### Task 10 — UAT spec + trigger-map rows

New file `tests/uat/specs/notes-default-retrieval.uat.spec.ts`, modeled on the
`REAL_CHAT_CONFIGURED` skip-gate pattern (`tests/uat/specs/real-chat-onboarding.uat.spec.ts:18,76-77`)
— the default UAT harness has no real chat-capable provider (#1121), so:

```ts
const REAL_CHAT_CONFIGURED = Boolean(process.env.JARVIS_UAT_REAL_CHAT_ENV_FILE);
// ...
test.skip(!REAL_CHAT_CONFIGURED, "needs a real chat-capable provider — #1121");
```

Scenario (acceptance criterion 4, live-path proof): seed a note via the real UI/tools recording a
fact; in a later session, ask a question whose answer is that fact without naming the note; assert
the assistant's reply demonstrates the fact was surfaced. No existing memory/recall/notes UAT spec
exists (`ls tests/uat/specs/ | grep -i "memo\|recall\|notes"` — empty, confirmed prior session) —
this is a wholly new file.

New rows in `.claude/skills/coordinate/uat-trigger-map.tsv` (format: `mode<TAB>path
glob<TAB>UAT spec`, confirmed header):

```
blocking	packages/notes/**	tests/uat/specs/notes-default-retrieval.uat.spec.ts
blocking	packages/chat/src/live/notes-retrieval.ts	tests/uat/specs/notes-default-retrieval.uat.spec.ts
blocking	packages/chat/src/live/notes-secret-filter.ts	tests/uat/specs/notes-default-retrieval.uat.spec.ts
blocking	packages/chat/src/live/engine-text.ts	tests/uat/specs/notes-default-retrieval.uat.spec.ts
```

### Task 11 — no-prose check (acceptance criterion 5)

Notes injection is silent pre-turn context — no new user-visible surface, so acceptance 5 ("forced
relaunch mid-thread produces log events and zero thread-visible system/recovery text") is not newly
at risk from this feature, but the UAT spec (Task 10) must positively assert no thread-visible
"searching notes..." or similar system text appears — since the persona instruction is new, a
regression here (a model narrating "let me check your notes") is plausible and specifically worth
asserting against, not merely inherited as already-covered.

### Task 12 — Phase 2 verification

```bash
pnpm --filter @moss/chat test -- run > /tmp/1556-chat-p2.log 2>&1; echo "EXIT=$?"
pnpm --filter @moss/module-registry test -- run > /tmp/1556-registry.log 2>&1; echo "EXIT=$?"
```

Expected exit code: `0` for both. UAT spec run separately per `verify-gate`/coordinated-qa flow
(live dev instance required), not part of this unpiped unit-test pair.

## Open questions / named owners

- None blocking — all prior "not yet done" items from both relay docs are resolved above with
  citations. If Task 9's `notesItemToSupport`/`AnswerSourceSupport` shape doesn't fit cleanly once
  `answer-provenance.js` is open in an editor, that's an implementation-detail adjustment within
  Task 9's contract (the mapper's existence and role are fixed; its body is not pre-written per
  plan-build rules), not a plan fork — builder decides, no re-approval needed.
