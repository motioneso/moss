# Rust Phase 5: Memory with embeddings port plan

Part of https://github.com/motioneso/moss/issues/4027. This is a planning document. It builds
nothing. It follows the rules in `2026-11-06-rust-port-plan.md` (Phase 5) and
`2026-11-07-rust-module-packages-and-registry-design.md` (sections 5 and 7), and uses
`2026-11-11-rust-phase5-email-connectors-plan.md` as its pattern.

Every claim about the old TypeScript app was read from the files named below. Anything marked
**Guess** is my inference and needs checking before a builder relies on it.

## 1. Summary

- Legacy Memory is `packages/memory` (about 9,000 lines of TypeScript, 22 SQL files). It keeps
  three things. A graph of what Moss has learned about the person (entities, facts, the episodes
  they came from), a queue of suggested memories waiting for a yes or no, and a search index of
  note and chat passages (chunks with vectors).
- **Embeddings today are not a model-router call.** They run on the device. The only provider is
  the local model `nomic-embed-text-v1.5` (768 numbers per vector) through transformers.js on a
  worker thread. The settings `ai.embed_provider` (only value `local`) and `ai.embed_model` only
  pick the local model id. The task text assumed the router makes them. It does not. This plan
  treats that as the main design fork (section 4.2).
- The Rust host already has an `embed` port that calls one OpenAI-compatible endpoint chosen per
  account (`rust-spike/module-host/src/ai.rs`). The real server has no source for that endpoint yet
  and fails closed (`rust-spike/shell/app/src/module_ai.rs`, `NoEmbeddings`). Notes already
  writes and searches `memory_chunks` through two host adapters
  (`memory_ingest.rs`, `memory_search.rs`) that use it. So Rust today can store and search
  vectors, but nothing can make a real one.
- The existing Rust embedding path differs from legacy in four ways that would quietly damage
  search. It adds no `search_document:` or `search_query:` prefix, it does not check for 768
  numbers, it records provenance version `1` where legacy writes `1.5`, and it records no model
  activity row (section 4.2). Part 1 fixes these before anything else is built on top.
- The registry design lists "memory and embeddings" as a core area that stays in the host (section
  7). The task and the Phase 5 list treat Memory as a module. **Recommendation.** Port Memory as a
  required, bundled package (`modules/memory`, ledger `core-legacy`, cannot be removed, as
  legacy declares `lifecycle: required`). The graph, candidates, dashboard, tools and screens live
  in the package. Embedding calls, vector storage helpers and the index jobs stay in the host,
  behind the existing `embed` port and the Notes adapters. This keeps rule 3 (no network or
  threads in a package) and matches the Connectors plan.
- The work splits into 10 parts (section 6). Only part 6 needs new third-party crates, so Ben
  approves a short list before that part starts.

## 2. What the legacy module does

### 2.1 Memory screen (Settings, Memory & context, Memory tab)

The person sees a list headed "Saved memories" with filters (status, kind, source, text search) and
counts, paged by a cursor. Suggested memories show first for a decision. Each saved memory can be
pinned, have its dates changed (valid from, valid to, stale at), be marked stale, be corrected, be
replaced, or be forgotten. Each entity (a person or thing) can be renamed, summarised, archived or
deleted when no facts hang on it. Accepting a suggestion adds a memory and never replaces an older
one. Rejecting is final for that suggestion. Suppressing stops the same suggestion coming back.

Files. `apps/web/src/settings/settings-memory-pane.tsx` (frame, tabs Memory and People),
`settings-memory-dashboard.tsx` (556 lines), `memory-facts-view.ts`, `memory-provenance.ts`,
`apps/web/src/api/memory-client.ts`. The People tab belongs to the People module and is not part
of this port.

### 2.2 Memory graph

Entities (kinds, status active, archived or merged, importance 0 to 1, pinned), facts (a subject,
one of ten predicates, either an object entity or object text but never both, confidence 0 to 1,
provenance volunteered, inferred, confirmed or imported, status active, stale, expired,
superseded, rejected or conflicting), episodes (where a fact came from, with a bounded excerpt),
fact sources, aliases, and conflict groups. Every owner has a protected "self" entity that cannot
be deleted.

