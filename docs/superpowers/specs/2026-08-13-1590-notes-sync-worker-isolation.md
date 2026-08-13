# Notes ingest CPU starvation breaks unrelated queues — worker isolation

**Date:** 2026-08-13
**Status:** Draft — sent to Ben for review (direct request, bypassing the usual Fable first-pass)
**Issue:** #1590 (root fix). Related: #1589 (the incident investigation this spec is built on),
#1585 (a symptom PR/report).
**Source:** `gh issue view 1590` — issue body's root-cause account, cross-checked against source
below; no contradictions found.
**Grounded on:** commit `198928da4` (current `origin/main` at spec time). Files read in full or by
targeted section:
- `packages/db/src/database.ts:1-40` — pg `Pool` construction, `connectionTimeoutMillis` default.
- `packages/notes/src/jobs.ts:60-100,430-470` — `NOTES_QUEUE_DEFINITIONS`, `registerNotesJobWorkers`.
- `packages/memory/src/local-embedding-provider.ts` (full, 107 lines) — embedding call shape.
- `packages/memory/src/embed-chunks.ts` (full, 65 lines) — concurrency cap, no total-chunk cap.
- `packages/memory/src/parser.ts` — `MAX_CHUNK_CHARS = 2000` (per-chunk size cap only; no
  per-run/per-file chunk-count cap anywhere in the tree — confirmed by grep).
- `apps/worker/src/worker.ts:1-60,277` — single `registerBuiltInModuleWorkers(boss, {...})` call
  site registering every built-in module's job workers (notes, news, connectors, chat, ...) onto
  one `boss` in one Node process.
- `packages/news/src/personalization-repository.ts:565-582` — `failRefreshRunIfCurrent`, takes a
  `scopedDb: DataContextDb` from the caller rather than opening its own connection.
- Confirmed via grep: zero `worker_threads` or `child_process` usage anywhere in the tree.

**Pre-build grounding gate:** all claims below are either read directly from source (marked
"confirmed") or flagged as requiring build-time investigation (marked "investigate at build").
Nothing here is taken from the issue body without a source check.

## Decision summary

`notes.sync` runs local embedding inference (ONNX, `nomic-embed-text-v1.5`) synchronously in the
same Node process, same event loop, and same CPU budget as every other queue this worker handles.
A large ingest run starves the process badly enough that pg's own `connectionTimeoutMillis` timer
(a `setTimeout` on that same loop) fires late and kills sockets out from under unrelated jobs
(`news.refresh`, `job-search.crawl-sweep`, `connectors.*`, `chat.embed-turn`). The fix is to give
`notes.sync`'s embedding work its own CPU isolation so it cannot starve the rest of the process,
plus two smaller correctness fixes (bound ingest size; fix a stuck-`queued` state bug). The exact
isolation mechanism is **not locked** — three candidate directions are listed below with an
investigation step to pick the narrowest one that a deterministic reproduction test proves
sufficient.

## Current-state grounding

| Claim | Status |
| --- | --- |
| All built-in module job workers (notes, news, connectors, chat) run in one process via a single `registerBuiltInModuleWorkers(boss, {...})` call in `apps/worker/src/worker.ts:277` | Confirmed |
| No `worker_threads` or `child_process` used anywhere in the repo | Confirmed (grep, 0 hits) |
| `notes.sync` queue policy is `exclusive` (only one instance of that queue runs at a time) | Confirmed, `packages/notes/src/jobs.ts:60-100` — this bounds concurrent notes.sync runs, but does **not** isolate it from other *queues* sharing the process |
| pg pool default `connectionTimeoutMillis` is 5000ms, driven by `JARVIS_DB_CONNECT_TIMEOUT_MS`, itself a timer on the same event loop | Confirmed, `packages/db/src/database.ts` |
| Per-chunk embedding call is capped at 512 tokens (~0.4s, ~26MB) since #1359; no per-run/per-file cap on total chunk count | Confirmed — `EMBED_MAX_TOKENS` in `local-embedding-provider.ts`; `embedChunks()` bounds only in-flight concurrency (`EMBED_CONCURRENCY = 4`, #1357), not total chunks. A single large vault file (issue cites ~1,250 chunks) still runs that many sequential-ish embed calls in one job. |
| `MAX_CHUNK_CHARS = 2000` in `parser.ts` bounds individual chunk size only, not run size | Confirmed |
| Whether the native ONNX call actually blocks Node's event loop (vs. releasing it via native async/threadpool) | **Investigate at build** — empirical evidence (issue's observed 5s+ connection-timeout failures, plus the pre-#1359 23s single-call block) strongly suggests it blocks or at minimum saturates CPU badly enough that OS-level scheduling starves the event loop's own timers even if the JS-level call is technically async. Confirm which before picking a fix direction. |
| `failRefreshRunIfCurrent` (the `news_refresh_state` failure-recording path) takes the caller's already-open `scopedDb: DataContextDb` rather than acquiring a fresh connection | Confirmed, `personalization-repository.ts:565`. If that connection died with the rest of the pool, the catch path that would call this can itself fail, leaving `state = 'queued'` forever instead of `'failed'`. |

