# Relay #2 — 1556-notes-retrieval (Phase 2: notes-default retrieval)

Relaying on context-meter 70% warning. **Seams check is now COMPLETE — go straight to writing the
plan.** Still no plan file, no code, no commits beyond origin/main on this branch.

## Read first

- Prior relay doc `docs/superpowers/handoffs/2026-08-12-1556-notes-retrieval-relay.md` — still
  accurate, don't re-derive. This doc only adds what that one left open.
- Spec: `docs/superpowers/specs/2026-08-10-1553-context-continuity-and-notes-retrieval.md` lines
  119-182 (section "Notes retrieval defaulting" + acceptance criteria 2, 4, 5).
- Coordinator label **`Coordinator`**, session id `0bb9f516-c026-454f-bc97-dc9faf43bd20` — confirm
  via `herdr pane list` (exactly one match) before messaging.
- Issue #1556, risk tier **sensitive** (standard QA + invariant check + matched e2e-UAT, no Ben
  merge-sign-off pause).

## What's newly resolved this session (prior doc's "not yet done" items 1-5 — all done)

1. Test fixture shape: `tests/unit/chat-passive-retrieval.test.ts` read in full — mirror its
   `PassiveContextRetriever` constructor-injection style (`dataContext.withDataContext`,
   `settingsRepo.getOrCreate`, `graphRecall.recall`) for new notes-recall port tests.
2. `memory_chunks.updated_at` (`packages/memory/sql/0030_memory_index.sql:14`) is
   `DEFAULT now()`; `upsertFileChunks` (`repository.ts:55-79`) always delete-then-insert per
   chunk, never in-place UPDATE — so `updated_at` is reliably fresh on every re-ingest, no
   trigger needed. `vectorSearch()` (`repository.ts:115-149`) and `RetrievedChunk`
   (`repository.ts:14-21`) need `updated_at` added to the SELECT + type — same-table column add.
3. Orchestration seam fully mapped:
   - `PassiveRetrievalPort` — `chat-session-ports.ts:75-101` (`retrieve`/`retrieveWithItems`).
   - `combineHiddenContextBlocks(passiveBlock, crossToolBlock)` — `chat-context-blocks.ts` (33
     lines total, read in full) — 2-arg today, needs a 3rd optional `notesBlock` param.
   - `buildEngineText(deps, actorUserId, text, surface)` — `engine-text.ts` (121 lines, read in
     full) — fetches passive + cross-tool in parallel today; add a 3rd parallel notes fetch here.
   - **Composition root** — `runtime.ts:340` declares `passiveMemoryRecall?:
     PassiveMemoryGraphRecallPort` on the deps type; `runtime.ts:555-570` conditionally
     constructs `new PassiveContextRetriever({...})` only when that dep is present. A new
     `notesRecall?` dep + `notesRetrieval: deps.notesRecall ? new NotesContextRetriever({...}) :
     undefined` mirrors this exactly.
   - **Real wiring callers** (where `passiveMemoryRecall` actually gets built for a live server,
     confirmed via grep, NOT yet read in detail — read these next before finalizing Phase 2 task):
     `packages/chat/src/routes.ts:103,285` (`ChatRoutesDependencies.passiveMemoryRecall`, passed
     through) and `packages/module-registry/src/index.ts:437,2329` (re-declared + constructed —
     line 2329 is the real object literal, worth reading to see what a genuine
     `PassiveMemoryGraphRecallPort` implementation looks like, as a model for wiring notes).
4. No general-purpose credential/secret detector exists repo-wide. `packages/ai/src/adapters/
   redact.ts` (48 lines, read in full) is narrow (MCP-token/Bearer/`jst_` patterns only) — not
   reusable. New fail-closed detector needed; spec permits pattern set as a plan decision, only
   the fail-closed *disposition* (drop, never truncate-and-keep) is fixed.
5. `UserMemorySettings.recallEnabled` (`packages/chat/src/memory-settings-repository.ts` — NOT
   under `live/`) is reusable as-is for notes gating, independent of `factsEnabled`.

## Plan-shape decision already made (write it into the plan, don't re-litigate)