Files. `graph-types.ts`, `graph-repository.ts` (808 lines), `graph-repository-utils.ts`,
`graph-fact-lifecycle.ts`, `graph-fact-sources.ts`, `fact-signature.ts`, `sql/0118`, `0121`,
`0301`.

### 2.3 Recall

A query is embedded, facts are scored, and the best ones come back with their source text. The score
is `0.4 * vector similarity + 0.25 * keyword match + 0.15 * importance + 0.1 * provenance boost +
0.05 * pinned + 0.05 * freshness`. Low confidence facts (under 0.6) are dropped unless the wording
matches closely (0.85). Default limit is 10. A "core" call returns up to 20 pinned and important
facts with no query. Remembering a fact also writes a search document (the fact's text and its
vector) in the same call.

Files. `graph-recall-service.ts` (282 lines), `graph-tools.ts`, `graph-routes.ts`,
`retrieval.ts`, `sql/0118` (`memory_search_documents`).

### 2.4 Suggestions (candidates)

Chat distillation and the manual path create pending candidates (kind entity, fact, alias,
supersession or conflict). A candidate ends as promoted, rejected, merged or suppressed. Only
pending ones can be decided, repeat decisions are refused. Sensitive text never becomes a
candidate (`memoryCandidateContainsSensitiveText` in chat).

Files. `candidates-repository.ts`, `candidate-labels.ts`, `candidate-cursor.ts`,
`manual-candidates.ts`, `suppressions-repository.ts`, `dashboard-service.ts`,
`dashboard-routes.ts`, `dashboard-types.ts`, `sql/0092`, `0096`, `0097`, `0119`.

### 2.5 Search index of notes and chat (chunks)

Markdown files under the notes roots and exported private notes are split into chunks of at most
2,000 characters, embedded (one 512-token window each) and stored in `memory_chunks` with the
model name and version. A per-file record in `memory_file_index` holds the file hash so unchanged
files are skipped, and a changed model name makes the file count as changed (that is the only
"re-embed" legacy has). `attachments/` and `exports/` are never indexed. A sweep job runs every 15
minutes for each owner, a nudge job handles one changed or deleted file, and a tick job fans out
the sweeps. Chat writes one chunk per latest turn pair (source kind `chat`). Backtrack writes
`screen` chunks. Notes uses source kind `notes`.

Files. `parser.ts`, `ingest.ts`, `ingest-document.ts`, `ingestion-service.ts`,
`embed-chunks.ts` (4 chunks at a time), `repository.ts`, `vault-ingest-registry.ts`,
`vault-ingest-jobs.ts`, `vault-index-publication.ts`, `sql/0030`, `0032`, `0040`, `0054`,
`0106`, `0110`, `0281`, `0338`.

### 2.6 Chat tools and chat actions

Tools `memory.recall` (read), `memory.remember` (write, runs without asking), `memory.forget`
(destructive, always asks, shows the full memory text, checks the exact version at approval).
Route-backed chat actions carry approval cards with plain text and hidden target snapshots
(`chat-targets.ts`, `action-presentations.ts`, `forget-service.ts`).

### 2.7 Recording memory (meetings)

Memory from meeting recordings keeps labels and source history through correction. Deleting a
recording removes its support and any memory with no other support. Tables are
`memory_recording_fact_versions`, `_receipts`, `_proposals`, and `recording_side` columns.
Files. `recording-facts.ts`, `recording-fact-*.ts`, `recording-memory-*.ts`, `sql/0338` to
`0341`. Meetings is not ported yet, so this part ports the store and API only (section 6, part 9).

### 2.8 Legacy chat facts

`chat_memory_facts` and its corrections log are the older fact store. They still feed chat and
Wellness (`packages/chat/src/recall-port.ts`, `packages/wellness/src/recall-context.ts`) and have
one-time migration rows into the graph (`memory_legacy_fact_migrations`). The tables stay, and
their repository (`facts-repository.ts`, `suppressions-repository.ts`) is ported as read and write
API for chat.

## 3. Parity checklist

### 3.1 Routes

