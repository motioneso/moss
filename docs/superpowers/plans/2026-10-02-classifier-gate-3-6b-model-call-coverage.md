# Lane plan: model activity log coverage + guard test (classifier gate 3.6b)

- Issue: #2890 (Build plan 3.6b; 3.6a is #2889, already merged in PR 2900)
- Tier: security
- Branch: `cg-3-6b-coverage`
- Migration: none. The 3.6a table `app.moss_model_activity_log` (migration
  `packages/ai/sql/0254_moss_model_activity_log.sql`) holds all six short columns; this lane adds no
  column. **If any step turns out to need a schema change, stop and report before writing one.**
- Depends on: 3.6a (merged). Recorder seam: `packages/ai/src/model-activity.ts`. Global recorder
  installed at both composition roots: `packages/module-registry/src/index.ts:3303`
  (`registerBuiltInApiRoutes`) and `:3731` (`registerBuiltInModuleWorkers`).
- Collision: lane 4.1 owns `packages/chat/src/live/persistence.ts`,
  `packages/chat/src/live/chat-session-ports.ts`, `packages/chat/src/repository.ts`,
  `packages/shared/src/chat-api.ts` and adds `packages/chat/src/live/classifier-gate-runner.ts`.
  This lane edits none of them. Live chat turns are recorded from the engine factory in
  `packages/chat/src/live/runtime.ts` (not in the four collision files).

## Scope (this lane only)

Ruling 15: the activity log records **every** model call. 3.6a covered the provider-adapter
boundary (HTTP chat/structured/transcription, CLI structured), which already covers the three
central functions and the direct `new HttpApiAdapter(...)` callers via the global recorder. This
lane records the paths that never touch an adapter, and adds a source guard that fails when a new
uncovered call site appears.

In scope:

1. The system-one `fetch` in `packages/ai/src/structured/generate-choices.ts` (skips adapters).
2. One row per turn for live chat, including CLI chat turns (engine submit/complete), recorded
   from the engine factory in `packages/chat/src/live/runtime.ts`.
3. One row per turn for module-build sessions
   (`apps/worker/src/module-build-live-agent.ts`; `packages/chat/src/live/module-build-codex-exec-session.ts`).
4. Embeddings, aggregated per job, at the embedding provider factory
   (`packages/memory/src/embedding-provider-config.ts`).
5. Provider probes (`packages/chat/src/live/provider-probe.ts`) and CLI check turns
   (`packages/chat/src/live/cli-check-turn.ts` / `packages/module-registry/src/cli-tools-refresh-wiring.ts`).
6. A guard test scanning for adapter constructions and CLI model-binary spawns, failing on a
   call site outside the recorded seams. Observe it fail on a deliberately uncovered call, then
   remove that call.
7. App-map/manifest/screen-subtitle copy updated to say exactly what is now recorded (remove
   "CLI chat turns are not recorded yet" only once true).

Out of scope: the admin terminal (a human running a CLI by hand), the four collision files, the
3.6a table/endpoint/screen shape.

## Seams check (verified on this branch, `file:line`)

- Recorder seam and helpers: `packages/ai/src/model-activity.ts:26` `ModelActivityRecorder`,
  `:67` `recordModelActivity`, `:129` `withModelActivityRecording`. Existing 3.6a unit test to
  extend: `tests/unit/ai-model-activity-recording.test.ts`.
- System-one call bypasses adapters: `packages/ai/src/structured/generate-choices.ts:229`
  `fetchImpl(baseUrl + "/v1/systemone", ...)` inside `postSystemOne`; `generateChoices:75`,
  `generateNoul:129` both route through it. Model name available on `model.provider_model_id`
  (`:212` body, `:190` kind gate).
- Live-chat engine submit/complete: `packages/chat/src/live/chat-session-manager.ts:302`
  `submitTurn` -> `runTurn:355`; `session.model` and `session.provider` available at persist
  (`:620-622`); stopped/watchdog paths return early at `:551`/`:560`. The engine-factory composition
  seam is `packages/chat/src/live/runtime.ts:422` `createRealEngineFactory` and `:430`
  `createAcpOneShotEngineFactory`; `CreateChatSessionRuntimeDeps` at `:459`; manager constructed at
  `:678`. A wrapper engine installed by the factory is the injection point (no collision files).
