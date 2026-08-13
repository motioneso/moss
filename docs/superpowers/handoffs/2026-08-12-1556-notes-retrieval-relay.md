# Relay — 1556-notes-retrieval (Phase 2: notes-default retrieval)

Relaying on context-meter 70% warning, mid seams-check, **before any plan or code was written**.
No commits yet on this branch beyond what was already on origin/main.

## Pointers (read these, don't re-derive)

- Handoff doc (lives at the **overnight coordinator root**, not this worktree):
  `/home/ben/Jarv1s/.claude/worktrees/coord-overnight-20260810/docs/coordination/handoff-1556-notes-retrieval.md`
- Spec, Phase 2 section only: `docs/superpowers/specs/2026-08-10-1553-context-continuity-and-notes-retrieval.md`
  lines 119–159 ("Notes retrieval defaulting") + acceptance criteria 2, 4, 5 (lines 170–182).
  Phase 1 (replay) is `## Design > ### Replay contract`, lines 83–117 — **already merged, PR #1562, not your scope.**
- Codex review dispositions doc is **not checked out on this branch** — read via
  `git show 1896fce1a:docs/coordination/2026-08-10-1553-1554-codex-review.md` (findings 1–8 for
  #1553, all ACCEPTED and folded into the spec already — don't re-litigate, just match citations).
- Issue **#1556**, risk tier **sensitive** (standard QA + invariant check + matched e2e-UAT, no Ben
  merge-sign-off pause). Coordinator label **`Coordinator`**, session id
  `0bb9f516-c026-454f-bc97-dc9faf43bd20` — confirm via `herdr pane list` (exactly one match) before
  messaging.

## Verified true on this branch (step ½ done — don't re-verify)

- Phase 1 already decoupled summary write from replay (`persistence.ts:191,194-195,289`) — matches spec.
- `getThreadContext` (`persistence.ts:384-401`) returns only `{threadTitle, localTimezone}` — **no
  incognito**. `chat.getCurrentThread` already returns `{id, incognito}` at the same call site
  (`persistence.ts:353`) — just needs threading through.
- `PassiveContextRetriever` (`packages/chat/src/live/passive-retrieval.ts`) has **no notes path** —
  only `graphRecall: PassiveMemoryGraphRecallPort` (line 57), gated on
  `settings.recallEnabled && settings.factsEnabled` (lines 114, 141). Whole-retrieval timeout is
  750ms (`PASSIVE_TIMEOUT_MS`, line 43) via `withPassiveRetrievalTimeout` — notes needs its OWN
  500ms budget per spec, so reuse that same race-timeout helper for the notes call specifically,
  not just rely on the outer 750ms.
- `renderRetrievedContextBlock` (lines 180-204) + `neutralizeSeedFraming` (`prompt-safety.ts:17-32`)
  is the existing untrusted-content fence — spec says notes snippets reuse this boundary.
- Persona citation **drift found**: real symbol is `MOSS_PERSONA_BASE` (`runtime.ts:71`), composed
  by `composeMossPersona(surface)` (`runtime.ts:90`), used at `runtime.ts:687` — spec/memory cite
  `DEFAULT_MOSS_PERSONA`/`:523`, which doesn't exist on this branch. Use the real citation; the gap
  itself (no retrieval guidance in persona) is still real, not an escalation.
- `packages/notes/src/tools.ts` `notesSearchExecute` (33-62) returns only
  `{sourcePath, lineStart, lineEnd, text}` — no modified-time, no score exposed. Underneath,
  `MemoryRepository.vectorSearch` (`packages/memory/src/repository.ts:115-149`) DOES compute
  `similarity` (score) — just not surfaced by the tool.
  **Modified-time question RESOLVED**: `app.memory_chunks` DOES have an `updated_at` column —
  confirmed via `listRecentVaultFiles` (repository.ts:300-350), which selects
  `c.updated_at` (line 329) into `VaultFileChunk.updatedAt` (line 345). `vectorSearch()`
  (lines 115-149) and its `RetrievedChunk` type (lines 14-21) just don't select/expose it yet —
  **this is a same-table column add to the SELECT list, not a schema change or a new join.**
  Use `memory_chunks.updated_at` as the real modified-time, not the `memory_file_index.ingested_at`
  proxy floated earlier in this doc (that reflects ingestion time, not the note's own edit time).
- `packages/notes/src/index.ts` exports write-tools/manifest/sync/routes — **no plain recall port
  function** to build the spec's declared public port on top of.
- No existing repo-wide credential/secret-pattern-matcher utility found yet (not fully searched).

## Not yet done — next concrete steps for successor

1. Read `tests/unit/chat-passive-retrieval.test.ts` (bounded) — mirror its mock/fixture shape for
   the new notes-recall port tests.
2. ~~Resolve modified-time provenance~~ — DONE, see above: `memory_chunks.updated_at` exists,
   just needs adding to `vectorSearch()`'s SELECT + `RetrievedChunk` type. Confirm the column is
   actually populated on write (`upsertFileChunks`, repository.ts:55-79, does NOT set
   `updated_at` explicitly — check if there's a DB default/trigger, e.g. `DEFAULT now()` in the
   migration that created `memory_chunks`, before assuming it's reliably fresh).
3. Grep/read `chat-session-manager.ts` for the `PassiveRetrievalPort` interface and
   `combineHiddenContextBlocks` — exact signature to extend for a second (notes) hidden-context
   block in `engine-text.ts`.
4. Grep repo-wide (`packages/shared`, `packages/chat`) for any existing secret/credential regex
   utility before writing a new fail-closed filter from scratch.
5. Confirm `UserMemorySettings.recallEnabled` (`memory-settings-repository.ts`) is reusable as-is
   for notes gating — spec says notes obeys the *same* toggle, likely no schema change needed.
6. Write the plan via `plan-build` (seams check above is a strong start, not complete — finish
   items 1-5 first). Lean split: **Phase 1** = notes-recall port + provenance + fail-closed
   credential filter + server-truth gating, all deterministic fake-engine/fake-port tests
   (acceptance criteria 2a-e) — kill gate: filter and gating correctly proven before any live
   wiring. **Phase 2** = persona search-before-asking rule + live `PassiveContextRetriever` wiring
   + UAT spec (acceptance criteria 4, 5). Plan MUST include the UAT spec path
   (`tests/uat/specs/<slug>.uat.spec.ts`) + a row in `.claude/skills/coordinate/uat-trigger-map.tsv`.
   Module isolation: the notes port must go through `packages/notes` public exports only —
   never notes internals/tables directly.
7. Message the coordinator with the plan path for approval. **STOP and wait — do not write code
   until approved.**

## Task list state (TaskList in this session)

Tasks #1 (orient), #2 (verify spec premises), #3 (memory recalls) — completed. #4 (write plan) —
in_progress, not yet produced a plan file. #5-7 (approval, build, wrap-up) — pending, untouched.
Recreate/continue this same list rather than starting fresh.