All need the `memory.view` or `memory.manage` permission as the legacy manifest says. Part numbers
refer to section 6.

| Route                                         | Notes                                                                                        | Part |
| --------------------------------------------- | -------------------------------------------------------------------------------------------- | ---- |
| `GET /api/memory/graph/recall`                | `q` required, 400 `q is required`                                                            | 2    |
| `GET /api/memory/graph/core`                  |                                                                                              | 2    |
| `POST /api/memory/graph/entities`             |                                                                                              | 2    |
| `POST /api/memory/graph/facts`                | exactly one object target, else 400                                                          | 2    |
| `POST /api/memory/graph/facts/:id/pin`        | 404 `Memory fact not found`                                                                  | 3    |
| `POST /api/memory/graph/facts/:id/confirm`    | supersedes conflicts, 409 on recording conflict, 400 on conflict-group memory                | 3    |
| `POST /api/memory/graph/facts/:id/correct`    | same errors as confirm                                                                       | 3    |
| `POST /api/memory/graph/facts/:id/status`     | 400 `SUPERSEDED_REACTIVATION_BLOCKED`                                                        | 3    |
| `POST /api/memory/graph/facts/:id/mark-stale` |                                                                                              | 3    |
| `POST /api/memory/graph/facts/:id/supersede`  | 204, 404                                                                                     | 3    |
| `DELETE /api/memory/graph/facts/:id`          | 204, 404                                                                                     | 3    |
| `GET /api/memory/dashboard`                   | counts, items, `nextCursor`; 400 on old paging or bad cursor                                 | 4    |
| `GET /api/memory/candidates`                  | cursor paging, 400 `Invalid cursor`                                                          | 4    |
| `POST /api/memory/candidates/:id/accept`      | 400 if the body tries to replace, 404 `Candidate not found or not pending`, 200 `{accepted}` | 4    |
| `POST /api/memory/candidates/:id/reject`      | 204, 404 as above                                                                            | 4    |
| `POST /api/memory/candidates/:id/suppress`    | 204, 404 as above                                                                            | 4    |
| `PATCH /api/memory/graph/facts/:id`           | dates, pinned. 404 `Fact not found`, 200 `{patched}`                                         | 4    |
| `PATCH /api/memory/graph/entities/:id`        | 400 empty object text, 403 self entity protected, 409 ambiguous subject                      | 4    |
| `DELETE /api/memory/graph/entities/:id`       | 409 `Entity has associated facts; delete facts first`, 403 self entity, 404, 204             | 4    |

Common errors. 401 `Unauthorized` when there is no actor. Every route keeps the legacy status code
and body wording. Every chat access class in the legacy manifest (blocked, read, write,
destructive, with content class `outside` or `user_authored`) is copied exactly, because the chat
approval rules read them.

### 3.2 Background jobs

| Job                              | What                                                  | Part |
| -------------------------------- | ----------------------------------------------------- | ---- |
| `memory.vault-ingest-tick`       | every 15 minutes, one sweep per owner                 | 5    |
| `memory.vault-ingest-sweep`      | `{actorUserId}`, walks roots, ingests, deletes gone   | 5    |
| `memory.vault-ingest-nudge`      | `{actorUserId, sourcePath, op}`, 300 s dedup per file | 5    |
| `chat.embed-turn` (chat owns it) | writes a `chat` chunk per turn pair                   | 8    |
| `chat.extract-facts` (chat owns) | distils candidates, never sensitive text              | 8    |

Payloads stay metadata only (section 4). The legacy `assertMetadataOnlyPayload` guard is ported.

### 3.3 Settings and preferences

- `ai.embed_provider` (admin, only `local`) and `ai.embed_model` (admin, blank means default).
  The Rust equivalents are decided in section 4.2 (**Guess** at the names, see there).
- Per-owner "index this folder" choices belong to Notes (`preference_key` in `memory_ingest.rs`).
- No other memory settings exist.

### 3.4 Screens

- Settings, Memory & context, Memory tab (section 2.1) and its empty state (no memories yet).
- Approval cards for remember, forget, accept and edit (rendered from the record, never from
  model output).