Notes items don't fit the fact-shaped `MemoryRecallItem` schema (confidence/status/provenance
tiers) — provenance is path + modified-time, not a fact record. Plan introduces a **new**
`renderNotesContextBlock` (proposed home: `chat-context-blocks.ts`, next to
`combineHiddenContextBlocks`) reusing the same `<retrieved_context>` fence +
`neutralizeSeedFraming` call, rather than forcing notes into the facts schema. This is a plan
decision within spec bounds, not a fork — do not escalate it.

## UAT feasibility (acceptance criterion 4) — pattern confirmed

`tests/uat/specs/runtime-context.uat.spec.ts` + `real-chat-onboarding.uat.spec.ts` (both read in
full): default UAT harness has NO real chat-capable provider (fake one bound to `module.news`
only) — tracked as #1121. The only way to get a genuine LLM reply in UAT is
`JARVIS_UAT_REAL_CHAT_ENV_FILE`-gated, with `test.skip(!REAL_CHAT_CONFIGURED, "...#1121")`. Model
the new notes-recall UAT test's "assistant answers from the note, unprompted" assertion on this —
skip-gated for default/CI runs, real for an operator-configured run. No existing memory/recall/
notes UAT spec exists yet (confirmed via `ls tests/uat/specs/ | grep -i "memo\|recall\|notes"` —
empty) — wholly new file, plus new blocking rows in `.claude/skills/coordinate/uat-trigger-map.tsv`
for `packages/notes/**` and the touched chat paths.

Persona citation for Phase 2's persona task: real symbols are `MOSS_PERSONA_BASE` (`runtime.ts:71`)
and `composeMossPersona(surface)` (`runtime.ts:90`, used at `runtime.ts:687`) — spec's own citation
(`DEFAULT_MOSS_PERSONA`/`:523`) is stale, use the real one.

## Not yet done — next concrete steps for successor

1. Read `packages/module-registry/src/index.ts` around line 2329 (bounded — 30-40 lines) to see a
   real `PassiveMemoryGraphRecallPort` construction, as the model for how a real
   `NotesContextRetriever`/notes port gets wired in Phase 2 (which file constructs the real
   `@moss/notes` recall implementation and passes it down).
2. Write the plan via `plan-build` to `docs/superpowers/plans/2026-08-12-1556-notes-retrieval.md`.
   Lean split (already decided, don't re-derive):
   - **Phase 1** (kill-gated): notes-recall port in `packages/notes` (new file, e.g.
     `packages/notes/src/recall.ts`, exported from `packages/notes/src/index.ts` — module
     isolation: chat consumes only this export, never notes internals/tables), `RetrievedChunk`/
     `vectorSearch()` `updated_at` exposure (`packages/memory/src/repository.ts`), fail-closed
     credential/secret filter (new file), server-truth gating fix (`getThreadContext` in
     `persistence.ts:384-401` needs to also return `incognito` — thread type change through
     `ChatPersistencePort`/`EngineTextDeps`/`engine-text.ts`'s `threadCtx` destructuring). All
     proven via deterministic fake-engine/fake-port unit tests (acceptance criteria 2a-e). Kill
     gate: filter + gating correctly proven before any live wiring — name an owner per
     `plan-build`.
   - **Phase 2**: persona search-before-asking instruction, live wiring
     (`combineHiddenContextBlocks` 3rd param, `engine-text.ts` 3rd parallel fetch, `runtime.ts`
     `notesRetrieval` construction mirroring `passiveRetrieval`, real caller wiring per step 1
     above), new UAT spec + `uat-trigger-map.tsv` rows (acceptance criteria 4, 5).
   Must state the determinism boundary, name an e2e test per phase, keep verification commands
   unpiped with expected exit codes, cite everything above by `file:line` rather than re-deriving.
3. Message the coordinator with the plan path for approval. **STOP and wait — do not write code
   until approved.**

## Task list state

Recreate: #1-3 (orient/verify/seams-check) done. #4 (write plan) in_progress, not yet produced a
file. #5-7 (approval, build, wrap-up) pending, untouched.
