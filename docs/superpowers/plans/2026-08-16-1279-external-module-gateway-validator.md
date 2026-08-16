# Plan — #1279 external-module gateway validator

Part of #1279. Spec: `docs/superpowers/specs/2026-08-09-wave-4-external-module-supply-chain.md`
(lane C, last item). Risk tier: **security** — adversarial Opus QA + Ben's explicit merge sign-off
required before merge. Internal-only (module-registry validator + test, no UI surface) — no
live-path/UAT proof needed.

## Seams check (file:line citations, verified on this branch 2026-08-16)

- `packages/module-registry/src/external/tool-manifests.ts:44-63` — `createExternalToolManifests`
  hardcodes `isExternal: true` on every tool synthesized from an installed external module's
  manifest, and passes `inputSchema: tool.inputSchema` through unchanged. This is the wiring that
  pins external tools onto the worker-thread pattern-matching path — confirmed, untested today (no
  existing test exercises input validation for an external tool).
- `packages/ai/src/gateway/input-validation.ts:355-377` — `validateToolInput(schema, input,
options: { readonly external: boolean })`. Throws `ToolInputValidationError` at 7 sites, all
  field-path-only, no tool name: lines 145, 197, 211, 228, 233, 245, 252, 270, 291, 297, 361 (the
  Missing-required-field / enum / type-mismatch / bounds / pattern messages already read verbatim
  in the handoff doc).
- Exactly 3 production call sites (repo-wide grep, excluding `node_modules`/`.test.ts`), all
  confirmed on this branch:
  - `packages/ai/src/gateway/gateway.ts:184` — `callTool(token, toolName, rawInput)`, `toolName` in
    scope, caught locally at line ~189 (`error instanceof Error ? error.message : "Invalid
input"`), returned as `{ ok: false, error }`.
  - `packages/ai/src/gateway/gateway.ts:424` — `runReadToolForActor(actorUserId, toolName,
rawInput)`, `toolName` in scope, same local catch/return shape at line ~429.
  - `packages/ai/src/routes.ts:713` — REST route handler, `manifestTool`/`selectedTool.name` in
    scope; this call is inside a broader try/catch that delegates to the generic
    `handleRouteError` (routes.ts ~1180), which only knows `error.message` — confirms the fix must
    live inside `input-validation.ts`, not be bolted onto each call site's error handling.
- `packages/ai/src/gateway/gateway.ts:407-455` — `runReadToolForActor` is the dedicated read-tool
  path: no session token, no notifier wait, no `resolveActionRequest` — it returns directly from
  `validateToolInput`'s catch block before touching `executeTool`. Confirmed by reading lines
  390-455 in full. This is the cheapest call site to drive the new test through.
- `packages/ai/src/gateway/input-validation.ts:245-252` (`validateStringBounds`) — a pattern
  mismatch on an external tool (worker-thread path, since `external: true`) throws
  `` `Field ${path} has an invalid format` `` (line 252) with no tool name — the exact rejection
  the new test asserts gets a tool name prefixed onto it.
- `tests/integration/external-module-gateway.test.ts` (170 lines, read in full) — existing scaffold
  reused as-is: `describe`/`beforeAll`/`afterAll`, `resetFoundationDatabase()`, `createDatabase()`,
  `DataContextRunner`, real `createExternalToolManifests()` + real `AssistantToolGateway`. Both
  existing tests use a write-risk tool through the confirm/audit flow; the new test uses a
  read-risk tool through `runReadToolForActor`, which needs none of that machinery.
- `packages/module-sdk/src/external-module.ts:184` — `ModuleAssistantToolRisk` includes `"read"` as
  a valid `risk` value for `ExternalModuleAssistantToolDeclaration`. Confirmed.

No open questions — every assumed capability above is cited from the current tree.

## Determinism boundary

N/A — no UI surface, no model-authored user data, no chat turns. This is a backend validator
exception path with a purely mechanical string change (prefix the tool name onto an existing error
message). Stating this explicitly per plan-build step 3.

## Task 1 — name the tool in `ToolInputValidationError`

File: `packages/ai/src/gateway/input-validation.ts`

- Widen `validateToolInput`'s options type:
  ```ts
  export async function validateToolInput(
    schema: JsonSchema | undefined,
    input: unknown,
    options: { readonly external: boolean; readonly toolName: string }
  ): Promise<ToolInput>;
  ```
- Wrap the existing body (the `if (!schema)` early return already needs no wrapping — no error can
  throw before it) in try/catch around the `validateObject` call and the `"object"` type-guard at
  the top: catch any `ToolInputValidationError`, re-throw
  `new ToolInputValidationError(\`Tool ${options.toolName}: ${error.message}\`)`. Single DRY point