- Source provenance in chat answers (`apps/web/src/chat/answer-provenance.tsx`) belongs to chat.
- Moss's own app map entries (navigation, settings, features and remediations, including
  `memory.refresh_recording_source`) move into the package manifest in the same PR as each screen.

### 3.5 Chat tools

`memory.recall`, `memory.remember`, `memory.forget`, with the legacy input schemas (the ten
predicates, four provenances, source kinds chat, note, task, email, calendar, manual), the action
family `memory_management`, self-operation grants (`granted_at_install` for remember,
`confirm_always` for forget) and `safeErrors`. Forget requires the host service `memoryForget`
and answers 503 `Memory deletion is not ready. Start a new chat and try again.` when missing.

### 3.6 Public API other modules call

| Caller                                        | What it uses                                                                                        | Port part |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------- |
| Chat                                          | recall, passive retrieval, chunk upsert for turns, candidate creation, legacy facts, forget service | 8         |
| Notes                                         | chunk upsert, file index, vector search (already through host adapters)                             | 5, 8      |
| Briefings, Wellness, Goals, People, Backtrack | recall and chunk reads (`compose-shared`, `recall-context`, `jobs`)                                 | 8         |
| Meetings                                      | recording memory service and cleanup                                                                | 9         |
| Module host                                   | embedding activity rows (`embedding-activity.ts`)                                                   | 1         |
| Data lifecycle                                | export section `recordingMemory`, deletion of 16 owned tables                                       | 10        |

### 3.7 Errors and degraded outcomes

Embedding service missing or wrong. Legacy falls back from `stub` to the local model with a loud
warning. Rust has no stub path outside tests. A missing or failing embedding service must give a
plain error on remember (the fact is saved first, its search document is retried, see part 2)
and an empty-with-reason answer on recall, never silence. A wrong vector size is refused (section
4.2).

## 4. Embeddings

### 4.1 How they work today

- Model `nomic-ai/nomic-embed-text-v1.5`, 768 dimensions, version label `1.5`, mean pooling,
  normalised, input limited to 512 tokens (a 6.8 GB memory bug at 8192 tokens, issue 1359).
  Documents get the prefix `search_document: `, queries `search_query: `.
- The model runs on a shared worker thread, loaded once per process under a lock on the model
  cache folder, and downloads from the model hub on first use.
- Columns. `memory_chunks.embedding vector(768)` and `memory_search_documents.embedding
vector(768)`, both with `embed_model_name` and `embed_model_version`, plus
  `memory_file_index.embed_model_name/version`. Indexes are HNSW with `vector_cosine_ops`, partial
  on `embedding IS NOT NULL`. Search orders by `embedding <=> $vector::vector`, similarity is
  `1 - distance`. Vectors are sent as text literals and cast. An earlier migration (0032) cut the
  column from 384 to 768 and truncated derived data, so existing installs hold 768-wide vectors.
- There is no separate backfill or re-embed job. A sweep re-embeds any file whose stored model
  name differs from the current one. A fact written while the model failed has no vector
  (`embedding` may be null, similarity counts as 0) and is not retried. **Guess** (not
  checked line by line) that nothing else retries it.
- Every embedding call writes one model activity row with model name and outcome and never the
  text (`withEmbeddingActivity`). The activity source is `notes` or `memory`.

### 4.2 How Rust does it

Decision. **Keep 768 dimensions and the nomic model as the default, and let an owner point at any
OpenAI-compatible endpoint that returns 768 numbers.** No provider or model name is hardcoded.
The account's configuration chooses the endpoint, model name, credential (a brokered secret) and
whether prefixes apply.

1. The embedding service is one host component behind the `embed` port (it already exists). It
   gains the prefix per call kind, a check that the vector has exactly 768 finite numbers (else
   refuse with a plain message, never pad or cut), the provenance (model name from the
   configuration, version from the configuration or `1.5` for the default model), and an activity
   row per call with no text.
2. Two sources, picked in the embedding settings. **An endpoint** (any compatible server,
   including a local one) needs no new crate. **On-device** runs the same nomic model inside the
   host and needs new crates (part 6).