## Tier and dependencies

**Tier: `sensitive`** (per CLAUDE.md trigger table — cross-cutting worker-runtime change
affecting reliability of every module's queue; no RLS/migration/secrets surface, so not
`security`). Gets standard QA + explicit invariant check + matched e2e-UAT + per-merge digest to
Ben, no merge-sign-off pause required.

No spec/migration dependencies on other in-flight lanes this run. Touches `apps/worker/src/worker.ts`,
which every other lane treats as read-mostly wiring — flag in the collision map before spawning a
build agent, in case another lane is mid-edit there.

## Exclusive owned surface

- `packages/memory/src/local-embedding-provider.ts`
- `packages/memory/src/embed-chunks.ts`
- `packages/notes/src/jobs.ts` (ingest-size bound; `registerNotesJobWorkers`)
- `apps/worker/src/worker.ts` (registration wiring only — do not restructure other modules' registration)
- `packages/news/src/personalization-repository.ts` (`failRefreshRunIfCurrent` connection handling)
- New: a worker_thread/child_process module, if direction (a) or (b) below is selected
- New: reproduction test(s) proving the fix, under the existing worker/memory test trees

**Explicitly out of scope:** any deploy/process-topology change beyond what direction (a) or (c)
requires; `chat.embed-turn`'s own embedding cost (only `notes.sync`'s ingest *volume* is this
issue's trigger, though a provider-level fix incidentally helps every caller — that's a bonus, not
a requirement to prove separately).

## Locked fix contract

Four required changes, in priority order:

1. **CPU isolation for embedding inference**, so a `notes.sync` run cannot starve other queues'
   ability to get scheduled. Candidate directions — **none selected**, pick the narrowest one a
   reproduction test (below) proves sufficient:
   - **(a) `worker_thread` offload** — move the `pipeline()` embedding call into a worker thread;
     pass chunk text in, receive `Float32Array` embeddings back (structured-clone friendly, no
     `SharedArrayBuffer` needed). Keeps one deployable process. Preferred default unless
     investigation rules it out.
   - **(b) Separate OS process** — a second worker binary/entrypoint dedicated to `notes.sync`,
     deployed independently. Full OS-level isolation and crash containment, but changes the
     deploy topology (new compose service, new image target). **Do not build this without a
     separate Ben/Fable call** — if (a) and (c) together prove insufficient in the reproduction
     test, stop and escalate rather than building (b) unilaterally.
   - **(c) Cap ONNX/transformers.js thread count + explicit yields** between chunks in the
     `EMBED_CONCURRENCY = 4` loop, to leave OS scheduling headroom. Investigate at build time what
     knob transformers.js actually exposes for its active backend (`env.backends.onnx.wasm.numThreads`
     for WASM; `SessionOptions.interOpNumThreads`/`intraOpNumThreads` if native `onnxruntime-node`).
     Treat as a companion to (a), not a substitute, unless the reproduction test shows it alone is
     sufficient.
2. **Bound ingest size per run.** Cap chunks processed per `notes.sync` job invocation; split very
   large files/transcripts across multiple job runs rather than one unbounded synchronous batch.
   Must not silently drop chunks — deferred chunks must re-enqueue, not vanish (this repo's
   existing chunking is lossless by design per the `EMBED_MAX_TOKENS` fix comment; preserve that).
