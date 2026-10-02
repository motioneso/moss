# Build plan: classifier gate 4.1 — handled-turn lifecycle (unreachable live)

Task issue: #2901. Epic #2864. Parent plan: `docs/superpowers/plans/2026-10-01-classifier-gate-for-chat.md`
→ "4.1 Handled-turn lifecycle, initially unreachable live" (+ "Contracts and invariants", "Rulings").

Base branch: `cg-4-1-lifecycle`, forked from `origin/main` at `97915fdaf` (1.3). Builds on 3.1 (classifier
routing, `packages/ai/src/structured/classifier.ts`), 3.2 (`AssistantToolGateway.callToolForGate`,
`packages/ai/src/gateway/gateway.ts:217`), 3.3 (`ClassifierGate`, `packages/chat/src/live/classifier-gate.ts`),
3.4 (shadow records) and 1.2/1.3 (gate mode + `ClassifierReleaseRepository`). No migration.

Tier: security (gate token mint/revoke; no user-facing surface ships, so no live proof required).

## Goal and boundary

Run one accepted chat message through the already-merged decision engine at the shared turn boundary,
and when the engine handles it, persist and emit exactly one ordinary chat reply from the code-written
result template (or a code-written terminal-failure message) **without launching an engine**. Declines
fall back to today's default-model path, unchanged. Activation stays blocked: the admin gate can never
be `on` because no approved release can exist yet, and the settings write path refuses `on`.

Out of scope (explicit): shadow-mode runtime wiring and shadow-record correlation (plan 3.5, unfiled);
integration runtime menus/preparation (2b.5, unfiled); any UI or marker (ruling 11); the release
writer and Ben's activation decision (4.2). No migration.

Determinism boundary: the handled reply is rendered by code from the validated tool result or a fixed
failure string, never from classifier prose. No model-authored value reaches the user through this
path. The classifier gets only the message and the bounded menu, as 3.3 already enforces.

## Seams check (cited from the current tree)

- Shared turn lock and the pre-session hook point: `packages/chat/src/live/chat-session-manager.ts:302`
  (`submitTurn`), `:355` (`runTurn`), cancellation/activity setup `:370-389`, first use of a session
  `:397` (`ensureSession`), submit `:438`. Gate goes after `:389`, before `:397`.
- Decision engine and its port contract: `packages/chat/src/live/classifier-gate.ts:98`
  (`ClassifierGatePorts`), `:189` (`evaluate`), `:500` (dry-run vs execute), outcome shapes `:83-96`.
- Gateway gate entry: `packages/ai/src/gateway/gateway.ts:217` (`callToolForGate`), outcome type
  `packages/ai/src/gateway/types.ts:83`.
- Gate token mint without an engine: `packages/ai/src/gateway/session-tokens.ts` +
  `packages/chat/src/routes.ts:289` (`SessionTokenRegistry`), `:349-364` (mint captures the actor's
  executable-tool allowlist; revoke by session id).
- Classifier routing: `packages/ai/src/structured/classifier.ts:114` (`resolveClassifier`), `:135`
  (`askClassifierChoice`), `:171` (`extractClassifierValues`).
- Menu source with classifier declarations: `packages/module-registry/src/index.ts` `resolveActiveModules`
  → `MossModuleManifest.assistantTools[].classifier` (`packages/module-sdk/src/index.ts:652`,
  `packages/calendar/src/manifest.ts:305`). The `AiAssistantToolDto` mapping
  (`packages/ai/src/assistant-tools.ts:7`) drops `classifier`, so the menu reads manifests directly.
- Gate mode read: `packages/settings/src/runtime-config-resolver.ts:46` (`resolveEnum`),
  `packages/settings/src/runtime-config-keys.ts:22`; `on` cannot be written without a release
  (`packages/settings/src/runtime-config-routes.ts:146`), and env `on` fails closed (`resolver:106`).
- Release eligibility reader (empty; writer is 4.2): `packages/chat/src/classifier-release-repository.ts:21`.
- Persistence: `packages/chat/src/live/persistence.ts:248` (`recordTurn` requires an executed
  provider/model), `packages/chat/src/repository.ts:220` (`recordCompletedTurn` writes
  `model_metadata.executed` at `:269`), `packages/chat/src/route-serializers.ts:43` (metadata read
  tolerates absent `executed`). `ChatMessageDto` at `packages/shared/src/chat-api.ts:84`.
- Warm-session replay: `packages/chat/src/live/chat-session-provider-identity.ts:160` (a matching live
  session is returned without replay), `:160`/`manager:91` (`pendingForcedReplay`), discard pattern at
  `manager:691-714`.

## Decisions

### D1 — One optional runner dep; the hook runs only when the admin mode is `on`

Add `classifierGate?: ClassifierGateRunner` to `ChatSessionManagerDeps`
(`chat-session-ports.ts`), where