3. Endpoint models that are not nomic give vectors in a different space. The service stores the
   model name with every vector. Search uses only rows whose model name matches the current one,
   and the screen says "N passages were made with another model" and offers an owner-started
   re-embed (part 7). It never overwrites old vectors until the new ones are complete, as the
   Phase 5 plan states (section 3.11).
4. If an endpoint model offers a size option (OpenAI-style `dimensions`), the service asks for 768. **Guess** that this is supported by the endpoints Ben would use. Changing to another size
   needs a new SQL file and a full re-embed, and is out of scope.
5. Query and document paths use one service, so the prefix rule cannot drift between Notes
   search, Notes ingest, graph recall and chat. The three existing Rust call sites (`ai.rs`
   `IntelligenceEmbeddings`, `memory_ingest.rs`, `memory_search.rs`) move to it in part 1.
6. Chunks are limited to 2,000 characters in `memory_ingest.rs` and the 512-token cap is a model
   concern. The service asks the endpoint for truncation where it can and otherwise records that
   a passage was cut. **Guess** that a character cap alone is a safe floor for nomic.

### 4.3 What CI proves and what needs Ben

CI, with a fixed fake embedding model (a small HTTP server that returns repeatable vectors made
from a hash of the text, 768 numbers, with a few hand-made vectors so "nearest" is predictable).

- Prefix is added (the fake echoes what it received into a test-only record).
- Wrong size, empty, non-finite and oversize responses are refused.
- Remember then recall finds the right fact by meaning order, ties and the score formula.
- Sweep skips unchanged files, re-embeds on a model-name change, removes deleted files, honours
  the excluded folders.
- Vector literal round trip against a real database with the vector extension, including the HNSW
  index being used (`EXPLAIN` check).
- A row written by the TypeScript code is read by Rust and the reverse, using fixtures built from
  the old code (including its 768-wide vectors).
- Owner isolation, secret and text leaks, payload shape (section 5).

Needs Ben, or an account or model he provides.

- One real configured endpoint (a local server or a cloud account) to see that real vectors have
  the right size and the search order is good. The fake cannot show quality.
- Part 6 only. A comparison of vectors made by the old transformers.js code and the Rust runtime
  for the same fixed sentences (this is the kill gate for on-device, section 7). Needs the model
  files, which are downloaded from the model hub on first use. **Guess** that CI has network access
  to fetch them. If it does not, Ben runs it once.
- A second physical device reaching the Memory screen, as for the other Phase 5 modules.

## 5. Keeping private data private

1. **Owner-only.** Every table already has owner-only row level security for the app and worker
   runtime roles (`owner_user_id = app.current_actor_user_id()`). The Rust package keeps those SQL
   files byte for byte and never adds `BYPASSRLS` or an admin path. Tests use two people and are
   seen failing with each policy removed. There is no sharing, so cross-person reads stay refused.
2. **No leaks.** Memory text, excerpts, queries and vectors never go into logs, errors, job
   payloads, activity rows, or the notes shown to a model other than as the recall result the
   person's own chat asked for. A marker text planted in a fact, a query and a note is searched for
   in every response, log line, job payload and activity row, and the test is first seen failing
   with the protection removed.
3. **Endpoint credentials.** The embedding credential is a brokered secret in the host. It never
   reaches the package, a response, a log or a prompt. Memory text does leave the device when an
   owner picks a cloud endpoint, so the settings screen says so before saving (**Guess** at the
   wording, plain and short) and the on-device source stays the default.
4. **Metadata-only jobs.** Payloads are the owner id, a path and an operation, never content
   (`assertMetadataOnlyPayload`). A test inspects the stored job rows.
5. **Chat content classes.** Every route and tool keeps its `content` class so chat treats
   recalled memory as outside content and cannot be steered to write or delete from it.
6. **Sensitive text.** Candidates are refused when the sensitive-text check matches, as in chat
   today.
7. **Approval for deletion.** Forget and delete show the full memory text and re-check the exact
   version at approval time. A changed target needs a new approval.