- Module build: `apps/worker/src/module-build-live-agent.ts:98` `deps.mux.submit(handle, prompt)`,
  `:100-109` completion poll; launched from `apps/worker/src/worker.ts:263` with `model.provider_kind`.
  `packages/chat/src/live/module-build-codex-exec-session.ts:54` `submit(text)` runs `codex exec`
  (`:70`, `:124`).
- Embeddings: `packages/memory/src/embedding-provider-config.ts:40` `createEmbeddingProvider` is
  documented as "the only place that instantiates an embedding provider" (`:39`); providers
  `LocalEmbeddingProvider`/`CpuIsolatedEmbeddingProvider`/`StubEmbeddingProvider` expose
  `modelName`. Per-job aggregation: the caller resolves config once per job via
  `getEmbeddingProviderConfig:65`.
- Probes: `packages/chat/src/live/provider-probe.ts:144` `probeProvider`; the actual model calls are
  `probeClaudeAuth:232` (`claude --print`), `probeCodexAuth:259` (`codex login status` — no model
  call), `probeGeminiAuth:266` (`gemini --prompt`). CLI check turns: `packages/chat/src/live/cli-check-turn.ts:40`
  `runCheckTurn` (engine.launch/submit/readNew), called from
  `packages/module-registry/src/cli-tools-refresh-wiring.ts:128`.
- App map copy: `packages/ai/src/manifest.ts:262-268` feature `ai.model_activity_log`;
  `packages/shared/src/app-map-core.ts:314-325` core setting `modelactivity`;
  `apps/web/src/settings/settings-model-activity-pane.tsx:168-171` subtitle.
- UAT spec to extend: `tests/uat/specs/2889-model-activity-log.uat.spec.ts`; trigger map rows at
  `.claude/skills/coordinate/uat-trigger-map.tsv:143-148`.

## Decisions

1. **System-one records through `recordModelActivity`, one row per post attempt.** `postSystemOne`
   already resolves the model before fetching; wrap the fetch+read with `withModelActivityRecording`
   keyed `{ kind: "structured", action: "choices", modelName: model.provider_model_id }`. A
   `needs_config`/`not_supported` result records nothing (no call was made); a real fetch records
   `ok`/`error`. `aborted` when `input.signal` aborted.
2. **Live chat records one row per turn from a wrapped engine.** Add a small engine wrapper in
   `packages/chat/src/live/turn-activity-engine.ts` and install it around the session engine factory
   in `runtime.ts`: `launch` captures the session model, `submit` marks a turn pending, a completed
   `readNew` records `ok`, a failed `readNew`/`submit` records `error`, and `interrupt` on a pending
   turn records `aborted`. The wrapper proxies every optional engine method unchanged. The row uses
   the session's actual model (from the launch options), never a hardcoded name. This lives entirely
   outside the four collision files, and avoids growing `chat-session-manager.ts`, which sits at the
   1000-line source limit. Inner tool-loop calls are not visible, so the row is per turn.
3. **Module-build records one row per step turn.** `createModuleBuildLiveAgent` gains an optional
   `recordTurn` dep (defaulting to `recordModelActivity`); it records one row on marker-complete
   (`ok`), step timeout/death (`error`). `worker.ts` passes the resolved `model` so `modelName` is
   the real model. `CodexExecSession.submit` records one row per `codex exec` invocation (`ok` on
   exit 0 with a parsed reply, `error` otherwise).
4. **Embeddings record one row per job, not per chunk.** `createEmbeddingProvider` gains an optional
   `onModelCall`; the provider wrapper counts `embedDocument`/`embedQuery` calls and records a
   single aggregated row when the job's provider is closed or at first-use completion. Because the
   provider has no job boundary of its own, add a small `withEmbeddingActivity(recorder, run)`
   helper that the job call site wraps — aggregation keys off one resolved provider per job. If
   there is no clean per-job boundary, record per provider instance creation + first call and note
   the limitation; escalate rather than guessing. `kind: "embedding"`, `action: "embedding"`,
   `modelName` = provider `modelName`.