of change in `validateToolInput`itself — do NOT thread`toolName`through`validateObject`/`validateValue`/`validateStringBounds`/`compilePattern` (that's ~7 call sites of
  unnecessary churn for the same result).
- Non-`ToolInputValidationError` throws (there shouldn't be any, but the catch is typed to
  `unknown`) re-throw unchanged — only prefix our own error class.

## Task 2 — update the 3 call sites

- `packages/ai/src/gateway/gateway.ts:184` (`callTool`) — pass `toolName: toolName` in the options
  object alongside the existing `external: found.tool.isExternal !== false`.
- `packages/ai/src/gateway/gateway.ts:424` (`runReadToolForActor`) — same, `toolName: toolName`.
- `packages/ai/src/routes.ts:713` — pass `toolName: selectedTool.name` (confirm exact variable name
  in scope at that line while editing — handoff doc names it `selectedTool.name`).

## Task 3 — test

File: `tests/integration/external-module-gateway.test.ts` — add one `it()` to the existing
`describe` block, reusing the existing `beforeAll`/`afterAll`.

**Test case: "names the tool in the rejection when an external read tool's input fails pattern
validation"**

- Build an `ExternalModuleDiscovery` (`id: "acme"`, same manifest shape as the existing tests)
  whose single `assistantTools` entry is `risk: "read"`, `handler: "read"`, with an `inputSchema`
  declaring one required string property with a `pattern` a hostile value will fail to match (e.g.
  `pattern: "[a-z]+"`, required `["value"]`).
- `createExternalToolManifests([discovery], invoke)` with an `invoke` that pushes to a `calls`
  array (asserting it's never called — validation must reject before the handler runs).
- Construct `AssistantToolGateway` with the same deps shape as the existing tests
  (`resolveActiveModules`, `repository: new AiRepository()`, `runner: new
DataContextRunner(appDb)`, `tokens`, `confirmations`, `notifier`, `confirmTimeoutMs`) — token/
  confirmations/notifier are unused by `runReadToolForActor` but required by the constructor.
- Call `gateway.runReadToolForActor(ids.userA, "acme.read", { value: "NOT-LOWERCASE-OR-WHATEVER" })`
  directly — no token mint, no notifier wait loop.
- Assert: `result.ok === false`, `calls.length === 0` (handler never invoked), and
  `result.error` contains both the tool name `"acme.read"` and the field-level message fragment
  `"has an invalid format"` (proves the prefix is additive, not a replacement).

**Why this fails against the current implementation:** today `validateToolInput`'s catch in
`runReadToolForActor` (gateway.ts:429) returns `error.message` verbatim —
`` `Field value has an invalid format` `` — with no `"acme.read"` substring anywhere. The assertion
on the tool name in `result.error` fails until Task 1+2 land.

## Verification

```bash
pnpm --filter @moss/ai typecheck > /tmp/1279-ai-typecheck.log 2>&1; echo "EXIT=$?"
```

Expect `EXIT=0`.

```bash
pnpm --filter @moss/module-registry typecheck > /tmp/1279-mr-typecheck.log 2>&1; echo "EXIT=$?"
```

Expect `EXIT=0`.

Integration test — run via the `verify-gate` skill's isolated-DB recipe (never bare
`vitest run tests/integration/external-module-gateway.test.ts` against the live dev DB):

```bash
# per verify-gate skill, gate-DB scoped
```

Expect the new test green, both existing tests in the same file still green (regression check on
the write-risk/confirm-flow path, since `callTool`'s options object also changed shape).

Full pre-push trio + rebase before push, per `coordinated-build` step 3b. Full gate (`verify-gate`
skill, isolated DB) at wrap-up, not before.

## Kill gate

Single phase, no phase 2 planned. If the integration test cannot be made to fail against the
current (unpatched) code — i.e. if `runReadToolForActor`'s existing behavior already surfaces the
tool name some other way this plan missed — stop and re-verify the seams-check claims above before
writing any more code. Owner: build agent (self); escalate to coordinator if the re-check
contradicts this plan's grounding.

## Out of scope

- Doc drift noted in the handoff (issue #1279 cites `server.ts:415`, which doesn't exist in this
  tree; the real merge point is `tool-manifests.ts`) — mention in the PR description, not a code
  change.
- Threading `toolName` into the 7 individual throw sites inside `validateObject`/`validateValue`/
  `validateStringBounds` — explicitly rejected in favor of the single wrapping point in Task 1.