3. **Fix `news_refresh_state` stuck-at-`queued`.** `failRefreshRunIfCurrent` (or its caller) must
   not depend on the same DB connection/context that may have just died. On failure, acquire a
   fresh scoped context to write `state = 'failed'`, so a mid-run death is observable instead of
   silently stuck at `queued` forever.
4. **Do not treat raising `JARVIS_DB_CONNECT_TIMEOUT_MS` as the fix.** It's a legitimate defensive
   companion but is explicitly **out of scope for this build** — it requires a container recreate
   and is Ben's call independently of this spec. Do not ship it as a substitute for isolation.

Non-negotiable constraints on all of the above: preserve embedding correctness/ordering, the
512-token per-chunk cap (#1359), and the 4-way in-flight concurrency cap (#1357) — this is
additive isolation, not a rewrite of the embedding pipeline.

## Locked reproduction contract

A deterministic, CI-safe test — not a timing-flaky one:

- Run a synthetic large-document `notes.sync` ingest (representative chunk count, e.g. ~500+) and
  concurrently drive a second, unrelated queue's job through the same worker process (or a
  standalone harness that mirrors `registerBuiltInModuleWorkers`'s registration shape).
- Measure event-loop responsiveness directly during the ingest — `perf_hooks`'
  `monitorEventLoopDelay()`, or a `setImmediate`/heartbeat counter tracking missed ticks — rather
  than relying on a real 5-second pg timeout firing (flaky, slow, environment-dependent).
- **Pre-fix:** max observed event-loop delay exceeds a defined threshold (e.g. >1000ms sustained)
  during the ingest, and/or the concurrent unrelated job's DB-connection-acquire step measurably
  stalls past its timeout in a controlled harness.
- **Post-fix:** max event-loop delay during the same ingest stays under the threshold, and the
  concurrent unrelated job completes without a connection-timeout failure.
- Separately: a focused test proving the `news_refresh_state` fail-path writes `'failed'` even when
  the job's original DB context is already broken (simulate by killing/discarding it before calling
  the fail path).

## Focused acceptance

- [ ] A large `notes.sync` ingest no longer causes concurrent unrelated queue jobs
      (`news.refresh`, `connectors.*`, `chat.embed-turn`, `job-search.crawl-sweep`) to fail with
      `Connection terminated due to connection timeout`.
- [ ] Reproduction test (above) is red on current `main`, green after the fix.
- [ ] `notes.sync` still ingests correctly — same embeddings, same chunk boundaries, no silent
      data loss, verified against the existing notes-sync test suite.
- [ ] A file whose chunk count exceeds the new per-run cap is fully ingested (across multiple runs
      if needed), not partially dropped.
- [ ] `news_refresh_state` reaches `'failed'`, not stuck `'queued'`, when a job dies mid-run —
      covered by the focused test above.
- [ ] `EMBED_MAX_TOKENS` (512) and `EMBED_CONCURRENCY` (4) unchanged.
- [ ] No change to `JARVIS_DB_CONNECT_TIMEOUT_MS` shipped as part of this PR.
- [ ] Matched e2e/UAT: trigger a real large-vault ingest on live dev while another queue has
      pending work, and show (screenshot/log excerpt on the PR) the other queue's job completing
      normally.

## Process notes

- Drafted directly by the coordinator at Ben's explicit request ("draft the spec please... send it
  through telegram"), not through the usual Fable-first-pass path — Ben is doing this review
  personally. This is a deviation from the standing `plan-build`/`coordinated-build` default (where
  Sonnet build agents don't author plans; Fable does) — that restriction is scoped to
  implementation-level build plans, not this higher-level design spec, and doesn't apply when Ben
  asks the coordinator directly.
- Direction (a)/(b)/(c) above are intentionally left unselected — the CPU-isolation mechanism has
  a real design tradeoff (deploy-topology cost for (b) vs. uncertain sufficiency of (c) alone) that
  should be resolved by the reproduction test's evidence at build time, not guessed here.
- The interim mitigation (raising the connect timeout) is explicitly called out as out-of-scope and
  independent of this spec, per the issue body.