The determinism boundary. Every confirmation on the Memory screen and in approval cards is
drawn from the stored record. The model has two jobs here. It turns a chat turn into suggested
memories (chat's distillation job), and it chooses when to call recall, remember and forget. It
never writes straight into the graph without the legacy rules (candidate or approved write) and it
never injects turns into chat.

## 6. Build parts

Sizes are by complexity (S, M, L), not time. Each part is one builder window. Order is dependency
order. Each part with a screen ends with a live check on the real Rust server over HTTPS and from
a second device. Each part writes into `docs/superpowers/specs/2026-11-xx-rust-phase5-memory-report.md`
in plain wording and lists what is not proven. Each part names its e2e proof.

| Part | Scope                                                                                                                                                                                                                                                                                                                                                                                              | Size | Depends on                            | Proof                                                                                                                                                                                                                                |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | Package skeleton `modules/memory` (manifest, ledger `core-legacy`, owned tables, hashes of existing SQL, CHANGELOG, icons) and the shared embedding service in the host. Prefix per call, 768 check, provenance, activity rows with no text, settings for endpoint and model, a settings read route for the admin. The three existing call sites move to it. Fixed fake embedding model for tests. | M    | none                                  | Fake model prefix and size tests, activity row text-leak test seen failing first, Notes search and ingest still pass on the new service, live run on the Rust server against the fake endpoint                                       |
| 2    | Graph store and recall. Entities, facts, episodes, fact sources, aliases, self entity, search documents. `GET recall`, `GET core`, `POST entities`, `POST facts`, tools `memory.recall` and `memory.remember`, the score formula. Remember saves the fact first and retries the vector.                                                                                                            | L    | 1                                     | Route parity from fixtures made from the old code, score formula cases, two-person row security test, TypeScript-written rows read by Rust and back, native and WebAssembly builds                                                   |
| 3    | Fact lifecycle. Pin, confirm, correct, status, mark-stale, supersede, delete, conflict groups, the forget service and `memory.forget`, approval presentations and targets, version re-check.                                                                                                                                                                                                       | L    | 2                                     | Every error status of 3.1, conflict group cases, forget approval consumed once and changed target refused, live approval card                                                                                                        |
| 4    | Suggestions and the Memory screen. Candidates, suppressions, manual candidates, dashboard and candidate routes, entity and fact patch and delete, cursor paging, the Memory tab as a package screen with its app map entries and empty, loading and broken states. **Needs a front-end design and mockups agreed with Ben first** (module rule in `CLAUDE.md`). The People tab stays with People.  | L    | 3                                     | Route parity, repeat decision refusal, cursor stability, screen check on phone and desktop widths, live Memory screen from a second device                                                                                           |
| 5    | Search index. Source registry, chunking (2,000 characters), per-file ingest, file index, sweep, nudge and tick jobs, 15 minute schedule, hard excluded folders, model-name change triggers re-embed, managed note snapshots, ingest of private note exports. Takes over from the Notes host adapters (Notes keeps its tools).                                                                      | L    | 1                                     | Sweep against a real database and the fake model including changed, unchanged, deleted and moved files, schedule reconciliation, job payload check, TypeScript-written index rows honoured, no re-embed on a restart                 |
| 6    | On-device embeddings. The same nomic model inside the host, model download on first use with progress and a clear failure, cache folder lock, 512-token cap, one worker thread. **New third-party crates needed (section 6.1).** Does not start until Ben approves the list.                                                                                                                       | L    | 1                                     | Vector comparison against vectors made by the old code for a fixed sentence set (kill gate), peak memory measurement at a long input, live Memory search with no endpoint configured, needs Ben if the model cannot be fetched in CI |
| 7    | Re-embed and model change. Owner-started re-embed that keeps old vectors until new ones are complete, progress, cancel, and the "N passages use another model" notice. Retry of facts that were saved with no vector.                                                                                                                                                                              | M    | 4, 5 (and 6 for the on-device source) | Interrupted run leaves old vectors usable, completed run swaps atomically, search never mixes two models, live screen control                                                                                                        |
| 8    | Public API for other modules. Recall and chunk reads for Briefings, Wellness, Goals, People and Backtrack, chat's passive retrieval, `chat.embed-turn` writes, candidate creation for chat distillation, the legacy `chat_memory_facts` and suppressions API. Notes search joins the new service.                                                                                                  | M    | 2, 4, 5                               | Each caller's call shape against Rust fixtures made from the old callers, owner isolation across the API, a chat answer showing memory provenance live. Chat's own port is out of scope and is joined here only through the API      |
| 9    | Recording memory. Fact versions, receipts, proposals, lineage, cleanup operations, export. Store and API only. The Meetings screen joins when Meetings is ported. **Guess** that it can be built before Meetings against the legacy tests.                                                                                                                                                         | L    | 3                                     | Lineage and cleanup cases from the TypeScript tests, conflict error, deletion removes unsupported derivatives, TypeScript rows read back                                                                                             |
| 10   | Remainder. Data export section and deletion across the 16 owned tables, packaging for the registry, upgrade check from an existing install on a copy of the dev data, whole-module live pass with one real configured model, app map audit.                                                                                                                                                        | M    | 1 to 9                                | **Needs Ben** for the real model pass. Existing-install upgrade run on a copy, export and deletion test with a second person present                                                                                                 |

Parts 5 and 6 can run beside parts 2 to 4 once part 1 settles the embedding service. Parts 2 to 4
run in order because each builds on the last.

### 6.1 Part that needs new crates (Ben approves)

Part 6 only. Nothing in the Rust workspace lockfile today provides an ONNX runtime or a
tokenizer (checked in `rust-spike/Cargo.lock`, only `reqwest` and `tokio-postgres` of the likely
set are present).

| Crate        | From                                   | Why                                                      | Note                                                                                                                                                  |
| ------------ | -------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ort`        | crates.io (pykeio, binds ONNX Runtime) | runs the nomic model                                     | Downloads or links a native runtime at build time. **Guess** that it works in all three installers. Native only, not WebAssembly                      |
| `tokenizers` | crates.io (Hugging Face)               | the model's tokenizer, same token ids as transformers.js | Large but standard                                                                                                                                    |
| `hf-hub`     | crates.io (Hugging Face)               | model download on first use with a cache                 | Could be replaced by a plain download using `reqwest` and a checksum (no new crate). **Recommendation** is the plain download, which also pins a hash |

Alternative to compare. `tract-onnx` (crates.io, Sonos) is pure Rust and avoids a native
runtime but may lack operators the nomic model uses. **Guess** that `ort` is simpler. Part 6
starts with a small spike of each, picks the one that matches the old vectors, and asks
Ben to approve only that one before adding it to the lockfile.

## 7. Kill gate and risks

**Kill gate for part 6 only.** The on-device vectors must match the old ones closely enough that
search results for the fixed sentence set rank the same (cosine similarity above 0.99 between old
and new for each sentence, a **Guess** at the threshold). If no candidate runtime reaches it, Moss
reports it, keeps the stored vectors and ships the endpoint source only. Owner is Ben. This is
not a no-go for the port, only for that route (the port plan treats kill gates as measurements).

Risks.

- **The fork on where Memory lives.** Section 1 recommends a bundled required package with the
  embedding service in the host. If the WebAssembly speed budget is missed by the recall scoring
  (about 1,000 candidates), part 2 puts that scoring in the native list (rule 10) with the
  measurement. **Guess** that it will fit.
- **Vector quality drift.** The fake cannot show it. Part 10 forces a real model pass.
- **Cloud endpoints send memory text off the device.** Section 5 point 3 covers the notice.
- **Size.** Part 4 is the widest because it has the screen. A builder may stop at a clean point
  and say so rather than compact twice.
- **Dependence on Meetings and chat.** Parts 8 and 9 expose APIs for modules not yet ported. They
  are tested against the old callers' shapes and re-proved when those modules arrive.
- **Notes coupling.** Notes already writes `memory_chunks` through the host adapters. Part 5 must
  keep Notes' ingest and search tests green as ownership moves.

## 8. Not covered

Anything outside the legacy memory package and its public API, and any non-Rust work. People's
tab, Chat's own jobs and screens, Meetings, Briefings and Backtrack stay with their own plans,
except where they read through the API in section 3.6.