5. **Probes and CLI checks record one row per real model call.** `probeProvider` records around the
   actual model-call branches (`probeClaudeAuth`, `probeGeminiAuth`): `kind: "probe"`,
   `action: "probe"`, `modelName` = provider kind label (probes have no saved model id, so the
   provider kind is the honest non-hardcoded label). `runCheckTurn` records one row per check turn:
   `kind: "check"`, `action: "check"`, `modelName` from the launch model when present else the
   provider kind. `codex login status` makes no model call and records nothing.
6. **Guard test scans source, allow-lists recorded seams.** New
   `tests/unit/model-call-coverage.test.ts` walks `packages/**` and `apps/**` `.ts/.tsx` for
   (a) `new HttpApiAdapter(`, (b) `new CliStructuredAdapter(` / `createCliStructuredAdapterFactory(`,
   (c) CLI model-binary spawns (`claude`, `codex exec`, `gemini`, `--print`/`--prompt` patterns).
   Each hit must be inside an allow-listed file+marker set: the adapter files themselves (which
   record internally), the recorder module, files that call `recordModelActivity`/
   `withModelActivityRecording`/accept `onModelCall`, and the three central functions. Any new hit
   outside the set fails the test with the offending `file:line`. The test lists the recorded seam
   files explicitly so a new call site forces a deliberate decision.
7. **Admin copy updated once recording is true.** `packages/ai/src/manifest.ts` feature description,
   `packages/shared/src/app-map-core.ts` `modelactivity` description, and the pane subtitle
   `apps/web/src/settings/settings-model-activity-pane.tsx` all drop "CLI chat turns are not
   recorded yet" and state the newly covered paths (chat turns incl. CLI, choices, embeddings,
   probes and checks, background tasks). Keep admin-only reads and "never shows chat text".

## Determinism boundary

Every entry remains a pure projection of transport facts: kind, a fixed action label, outcome,
the actual model name, and a fixed result line. No prompt, message text, tool argument, credential,
or user identity ever enters a field — there is no field for one. The screen renders only from the
stored row. Turn rows are emitted from engine terminal events, never from model prose.

## Tasks

### Task 1 — system-one choices recording (commit 1)

- `packages/ai/src/structured/generate-choices.ts`: wrap the `postSystemOne` fetch+read in
  `withModelActivityRecording(recordModelActivity, { kind: "structured", action: "choices",
modelName: model.provider_model_id }, ...)`. No call is made before model/credential resolution,
  so resolution failures record nothing.
- Unit test: a `generateChoices` with a fake fetch records exactly one `structured`/`choices` row
  with the model name and `ok`; a 500 records `error`; an aborted signal records `aborted`; message
  text in `state` never appears in the entry.

### Task 2 — live chat per-turn recording (commit 2)

- New `packages/chat/src/live/model-call-turn-recorder.ts` (no collision): an engine wrapper or a
  small callback pair (`onTurnStart`/`onTurnEnd`) that `runtime.ts` attaches around the engine it
  builds. Records one row per turn with the session model.
- `packages/chat/src/live/runtime.ts`: install the wrapper in the engine factory paths
  (`createRealEngineFactory`/ACP factory) so both in-process and RPC chat record.
- Unit test: a fake engine that emits a reply records one `chat`/`chat` row with the configured
  model; a stopped turn records `aborted`; a launch failure records `error`; the reply text never
  appears in the entry.

### Task 3 — module-build per-turn recording (commit 3)

- `apps/worker/src/module-build-live-agent.ts`: optional `recordTurn`. `apps/worker/src/worker.ts`
  passes `model.provider_kind` (or resolved label) — no hardcoded model.
- `packages/chat/src/live/module-build-codex-exec-session.ts`: one row per `codex exec` invocation.
- Unit tests in `tests/unit/worker-module-build-live-agent.test.ts` and
  `tests/unit/module-build-codex-exec-session.test.ts`: one row each on success/failure, prompt text
  absent.