```ts
interface ClassifierGateRunner {
  mode(): Promise<GateMode>;
  evaluate(request: GateRequest): Promise<GateOutcome>;
}
```

`runTurn` reads `mode()` first; `off`/`shadow` do nothing (shadow wiring is 3.5). `on` calls
`evaluate` with `{actorUserId, message: text, hasAttachment: attachments.length > 0, incognito,
mode, signal: controller.signal}` under the existing turn controller, before `ensureSession`. Incognito
threads skip the gate entirely (ruling 9). No engine is launched or submitted on a handled turn.

### D2 — Outcome mapping (fallback exactly once, never after a mutating dispatch)

- `handled` → persist a gate-origin turn, emit user then reply, mark history replay, return.
- `terminal_failure` → persist the code-written failure as a gate-origin turn, emit, mark replay, return.
- `declined` → fall through to the existing path (which submits the original text once).
- `cancelled` → emit `"Stopped by user."`, touch activity, return; no fallback.
- `would_handle` → not produced in `on` mode; treated as a decline.

### D3 — Gate-origin completion contract

Add to `packages/shared/src/chat-api.ts`:

```ts
export interface ChatClassifierGateOriginV1 {
  readonly version: 1;
  readonly kind: "classifier_gate";
  readonly decisionId: string; // server turn correlation id
  readonly moduleId: string | null;
  readonly toolName: string | null;
  readonly outcome: "executed-success" | "executed-failure-or-unknown";
}
export type ChatTurnOriginV1 = ChatClassifierGateOriginV1;
```

`recordCompletedTurn` gains an optional discriminated origin: when the gate origin is present it
writes `model_metadata.origin` and writes **no** `executed` and **no** `usage`. Model turns keep
`executed`, so existing history stays readable. `ChatMessageDto.origin?` is serialized from
`model_metadata.origin`; absent origin means a model turn.

### D4 — Storage-failure safety

- A handled mutating attempt (risk `write`/`outbound`/`destructive`) whose storage write fails returns
  a code-written terminal-failure reply; it never falls back to the default model.
- A handled read whose storage write fails falls back (a read is safe to repeat).
- A terminal failure whose storage write fails still returns the failure text (live-only), never replay.

### D5 — Warm sessions see the handled turn on the next default turn

After a persisted gate turn, drop any live session for that actor/surface (kill + delete + revoke its
MCP token) and add the key to `pendingForcedReplay`, so the next default turn relaunches with normal
history. No synthetic submit happens during the gated reply.

### D6 — Real composition-root gate token

`createClassifierGateRunner` (new `packages/chat/src/live/classifier-gate-runner.ts`) mints one token
per attempt through the injected composition-root registry (`actorUserId`, a fresh correlation id,
the actor's captured executable-tool allowlist), passes it only to
`gateway.callToolForGate(token, name, input, mode)`, and revokes it in `finally` on every path. The
token is never logged and never enters a job payload, prompt, response, or persisted record.

### D7 — Activation stays blocked

Production `isReleased` reads `ClassifierReleaseRepository.listEligibleReleases` and requires a
module+tool+classifier-config-version match. No code path writes a release row (that writer is 4.2),
and the settings PUT refuses `on` without one, so the handled path is unreachable by a real turn. The
agent loop in the runner pre-resolves the classifier config version for the match. Chat manifest and
`app-map-core` describe the handled-turn path as present but unavailable pending review.

## Tasks and tests

1. Shared origin types (`chat-api.ts`) + serialization (`route-serializers.ts`).
2. Repository/persistence gate-origin write; model path unchanged.
3. `ClassiferGateRunner` type + manager hook (D1/D2/D4/D5).
4. `createClassifierGateRunner` + composition wiring in `routes.ts`/`runtime.ts` (D6/D7).
5. Manifest + core map copy.
6. `tests/unit/chat-classifier-live.test.ts`: cold and warm sessions; handled makes zero
   engine-launch/submit calls; decline submits original text once; read failure falls back; mutating
   partial failure never retries; storage failure after a mutating attempt never replays; cancelled
   stops; subsequent reference has normal history; HTTP/SSE/history agree. Fakes for runner/gateway.
7. Extend live-manager/persistence tests for the origin metadata and absent `executed`/`usage`.
8. Token safety: observe the revoke assertion fail with the `finally` removed, restore it.

## Verification

```bash
pnpm exec vitest run tests/unit/chat-classifier-live.test.ts tests/unit/chat-live-manager.test.ts
pnpm typecheck
pnpm format:check
pnpm lint
pnpm check:file-size
pnpm build:app-map
```

Full foundation gate only through `scripts/run-gate.sh` (verify-gate skill). No database command runs
outside it. Docs/format checks unpiped with expected exit 0.
