# Classifier gate 3.5: runtime wiring and shadow live proof — lane plan

Date: 2026-10-02. Lane: cg-3-5-shadow. Issue: #2907 (epic #2864).
Worktree: `~/Jarv1s/.claude/worktrees/cg-3-5-shadow`, branch `cg-3-5-shadow` from
`origin/main` (`52d5c85d6`). Tier: security. Plan section 3.5 of
`docs/superpowers/plans/2026-10-01-classifier-gate-for-chat.md`, with the
"Contracts and invariants to build" and "Rulings (Ben, 2026-10-01)" sections.

## Scope

Wire the already-merged gate engine (3.1-3.4) into live chat and collect shadow
evidence for first-party tools only (calendar in 2.3; external installable
modules in 2.2). User-connected integrations (2b.5/2b.6) are out of lane; this
plan leaves a named ports seam they can extend and the PR says they join in a
follow-up (Ben's ruling, brief 2026-10-02).

Shadow never executes a gate-origin tool, never creates a gate card, never
consumes auto-run allowance, and never delays the default turn. Off makes no
classifier request. Private (incognito) chats take part in nothing and get no
record. No new store holds message text beyond the already-merged 3.4 row.

## Seams check (verified on this branch)

| Assumption                                       | Evidence                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gate engine, ports, outcome/trace                | `packages/chat/src/live/classifier-gate.ts:98` (`ClassifierGatePorts`), `:83` (`GateOutcome`), `:184` (`ClassifierGate`), `:44` (`GATE_LIMITS`)                                                                                                                                                           |
| Argument/eligibility helpers                     | `packages/chat/src/live/classifier-gate-arguments.ts:78` (`gateEligibilityProblem`), `:196` (`RISK_CONFIDENCE_BAR`), `:206` (`THRESHOLD_VERSION`)                                                                                                                                                         |
| Shadow repository contract                       | `packages/chat/src/classifier-shadow-repository.ts:131` (`open`), `:155` (`complete`), `:190` (`observeModelTool`), `:106` (`normalizeToolIdentity`), `:115` (`resolveComparison`)                                                                                                                        |
| Classifier transport                             | `packages/ai/src/structured/classifier.ts:114` (`resolveClassifier`), `:135` (`askClassifierChoice`), `:171` (`extractClassifierValues`)                                                                                                                                                                  |
| Gateway gate entry point                         | `packages/ai/src/gateway/gateway.ts:217` (`callToolForGate(token, name, input, "execute"\|"dry-run")`), `packages/ai/src/gateway/types.ts:83` (`GatewayGateOutcome`)                                                                                                                                      |
| Token registry, engine-independent mint          | `packages/ai/src/gateway/session-tokens.ts` minted from a supplied identity; `packages/chat/src/routes.ts:357` already mints with `allowedToolNames`                                                                                                                                                      |
| Composition root owns gateway + tokens + modules | `packages/chat/src/routes.ts:286-323` (`wiring`), `:128-137` (`resolveActiveModules`, `mcpServerUrl`), `:135` (`chatEngineFactory`)                                                                                                                                                                       |
| Runtime builds the manager                       | `packages/chat/src/live/runtime.ts:601`, manager deps at `:678-730`                                                                                                                                                                                                                                       |
| Turn boundary and transcript loop                | `packages/chat/src/live/chat-session-manager.ts:355` (`runTurn`), `:371` (controller), `:437` (`engine.submit`), `:505-529` (record loop; `record.kind === "tool" && record.toolName`), `:551-558` (cancel path; "persisted NOTHING"), `:663-669` (finally teardown)                                      |
| Tool manifests carry the opt-in                  | `packages/module-sdk/src/index.ts:653` (`classifier`), `packages/calendar/src/manifest.ts:342` (calendar opt-in), `packages/module-registry/src/external/tool-manifests.ts:123` (external opt-in)                                                                                                         |
| CLI structured adapter is chat-owned             | `packages/chat/src/live/cli-structured-adapter.ts:506` (`createCliStructuredAdapterFactory`); wired at `apps/api/src/server.ts:421`                                                                                                                                                                       |
| Chat seed defect                                 | `tests/uat/seed/chunks/chat-script.ts:13-18` seeds `providerKind: "anthropic"` with no `authMethod`, so it stores `api_key`; `packages/ai/src/repository.ts:472` defaults to `"api_key"`, and `packages/ai/sql/0246_ai_provider_acp_agent_id.sql:27` allows CLI only with an `acp_agent_id`. Issue #2906. |
| UAT can run repo TS against the live stack       | `tests/uat/specs/2503-allday-event-date.uat.spec.ts:106`, `tests/uat/specs/job-search-board-sql.ts:18` (`execUatSql`)                                                                                                                                                                                     |
| File-size cap is live                            | `chat-session-manager.ts` is 999 lines; the cap is 1000                                                                                                                                                                                                                                                   |

## Relationship to open PR 2903 (4.1)

4.1 (open) adds `classifier-gate-runner.ts` and `classifier-gate-lifecycle.ts`
and a `ChatSessionManagerDeps.classifierGate?: ClassifierGateRunner`, with
`createPorts?: (actorUserId, token) => ClassifierGateAttemptPorts & { gateway }`
left unset ("production wiring is yours"). 4.1 handles only mode `on`; it
explicitly lists shadow wiring as 3.5's job. I build against current `main`
(no 4.1 code) and provide the ports factory with exactly that signature so 4.1
can plug it in on rebase. If 4.1 merges mid-lane, rebase and wire its runner to
the same factory; do not copy its code.

## Decisions

### D1 — Ports factory: new `packages/chat/src/live/classifier-gate-wiring.ts`

Exports one factory. Shape matches 4.1's `createPorts` exactly.

```ts
export type ClassifierGatePortsFactory = (
  actorUserId: string,
  token: string
) => {
  readonly classifier: ClassifierGatePorts["classifier"];
  readonly listTools: ClassifierGatePorts["listTools"];
  readonly loadCandidates: ClassifierGatePorts["loadCandidates"];
  readonly isReleased: ClassifierGatePorts["isReleased"];
  readonly gateway: ClassifierGatePorts["gateway"];
};

export function createClassifierGatePortsFactory(deps: {
  readonly resolveActiveModules: ActiveModulesResolver;
  readonly dataContext: DataContextRunner;
  readonly gateway: Pick<AssistantToolGateway, "callToolForGate">;
  readonly classifierDeps: ClassifierDeps; // repository + cipher + createCliStructuredAdapter
  readonly releaseRepository: ClassifierReleaseEligibilityRepository;
  readonly moduleDescription: (manifest: MossModuleManifest) => string; // manifest.name
  readonly now(): number;
}): ClassifierGatePortsFactory;
```

- `listTools()` resolves `resolveActiveModules(actorUserId)`, keeps tools with
  `typeof execute === "function" && classifier !== undefined`, and maps each to
  `GateTool` (`moduleId: manifest.id`, `moduleDescription`, `name`, `risk`,
  `inputSchema`, `outputSchema`, `classifier`). It caches the manifest tool by
  `name` in the per-attempt closure so `loadCandidates` can reach the hook.
- The tool menu is the manifest set, not the gateway's `executableTools` filter
  (self-operation/web.search/service hides). The gateway re-validates at
  `callToolForGate`, so an unavailable pick is a truthful decline; shadow is a
  hypothetical decision anyway. Recorded as a known narrowing (invariant: the
  gateway is the only authority).
- `loadCandidates(tool, signal)` calls the cached manifest tool's
  `classifier.candidates(scopedDb, ctx, { signal })` under a scoped Db with a
  fresh `requestId`. Calendar declares none; absent hook means the engine never
  asks.
- `gateway.call(name, input, mode)` is `gateway.callToolForGate(token, name, input, mode)`.
- `classifier.resolve/choose/extract` wrap `resolveClassifier`/`askClassifierChoice`/
  `extractClassifierValues` from `@moss/ai` with a scoped Db and
  `MODULE_WORKER_SERVICE_KEY` (platform-level sorting lookup; no per-module
  binding may steal it — `repository.ts:1496`).
- `isReleased(tool)` reads `listEligibleReleases` and matches module + tool name.
  No release writer exists (4.2), so it is `false`; `on` stays unreachable.
- `classifierDeps.createCliStructuredAdapter` is built in `routes.ts` from
  `createCliStructuredAdapterFactory(dependencies.chatEngineFactory)`, matching
  `apps/api/src/server.ts:421`. Without it a CLI classifier declines
  `needs_config` (`generate-structured.ts:262`).

### D2 — Shadow runner: new `packages/chat/src/live/classifier-gate-shadow.ts`

```ts
export interface ClassifierGateShadowRunner {
  start(input: {
    actorUserId: string;
    surface: ChatSurface;
    message: string;
    turnId: string;
    hasAttachment: boolean;
    signal: AbortSignal;
  }): void;
  observeModelTool(actorUserId: string, turnId: string, rawToolName: string): void;
  noModelTool(actorUserId: string, turnId: string): void;
  cancelTurn(actorUserId: string, turnId: string): void;
}
```

- Reads mode; acts only on `"shadow"`. `off` returns with zero classifier work;
  `on` is not this runner's job (4.1/4.2).
- Reads incognito through an injected `readIncognito(actorUserId, surface)` only
  after mode is `shadow`, so `off` costs the default path nothing.
- Mints one short-lived token via injected callbacks
  (`mint(actorUserId, turnId, allowedToolNames)` / `revoke(turnId)`), allowlist
  from `gateway.listToolsForActor(actorUserId)`; revoked in `finally` on every
  path; never logged, never a job payload, never in a record.
- Resolves the classifier once, memoizes the handle for the engine, opens the
  3.4 record with `classifierConfigId = provider_config_id` and
  `classifierConfigVersion = provider_kind:provider_model_id:capability`
  (`"none"` when unresolved), evaluates `new ClassifierGate({...ports, now})`
  with `mode: "shadow"` (dry-run), then `complete`.
- Maps `GateOutcome` to `CompleteShadowRecordInput`: `would_handle` → decision
  `would_handle` + module/tool/confidence/lead-as-margin; `cancelled` →
  `cancelled`; `declined` reason `none`/`needs_earlier_conversation` → those
  decisions; reason `timeout`/`classifier_error` → `failed`; any other decline →
  `declined` with its reason. `handled`/`terminal_failure` cannot occur in
  shadow. Confidence/margin are the trace's weakest (`classifier-gate.ts:542`).
- Correlation buffer: a bounded `Map<turnId, { actorUserId; observation? }>`
  holds observations that arrive before `open` (the repository only correlates a
  row that exists). `observeModelTool`/`noModelTool`/`cancelTurn` set the first
  observation; after `open` the buffer is flushed directly to the repository and
  the entry is cleared when the attempt settles. A later observation on a
  settled turn goes straight to the repository. Bound ~200 entries; drop oldest.
- Every repository call runs under `dataContext.withDataContext({actorUserId,...})`
  and is wrapped so no failure reaches the turn (3.4 `open`/`complete` already
  return `false`; the runner also catches).

### D3 — Manager hook (keep `chat-session-manager.ts` under cap)

Add `classifierGateShadow?: ClassifierGateShadowRunner` to
`ChatSessionManagerDeps` (`chat-session-ports.ts`). In `runTurn`:

- After the controller/activity setup and before `ensureSession`, build
  `gateTurnId = randomUUID()` and call
  `classifierGateShadow?.start({...})` when the dep exists (pass the original
  `text`, `opts?.attachments.length > 0`, and `controller.signal`).
- In the transcript loop, on the first `record.kind === "tool"` carrying
  `toolName` and not `rejected`, call `observeModelTool(actorUserId, gateTurnId, record.toolName)`
  once (a local boolean; never later tools).
- On the `stopped` path call `cancelTurn`; after a completed loop with no tool
  record call `noModelTool`. Also best-effort in `finally`.

All observation logic lives in `classifier-gate-shadow.ts`; the manager change
is a handful of lines. Because the file is at 999/1000 lines
(`pnpm check:file-size`), extract one cohesive existing block into
`session-runtime-helpers.ts` unchanged to make room — the per-turn MCP readiness
gate (`chat-session-manager.ts:570-603`) is the candidate. Note the collision:
4.1 also edits `session-runtime-helpers.ts`; the coordinator serializes.

### D4 — Runtime and route wiring

- `runtime.ts`: add `classifierGateShadow?` to `CreateChatSessionRuntimeDeps`
  and pass it to `new ChatSessionManager({...})`.
- `routes.ts`: inside the existing `wiring` closure, build the ports factory
  (D1) and the shadow runner (D2):
  - `readMode` via `RuntimeConfigResolver(scopedDb).resolveEnum<GateMode>(CHAT_CLASSIFIER_GATE_MODE_CONFIG_KEY)`
    under `dataContext.withDataContext`, exactly as 1.2/1.3 read it.
  - `readIncognito` via `persistence.getCurrentThreadState`? The runner is built
    in `registerChatRoutes`, which has `dataContext`, not the persistence port.
    Use `ChatRepository.getThreadContext`/thread state under a scoped Db, or a
    small read of the current thread's incognito flag. Confirm the exact reader
    at build (`chat-session-ports.ts:87`, `repository.ts` thread state); the
    requirement is: private chat ⇒ no mode read result reaches the classifier.
  - tokens: `wiring.tokens.mint({actorUserId, chatSessionId: \`classifier-gate:${turnId}\`, allowedToolNames})`and`wiring.tokens.revokeBySessionId`— same registry as every session; the
allowlist is captured per attempt from`wiring.gateway.listToolsForActor`.
  - `classifierDeps`: `repository: wiring.aiRepository`, `cipher: createAiSecretCipher()`,
    `createCliStructuredAdapter: createCliStructuredAdapterFactory(dependencies.chatEngineFactory)`.
  - `releaseRepository: new ClassifierReleaseRepository()`.
  - Pass the runner to `createChatSessionRuntime`.
- The ports factory is also exported so 4.1's `createClassifierGateRunner` can
  take it as `createPorts` when that lands.

### D5 — Seed fix (issue #2906)

`tests/uat/seed/chunks/chat-script.ts`: create the provider with
`authMethod: "cli"` and `acpAgentId: "claude-acp"` (the mapping in
`0246_ai_provider_acp_agent_id.sql:15-18`), keeping `providerKind: "anthropic"`
and the scripted `encryptedCredential`. This satisfies
`ai_provider_configs_auth_agent_identity` and makes the live chat route accept
the scripted provider. Update `chat-script.test.ts` to assert `auth_method:
"cli"` and `acp_agent_id: "claude-acp"`. This is the only seed change; say so
in the PR.

### D6 — UAT classifier: deterministic and inspectable

The live proof needs a classifier that reliably declines or times out without a
real provider, plus a way to read the owner-only shadow row. Decision:

- The spec seeds its own classifier model at the start (a `docker exec tsx
--eval` fixture inside the spec, as `2503-allday-event-date.uat.spec.ts:106`
  does): an `openai-compatible` provider with a JSON-capable model pointed at a
  base URL that cannot answer (`http://127.0.0.1:1` for a fast refusal, a
  non-routable TEST-NET address for a hang). It then selects that model through
  the real Settings > Assistant & AI Classifier row, so the classifier identity
  and the gate state come from real records.
- The spec reads `app.chat_classifier_shadow_records` with `execUatSql`
  (`tests/uat/specs/job-search-board-sql.ts:18`) filtered to the admin actor's
  newest turns, and asserts the decision/reason and that no
  `app.assistant_action_requests` row and no calendar write accompanied the turn.
- Consequence: the live UAT proves off/decline/no-side-effect/default-answers,
  attachment, oversize, private, cancelled, simultaneous surfaces and
  normal/YOLO default behavior. A genuinely successful `would_handle` live path
  (a working classifier that predicts the model's tool) would need a new UAT
  fixture origin; that is called out as the fallback below and, if added, is
  scoped as a small fixture server mirroring
  `tests/uat/fixtures/briefing-writer-fixture-server.ts`. Correlation against a
  real model tool call and the timeout/malformed/cooldown variants are proven
  deterministically in the new unit test (D7), because they are gate-engine
  behaviors already fixture-tested in 3.3.
- **Fork for the coordinator:** is the decline-path live proof plus unit coverage
  enough for the live-path gate, or must the lane also add a working classifier
  fixture origin for a live `would_handle`/match? Recommendation: the former,
  scoped to this lane; the fixture is a follow-up if Ben wants shadow agreement
  data that includes matches before 2b.6.

### D7 — Focused tests

New `tests/unit/chat-classifier-gate-wiring.test.ts`: the factory builds
`GateTool`s only from manifest tools with a classifier; `loadCandidates` calls
the hook with the signal; `gateway.call` forwards `dry-run`; `isReleased` is
false with no release row; the classifier calls go through `@moss/ai`.

New `tests/unit/chat-classifier-shadow-runner.test.ts` (fake ports + fake
repository, fake clock/signal):

- `off` makes zero classifier calls and opens no record; `on` is ignored.
- incognito opens no record and makes no classifier call.
- `shadow` timeout maps to `failed` with reason `timeout` and starts cooldown;
  a second attempt inside 30s declines `cooling_off` without a provider call.
- malformed classifier answer maps to `classifier_error`/`failed`.
- `would_handle` completes with module/tool/confidence/margin; correlation
  before `open`, after `complete`, and first-tool-wins.
- classifier/ports throw ⇒ still declines, never throws to the caller.
- repository write failure (returns false) never throws and never blocks.

New/extended `tests/unit/chat-classifier-live*.test.ts`-style wiring test
(name deferred to avoid the 4.1 filename): `runTurn` calls `start` once with the
original text, observes only the first tool record, calls `cancelTurn` on Stop,
and `noModelTool` when no tool ran, with `classifierGateShadow` absent ⇒ no calls.

Observe at least one negative fail then restore: the first-tool-only assertion
must fail if the "already observed" guard is removed.

### D8 — App map and manifest (same PR)

- `packages/chat/src/manifest.ts`: `chat.classifier_gate` gains the truthful
  Shadow behavior; `chat.classifier_shadow_records` says shadow now runs and
  records decisions. Add a `chat.classifier_shadow_unavailable` error +
  remediation if a user-visible failure path exists (gate/classifier failure
  never surfaces; the default reply is unchanged, so describe that).
- `packages/shared/src/app-map-core.ts` (`aiproviders` entry, lines 265-279):
  state that while the Chat gate is Shadow, eligible (non-private) messages are
  also sent to the chosen classifier to record whether the gate would have
  handled them; no tool runs and no approval card appears; the main model still
  answers; private chats are not sent.

### D9 — No migration

The 3.4 table already exists. If a migration is needed, stop and report first.

## Verification (unpiped; expected exit 0)

| Scope                 | Command                                                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Unit (new)            | `pnpm exec vitest run tests/unit/chat-classifier-gate-wiring.test.ts tests/unit/chat-classifier-shadow-runner.test.ts` |
| Gate engine unchanged | `pnpm exec vitest run tests/unit/chat-classifier-gate.test.ts tests/unit/ai-classifier.test.ts`                        |
| Seed                  | `pnpm exec vitest run tests/uat/seed/chunks/chat-script.test.ts`                                                       |
| Static                | `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm check:file-size` (separately)                                |
| App map               | `pnpm build:app-map`                                                                                                   |
| Full gate             | `scripts/run-gate.sh start` then `scripts/run-gate.sh wait --follow` (background)                                      |
| Live proof            | `pnpm test:uat classifier-shadow.uat.spec.ts`                                                                          |

UAT trigger map: add `blocking` rows for the new/changed chat files →
`tests/uat/specs/classifier-shadow.uat.spec.ts`.

## Kill gate

If the live UAT cannot get the classification attempt to settle deterministically
(fast refusal and a hang both behave unpredictably in the compose network), stop
and report rather than weakening the assertions. The coordinator/Ben decides
whether to add the fixture origin (D6 fallback) or accept the unit-level proof.

## Risks / departures

- **4.1 collision.** My ports factory matches 4.1's `createPorts`; the manager
  dep name differs (`classifierGateShadow` vs `classifierGate`) to avoid a
  semantic clash. Rebasing 4.1 onto this lane (or this lane onto 4.1) is the
  coordinator's call; both edit `chat-session-ports.ts`, `runtime.ts`,
  `routes.ts`, `session-runtime-helpers.ts`.
- **`chat-session-manager.ts` line cap.** Extraction is unavoidable; see D3.
- **Live `would_handle`/match** is deferred to unit coverage unless the
  coordinator requires the fixture origin (D6).
- **Model activity log.** Classifier calls run through `generateStructured`
  (HTTP adapter), which 3.6a records. A `system-one` classifier's `generateChoices`
  fetch is recorded only by 3.6b (open PR 2904); this lane's UAT classifier is
  openai-compatible, so every classifier call in the proof is recorded by 3.6a.