### Task 4 — embeddings per job (commit 4)

- `packages/memory/src/embedding-provider-config.ts`: optional `onModelCall` plus an
  `withEmbeddingActivity` aggregation helper; record one aggregated row per job with the provider
  `modelName`.
- Unit test: several `embedDocument` calls within one job record one row; text absent.

### Task 5 — probes + CLI checks (commit 5)

- `packages/chat/src/live/provider-probe.ts`: record around the real model-call branches.
- `packages/chat/src/live/cli-check-turn.ts`: record one row per check turn; `cli-tools-refresh-wiring.ts`
  supplies the provider/model label.
- Unit tests: a probe that calls `claude --print` records one `probe` row; a check turn records one
  `check` row; `codex login status` records nothing; prompt text absent.

### Task 6 — guard test (commit 6)

- New `tests/unit/model-call-coverage.test.ts` per Decision 6.
- Observe it fail on a deliberately uncovered call (e.g. a throwaway `new HttpApiAdapter(...)` in a
  non-allow-listed file), record the failure, then remove the deliberate call and observe green.

### Task 7 — copy + trigger map + UAT live proof (commit 7)

- Update the three copy sites (Decision 7) and the trigger-map rows if new specs/files are added.
- Extend `tests/uat/specs/2889-model-activity-log.uat.spec.ts` (or add `2890-...spec.ts`) so a
  newly recorded call path — a live chat turn through the scripted chat provider, or a system-one
  choices call — shows on the real admin screen. Run it, capture exit code and assertions.

## Verification commands (unpiped, expected exit codes)

```bash
pnpm typecheck; echo "EXIT=$?"          # 0
pnpm lint; echo "EXIT=$?"               # 0
pnpm format:check; echo "EXIT=$?"       # 0
pnpm exec vitest run tests/unit/ai-model-activity-recording.test.ts tests/unit/model-call-coverage.test.ts; echo "EXIT=$?"  # 0
scripts/run-gate.sh start; scripts/run-gate.sh wait --follow   # backgrounded; 0 = green
```

## Kill gate (phase 1 = Tasks 1-2)

If live-chat per-turn recording cannot be attached without editing a lane-4.1 collision file, stop
and escalate to the coordinator before Task 3. Owner of the kill call: the coordinator. Rationale:
the collision note forbids editing those files, and a turn row that silently never fires would make
the app map dishonest.

## Observed guard failure (Task 6, recorded)

The coverage guard was observed failing on a deliberately uncovered call, then green after removal:

- Added `packages/example/uncovered.ts` containing `new HttpApiAdapter(...)`.
  `pnpm exec vitest run tests/unit/model-call-coverage.test.ts` exited **1**, naming
  `packages/example/uncovered.ts:4` in the failure.
- Removed the file; the same command exited **0**.

## Live-path proof

A dedicated spec, `tests/uat/specs/2890-model-activity-chat-turn.uat.spec.ts`, sends a live chat
turn (the newly recorded path, which reaches no adapter) against the scripted chat provider and
asserts its `chat` row shows on the real admin Model activity screen without the message text. It
is a separate spec because the scripted chat provider and the 3.6a briefing-writer HTTP provider
cannot both be the active chat model on one instance (a single instance rejects the chat turn with
"Live chat does not support API-key providers yet"). Run via `pnpm test:uat` on an isolated
instance; post command, exit code, and assertions as a PR comment.

Issue #2906 (found while proving this): the scripted chat provider was seeded `api_key`, which the
live chat route refuses, and a `cli` auth method with no ACP agent id trips the
`ai_provider_configs_auth_agent_identity` constraint. `tests/uat/seed/chunks/chat-script.ts` now
seeds an `anthropic` CLI provider with the `claude-acp` identity, and the spec's message includes
the `phase1-smoke` fixture's expected substring ("goals") so its single scripted turn is eligible.

If no working path is reachable on an isolated instance, report **code-complete, unverified** with
the exact blocker and do not claim done.
