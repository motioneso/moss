# Sorting Model (Slice 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin pick an optional sorting model that the News and Sports story matcher tries first, falling back once to today's model when it is unset, bypassed, or fails.

**Architecture:** A reserved `sorting` key in the existing `ai.service_bindings` blob stores a model-only binding. A new repository method `resolveSortingModel` applies the precedence table (strict, pin, per-job binding) and the eligibility rule. `generateStructured` gains a `sorting?: true` input that runs one try on that model, then today's unchanged path once. The story evaluator opts in, stops using the sorting model for the rest of a run after its first failure, and threads an optional abort signal through both ports. One settings row picks the model.

**Tech Stack:** TypeScript, Fastify + fast-json-stringify schemas, Kysely (Postgres JSONB), Ajv, React + TanStack Query, vitest (jsdom + react-test-renderer for web).

**Spec:** `docs/superpowers/specs/2026-09-22-sorting-model.md` (rev 3, sections 3 to 6). Background: `docs/research/2026-09-22-sorting-model-fit-audit.md`. Issue #2594.

## Plain-English rule for humans (PASS THIS ON)

Ben reads status to know whether the work is going well, not to review code. In every chat
message, status update, handoff doc and spawn prompt, name things by what they do, keep exact
identifiers only where someone must act on them (a command, a file, an error string), use no
coined shorthand, and use plain ASCII punctuation. Commit messages, code comments and this plan
stay precise and technical. Every handoff doc and spawn prompt written from this plan must carry
this paragraph.

## Global Constraints

- Work only in the worktree `~/Jarv1s-wt/sorting-model`. Never touch `~/Jarv1s` (shared checkout).
- Commits use explicit paths: `git add <path> <path>`. Never `git add -A`, `git add .`, or a bare `git commit -a`.
- Never run `pnpm verify:foundation`, `pnpm test:integration`, or any database-touching test directly. Integration tests run only through the `verify-gate` skill (`scripts/run-gate.sh start --gate test:ai`, then `scripts/run-gate.sh wait --follow` backgrounded; read the exit code, not the text).
- CI's unit run only picks up `tests/unit/**`, `packages/scratchpad/src/__tests__` and `packages/acp/src` (`scripts/test-unit.ts`). New unit tests go in `tests/unit/`.
- Per-task checks: `pnpm test:unit <file>`, `pnpm typecheck`, `pnpm exec eslint <touched files> --max-warnings=0`. The full gate runs once at the end through the `verify-gate` skill.
- Reserved binding key: `sorting`. It accepts only `{ kind: "model", modelId }`. Mode bindings are rejected.
- Eligible sorting model: model `active`, provider `active`, provider purpose `assistant`, `json` capability, provider kind one of `anthropic`, `openai-compatible`, `google`. Kinds `ollama` and `custom` do not qualify in slice 1.
- No new capability in slice 1. Do not touch `AiModelCapability`, `AI_MODEL_CAPABILITIES`, or `USER_FACING_SERVICES`.
- The sorting attempt makes exactly one try and has no time limit of its own, matching the main model. It receives the caller's abort signal unchanged.
- Fallback runs once on any sorting failure (`needs_config`, `provider_error`, `validation_failed`). Never when the caller's own signal aborted.
- If today's path resolves to the same model id that just failed, return the original failure.
- Logs carry metadata only: job key, `servedBy`, failure category. Never prompts, content, or secrets.
- Settings row label: `Sorting model`. Description: `A small, fast model for sorting, filtering and picking out details. Leave empty to use your main model.` Empty option: `Use main model`.
- Disclosure line, shown whenever a sorting model is chosen: `Story details and your saved story preferences go to this model first, and to your main model if it does not answer. Each may charge for the request.`
- App map error: `sorting model not answering`. Remediation: `Moss tries your main model instead when it can. To stop trying the sorting model, choose Use main model.`
- Release note (Added): `Pick a small, fast model to sort and filter your news and sports stories. If it does not answer, Moss tries your main model instead.`
- UI uses existing `rt*` row classes and `Select` from `settings-ui`. Invent no classes. Run the `design-system` skill's invented-class audit on touched web files.
- Source files stay under 1000 lines (`pnpm check:file-size`). `settings-ai-admin-pane.tsx` is at 905, so the new row lives in its own file.
- Dev instance for live proof: web `http://192.168.50.36:5173`, API `:3000`. **Never `:1533` (production).**

## Review Focus

1. A sorting model whose provider is later disabled or deleted: the settings row must say so rather than showing a blank or wrong selection, and the job must run on the main model. Test added in Task 5 ("shows the unavailable note when the bound model no longer qualifies") and Task 2 ("a disabled provider makes resolveSortingModel return null").
2. A sorting model that answers with JSON that fails the schema: the one try must not be repaired and the main model must answer. Test added in Task 3 ("validation failure on the one sorting try falls back without a repair turn").
3. A caller abort during the fallback: a cancelled run must stop a hanging main-model call rather than wait for it. Test added in Task 3 ("a caller abort stops a hanging fallback").
4. An external module worker trying to set `sorting` through its RPC request: the host allow-list must keep dropping it (slice 4 owns that). Test added in Task 4 ("the worker RPC request allow-list does not admit sorting").
5. An admin who picks the sorting model and then pins a model for everyone: the pin must win and no request may reach the sorting provider. Test added in Task 3 ("resolveSortingModel returning null sends no request to the sorting provider") and Task 2 (pin row).

---

## File map

| File                                                      | Change                                                                                                              |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/ai-types.ts`                         | `SORTING_SERVICE_KEY`, `SortingServiceKey`, `SORTING_PROVIDER_KINDS`, `isSortingProviderKind`; widen `AiServiceKey` |
| `packages/shared/src/ai-service-binding-api.ts`           | params pattern and list-response map accept `sorting`                                                               |
| `packages/ai/src/repository.ts`                           | save/read/delete `sorting`; new `getSortingBinding`, `resolveSortingModel`                                          |
| `packages/ai/src/capability-route-routes.ts`              | GET/PUT/DELETE handle `sorting` with the eligibility rule                                                           |
| `packages/ai/src/structured/generate-structured.ts`       | `sorting` input, `servedBy`, one-try attempt, fallback                                                              |
| `packages/usefulness-feedback/src/relevance/evaluator.ts` | opt in, skip after first failure, signal                                                                            |
| `packages/usefulness-feedback/src/relevance/policy.ts`    | pass optional signal                                                                                                |
| `packages/news/src/discovery/ports.ts`                    | `NewsAiPort` input/result widen                                                                                     |
| `packages/module-registry/src/index.ts`                   | port input types widen; export both port builders                                                                   |
| `apps/web/src/api/client.ts`                              | `deleteAiServiceBinding`                                                                                            |
| `apps/web/src/settings/settings-ai-sorting-row.tsx`       | new sorting row                                                                                                     |
| `apps/web/src/settings/settings-ai-admin-pane.tsx`        | render the row in Services                                                                                          |
| `packages/ai/src/manifest.ts`                             | `ai.sorting_model` feature                                                                                          |
| `packages/shared/src/app-map-core.ts`                     | `aiproviders` description sentence                                                                                  |

---

### Task 1: Store and serve the sorting binding

**Files:**

- Modify: `packages/shared/src/ai-types.ts:103-120`
- Modify: `packages/shared/src/ai-service-binding-api.ts:35-56`
- Modify: `packages/ai/src/repository.ts:23-40` (imports), `:794-806` (`setServiceBinding`), `:858-872` (`deleteModuleServiceBinding`), new `getSortingBinding` after `:872`
- Modify: `packages/ai/src/capability-route-routes.ts:5-17,33,68-92,97-156,158-178,249-257`
- Test: `tests/unit/ai-sorting-binding-contract.test.ts` (new)
- Test: `tests/integration/ai-structured.test.ts` (new describe block before `describe("generateStructured end-to-end"`)

**Interfaces:**

- Produces (shared): `SORTING_SERVICE_KEY: "sorting"`, `type SortingServiceKey = "sorting"`, `SORTING_PROVIDER_KINDS: readonly AiProviderKind[]`, `isSortingProviderKind(kind: string | null | undefined): boolean`, `AiServiceKey = AiModelCapability | ModuleServiceKey | SortingServiceKey`.
- Produces (repository): `getSortingBinding(scopedDb): Promise<{ kind: "model"; modelId: string } | null>`; `setServiceBinding` accepts `"sorting"` with a model binding; `deleteModuleServiceBinding(scopedDb, service: ModuleServiceKey | SortingServiceKey, actorUserId)`.
- Produces (HTTP): `GET /api/ai/service-bindings` includes `bindings.sorting` when set; `PUT /api/ai/services/sorting/binding` (model only, eligible only); `DELETE /api/ai/services/sorting/binding`.

- [ ] **Step 1: Write the failing unit test**

Create `tests/unit/ai-sorting-binding-contract.test.ts`:

```ts
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";

import {
  SORTING_PROVIDER_KINDS,
  SORTING_SERVICE_KEY,
  aiServiceParamsSchema,
  isSortingProviderKind,
  listAiServiceBindingsResponseSchema
} from "../../packages/shared/src/index.js";

describe("sorting binding contract", () => {
  it("reserves the sorting key", () => {
    expect(SORTING_SERVICE_KEY).toBe("sorting");
  });

  it("only qualifies provider kinds the structured path can run", () => {
    expect([...SORTING_PROVIDER_KINDS].sort()).toEqual([
      "anthropic",
      "google",
      "openai-compatible"
    ]);
    expect(isSortingProviderKind("openai-compatible")).toBe(true);
    expect(isSortingProviderKind("ollama")).toBe(false);
    expect(isSortingProviderKind("custom")).toBe(false);
    expect(isSortingProviderKind(null)).toBe(false);
  });

  it("accepts sorting in the route params and keeps chat and module keys", () => {
    const validate = new Ajv().compile(aiServiceParamsSchema);
    expect(validate({ service: "sorting" })).toBe(true);
    expect(validate({ service: "chat" })).toBe(true);
    expect(validate({ service: "module.news" })).toBe(true);
    expect(validate({ service: "sortingx" })).toBe(false);
    expect(validate({ service: "json" })).toBe(false);
  });

  it("declares sorting in the list response so the serializer keeps it", () => {
    const bindings = listAiServiceBindingsResponseSchema.properties.bindings;
    expect(bindings.properties).toHaveProperty("sorting");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm test:unit tests/unit/ai-sorting-binding-contract.test.ts`
Expected: FAIL, `SORTING_SERVICE_KEY` is not exported.

- [ ] **Step 3: Add the shared contract**

In `packages/shared/src/ai-types.ts`, replace the `AiServiceKey` line and add the sorting block right after `MODULE_WORKER_SERVICE_KEY`:

```ts
// The reserved admin-level sorting model binding (#2594). Model bindings only.
export const SORTING_SERVICE_KEY = "sorting" as const;
export type SortingServiceKey = typeof SORTING_SERVICE_KEY;

// Everything the service-binding routes can address: a user-facing capability, a module key, or
// the sorting model.
export type AiServiceKey = AiModelCapability | ModuleServiceKey | SortingServiceKey;
```

and after `isModuleServiceKey`:

```ts
// Provider kinds generateStructured can execute. A local model qualifies through the
// OpenAI-compatible kind.
export const SORTING_PROVIDER_KINDS: readonly AiProviderKind[] = [
  "anthropic",
  "openai-compatible",
  "google"
];

export function isSortingProviderKind(kind: string | null | undefined): boolean {
  return kind != null && (SORTING_PROVIDER_KINDS as readonly string[]).includes(kind);
}
```

Delete the old `export type AiServiceKey = AiModelCapability | ModuleServiceKey;` line so the type is declared once.

In `packages/shared/src/ai-service-binding-api.ts`:

```ts
    service: { type: "string", pattern: "^(chat|sorting|module\\.[a-z0-9][a-z0-9_.-]{0,63})$" }
```

```ts
export const aiServiceBindingMapSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    chat: aiServiceBindingSchema,
    sorting: aiServiceBindingSchema
  },
```

- [ ] **Step 4: Run the unit test**

Run: `pnpm test:unit tests/unit/ai-sorting-binding-contract.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing integration tests**

In `tests/integration/ai-structured.test.ts`, add a module-level variable next to the other model ids:

```ts
let ollamaJsonModelId: string;
```

In `beforeAll`, after the three `seedModel` calls:

```ts
const ollamaProviderId = await seedProviderOfKind(
  "ollama",
  "Local Ollama",
  "http://127.0.0.1:11434"
);
ollamaJsonModelId = await seedModel(ollamaProviderId, "ollama-json", ["json"], "economy");
```

Add this helper under `seedProvider`:

```ts
async function seedProviderOfKind(
  providerKind: string,
  displayName: string,
  baseUrl: string
): Promise<string> {
  const response = await server.inject({
    method: "POST",
    url: "/api/ai/providers",
    headers: { authorization: `Bearer ${ids.sessionAdmin}` },
    payload: {
      providerKind,
      displayName,
      baseUrl,
      credentialPayload: { apiKey: "structured-test-secret" }
    }
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json().provider.id as string;
}
```

If the provider route rejects this payload for `ollama`, read the create-provider body parser in `packages/ai/src/routes.ts` (around `:820-850`) and adjust the payload fields only; do not change the route.

Add a new describe block before `describe("generateStructured end-to-end"`:

```ts
describe("sorting binding routes", () => {
  const auth = { authorization: `Bearer ${ids.sessionAdmin}` };
  const put = (binding: unknown) =>
    server.inject({
      method: "PUT",
      url: "/api/ai/services/sorting/binding",
      headers: auth,
      payload: { binding }
    });
  const list = async () =>
    (await server.inject({ method: "GET", url: "/api/ai/service-bindings", headers: auth })).json()
      .bindings as Record<string, unknown>;

  it("saves, reads and deletes a sorting model binding through the real repository", async () => {
    const saved = await put({ kind: "model", modelId: modelEconomyJsonId });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toEqual({
      service: "sorting",
      binding: { kind: "model", modelId: modelEconomyJsonId }
    });

    expect((await list()).sorting).toEqual({ kind: "model", modelId: modelEconomyJsonId });
    const direct = await dataContext.withDataContext(adminContext(), (scopedDb) =>
      repository.getSortingBinding(scopedDb)
    );
    expect(direct).toEqual({ kind: "model", modelId: modelEconomyJsonId });

    const del = await server.inject({
      method: "DELETE",
      url: "/api/ai/services/sorting/binding",
      headers: auth
    });
    expect(del.statusCode, del.body).toBe(200);
    expect(del.json()).toEqual({ service: "sorting" });
    expect((await list()).sorting).toBeUndefined();
  });

  it("rejects a mode binding for sorting", async () => {
    const response = await put({ kind: "mode", tier: "economy" });
    expect(response.statusCode).toBe(400);
    expect((await list()).sorting).toBeUndefined();
  });

  it("rejects a model without the json capability", async () => {
    const chatOnly = await seedModel(providerId, "sorting-chat-only", ["chat"], "interactive");
    const response = await put({ kind: "model", modelId: chatOnly });
    expect(response.statusCode).toBe(400);
  });

  it("rejects a json model on a provider kind the structured path cannot run", async () => {
    const response = await put({ kind: "model", modelId: ollamaJsonModelId });
    expect(response.statusCode).toBe(400);
  });

  it("the repository refuses a mode binding for sorting", async () => {
    await expect(
      dataContext.withDataContext(adminContext(), (scopedDb) =>
        repository.setServiceBinding(
          scopedDb,
          "sorting",
          { kind: "mode", tier: "economy" },
          ids.adminUser
        )
      )
    ).rejects.toThrow(/model binding/);
  });

  it("saving sorting leaves chat and module bindings untouched", async () => {
    const before = await list();
    expect((await put({ kind: "model", modelId: modelEconomyJsonId })).statusCode).toBe(200);
    const after = await list();
    expect(after.chat).toEqual(before.chat);
    expect(after["module.worker"]).toEqual(before["module.worker"]);
    await server.inject({
      method: "DELETE",
      url: "/api/ai/services/sorting/binding",
      headers: auth
    });
  });
});
```

Also update the existing test `"DELETE unbinds module keys only"` expectation text: it still expects `chat` DELETE to return 400, which stays true. No change needed there.

- [ ] **Step 6: Run the integration tests through the gate and watch them fail**

Use the `verify-gate` skill. Run `scripts/run-gate.sh start --gate test:ai`, then `scripts/run-gate.sh wait --follow` with `run_in_background`. Expected: exit code non-zero; the new sorting tests fail (400 "service is not bindable" / `getSortingBinding` is not a function).

- [ ] **Step 7: Implement repository storage**

In `packages/ai/src/repository.ts`, extend the `@moss/shared` import with `SORTING_SERVICE_KEY` and `type SortingServiceKey`, and the service-binding-map import with `parseServiceBinding`:

```ts
import {
  parseModuleServiceBindingMap,
  parseServiceBinding,
  parseServiceBindingMap
} from "./service-binding-map.js";
```

Replace the guard at the top of `setServiceBinding`:

```ts
assertDataContextDb(scopedDb);
if (service === SORTING_SERVICE_KEY) {
  // The sorting model has no mode: unset already means "run as today".
  if (binding.kind !== "model") {
    throw new Error('Service "sorting" accepts only a model binding.');
  }
} else if (
  !USER_FACING_SERVICES.has(service as AiModelCapability) &&
  !isModuleServiceKey(service)
) {
  throw new Error(`Service "${service}" is not bindable (worker capabilities stay automatic).`);
}
```

Widen the delete signature and its doc comment:

```ts
  /**
   * #915 D6: unbind a module service (returns to automatic routing) or clear the sorting model.
   * Single-statement JSONB key removal, mirroring the merge-upsert above so a concurrent write to
   * a DIFFERENT service key can't be clobbered (no read-modify-write).
   */
  async deleteModuleServiceBinding(
    scopedDb: DataContextDb,
    service: ModuleServiceKey | SortingServiceKey,
    actorUserId: string
  ): Promise<void> {
```

Add after `deleteModuleServiceBinding`:

```ts
  /** The admin's sorting model binding, or null when unset or malformed. */
  async getSortingBinding(
    scopedDb: DataContextDb
  ): Promise<{ readonly kind: "model"; readonly modelId: string } | null> {
    assertDataContextDb(scopedDb);
    const row = await scopedDb.db
      .selectFrom("app.instance_settings")
      .select("value")
      .where("key", "=", AI_SERVICE_BINDINGS_SETTING_KEY)
      .executeTakeFirst();
    return readSortingBinding(row?.value);
  }
```

Add a module-level helper near the other top-level helpers of the file (outside the class):

```ts
function readSortingBinding(
  value: unknown
): { readonly kind: "model"; readonly modelId: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const binding = parseServiceBinding((value as Record<string, unknown>)[SORTING_SERVICE_KEY]);
  return binding?.kind === "model" ? binding : null;
}
```

- [ ] **Step 8: Implement the routes**

In `packages/ai/src/capability-route-routes.ts`, add `SORTING_SERVICE_KEY` and `isSortingProviderKind` to the `@moss/shared` import.

In the GET handler, after the `for (const service of BINDABLE_SERVICES)` loop:

```ts
const sorting = await repository.getSortingBinding(scopedDb);
if (sorting) result[SORTING_SERVICE_KEY] = sorting;
```

In the PUT handler, replace the `if (binding.kind === "model") { ... }` block with:

```ts
if (service === SORTING_SERVICE_KEY && binding.kind !== "model") {
  throw new HttpError(400, "the sorting model accepts only a specific model");
}

// Module structured work and the sorting model require json; chat keeps its own
// capability. The sorting model must also run on a structured-capable provider kind.
if (binding.kind === "model") {
  const requiredCapability: AiModelCapability =
    service === SORTING_SERVICE_KEY || isModuleServiceKey(service) ? "json" : service;
  const models = await repository.listModels(scopedDb);
  const valid = models.some(
    (model) =>
      model.id === binding.modelId &&
      model.status === "active" &&
      model.provider_status === "active" &&
      model.capabilities.includes(requiredCapability) &&
      (service !== SORTING_SERVICE_KEY || isSortingProviderKind(model.provider_kind))
  );
  if (!valid) {
    throw new HttpError(400, "modelId must reference an active compatible model");
  }
}
```

In the DELETE handler, replace the module-only check:

```ts
const service = parseBindableService(request.params.service);
if (service !== SORTING_SERVICE_KEY && !isModuleServiceKey(service)) {
  throw new HttpError(400, "only module and sorting bindings can be deleted");
}
```

Update the comment above the DELETE route to `// #915 D6: unbinding a module service returns it to automatic routing; clearing sorting returns jobs to today's path. Chat has no unbind.`

In `parseBindableService`, add before the module check:

```ts
if (value === SORTING_SERVICE_KEY) {
  return SORTING_SERVICE_KEY;
}
```

- [ ] **Step 9: Typecheck and lint**

Run: `pnpm typecheck`
Expected: PASS. If a `switch` or `Record<AiServiceKey, ...>` elsewhere now fails because `AiServiceKey` gained `"sorting"`, add the missing `sorting` case there; do not narrow `AiServiceKey` back.

Run: `pnpm exec eslint packages/shared/src/ai-types.ts packages/shared/src/ai-service-binding-api.ts packages/ai/src/repository.ts packages/ai/src/capability-route-routes.ts tests/unit/ai-sorting-binding-contract.test.ts tests/integration/ai-structured.test.ts --max-warnings=0`
Expected: no output.

- [ ] **Step 10: Run the unit test and the gate**

Run: `pnpm test:unit tests/unit/ai-sorting-binding-contract.test.ts` - PASS.
Through the `verify-gate` skill: `scripts/run-gate.sh start --gate test:ai`, then `scripts/run-gate.sh wait --follow` backgrounded. Expected: exit code 0.

- [ ] **Step 11: Commit**

```bash
git add packages/shared/src/ai-types.ts packages/shared/src/ai-service-binding-api.ts packages/ai/src/repository.ts packages/ai/src/capability-route-routes.ts tests/unit/ai-sorting-binding-contract.test.ts tests/integration/ai-structured.test.ts
git commit -m "feat(ai): store and serve the sorting model binding (#2594)"
```

---

### Task 2: Decide when a job may use the sorting model

**Files:**

- Modify: `packages/ai/src/repository.ts` (new method `resolveSortingModel`, placed directly after `resolveModelForService`, around `:1320`)
- Test: `tests/integration/ai-structured.test.ts` (new describe block after `"sorting binding routes"`)

**Interfaces:**

- Consumes: `getSortingBinding`'s helper `readSortingBinding(value)`, `SORTING_PROVIDER_KINDS`, `MODULE_WORKER_SERVICE_KEY` (Task 1).
- Produces: `resolveSortingModel(scopedDb: DataContextDb, service: ModuleServiceKey, options?: { requireExplicitBinding?: boolean }): Promise<AiConfiguredModelSafeRow | null>`. Returns the sorting model row only when every bypass row of the spec table is false and the model still qualifies. Task 3 calls it.

- [ ] **Step 1: Write the failing integration tests**

Add to `tests/integration/ai-structured.test.ts`:

```ts
describe("resolveSortingModel precedence", () => {
  const sortingFor = (service: `module.${string}`, requireExplicitBinding = false) =>
    dataContext.withDataContext(adminContext(), (scopedDb) =>
      repository.resolveSortingModel(scopedDb, service, { requireExplicitBinding })
    );
  const setSorting = (modelId: string) =>
    dataContext.withDataContext(adminContext(), (scopedDb) =>
      repository.setServiceBinding(scopedDb, "sorting", { kind: "model", modelId }, ids.adminUser)
    );
  const clear = (service: `module.${string}` | "sorting") =>
    dataContext.withDataContext(adminContext(), (scopedDb) =>
      repository.deleteModuleServiceBinding(scopedDb, service, ids.adminUser)
    );

  it("returns null when no sorting binding exists", async () => {
    expect(await sortingFor("module.news")).toBeNull();
  });

  it("returns the sorting model when it is bound and qualifies", async () => {
    await setSorting(modelReasoningJsonId);
    expect((await sortingFor("module.news"))?.id).toBe(modelReasoningJsonId);
    await clear("sorting");
  });

  it("a strict job never reaches the sorting model", async () => {
    await setSorting(modelReasoningJsonId);
    expect(await sortingFor("module.news", true)).toBeNull();
    await clear("sorting");
  });

  it("an admin pin beats the sorting model", async () => {
    await setSorting(modelReasoningJsonId);
    await dataContext.withDataContext(adminContext(), (scopedDb) =>
      repository.setAdminPinnedModel(scopedDb, modelChatJsonId)
    );
    expect(await sortingFor("module.news")).toBeNull();
    await dataContext.withDataContext(adminContext(), (scopedDb) =>
      repository.setAdminPinnedModel(scopedDb, null)
    );
    await clear("sorting");
  });

  it("the job's own module binding bypasses the sorting model", async () => {
    await setSorting(modelReasoningJsonId);
    await dataContext.withDataContext(adminContext(), (scopedDb) =>
      repository.setServiceBinding(
        scopedDb,
        "module.news",
        { kind: "model", modelId: modelEconomyJsonId },
        ids.adminUser
      )
    );
    expect(await sortingFor("module.news")).toBeNull();
    expect((await sortingFor("module.sports"))?.id).toBe(modelReasoningJsonId);
    await clear("module.news");
    await clear("sorting");
  });

  it("a module.worker binding does not bypass the sorting model", async () => {
    await setSorting(modelReasoningJsonId);
    await dataContext.withDataContext(adminContext(), (scopedDb) =>
      repository.setServiceBinding(
        scopedDb,
        "module.worker",
        { kind: "mode", tier: "economy" },
        ids.adminUser
      )
    );
    expect((await sortingFor("module.news"))?.id).toBe(modelReasoningJsonId);
    await clear("module.worker");
    await clear("sorting");
  });

  it("a model that no longer qualifies is ignored", async () => {
    // Bypass the route check to simulate a binding that went stale after saving.
    await setSorting(ollamaJsonModelId);
    expect(await sortingFor("module.news")).toBeNull();
    await clear("sorting");
  });

  it("a disabled provider makes resolveSortingModel return null", async () => {
    const spareProvider = await seedProvider("Sorting Spare Provider");
    const spareModel = await seedModel(spareProvider, "sorting-spare", ["json"], "economy");
    await setSorting(spareModel);
    expect((await sortingFor("module.news"))?.id).toBe(spareModel);
    const disabled = await server.inject({
      method: "PATCH",
      url: `/api/ai/providers/${spareProvider}`,
      headers: { authorization: `Bearer ${ids.sessionAdmin}` },
      payload: { status: "disabled" }
    });
    expect(disabled.statusCode, disabled.body).toBe(200);
    expect(await sortingFor("module.news")).toBeNull();
    await clear("sorting");
  });
});
```

If the provider update route uses a different method or body for disabling, read `packages/ai/src/routes.ts` around `:270-300` and match it; keep the assertion.

- [ ] **Step 2: Run the gate and watch them fail**

`verify-gate` skill: `scripts/run-gate.sh start --gate test:ai`, `scripts/run-gate.sh wait --follow` backgrounded. Expected: non-zero; `resolveSortingModel is not a function`.

- [ ] **Step 3: Implement `resolveSortingModel`**

Add `SORTING_PROVIDER_KINDS` to the `@moss/shared` import in `packages/ai/src/repository.ts`. Add after `resolveModelForService`:

```ts
  /**
   * #2594: the sorting model for a job that opted in, or null when today's path must run alone.
   * Null when the job is strict, an admin pin is set, the job has its own module binding, no
   * sorting model is bound, or the bound model no longer qualifies. A module.worker binding is the
   * generic default and does not bypass the sorting model.
   */
  async resolveSortingModel(
    scopedDb: DataContextDb,
    service: ModuleServiceKey,
    options: { requireExplicitBinding?: boolean } = {}
  ): Promise<AiConfiguredModelSafeRow | null> {
    assertDataContextDb(scopedDb);
    if (options.requireExplicitBinding) return null;

    const row = await scopedDb.db
      .selectFrom("app.instance_settings")
      .select("value")
      .where("key", "=", AI_SERVICE_BINDINGS_SETTING_KEY)
      .executeTakeFirst();
    const binding = readSortingBinding(row?.value);
    if (!binding) return null;

    const [pinnedModelId, pinnedProviderId] = await Promise.all([
      this.getAdminPinnedModelId(scopedDb),
      this.getAdminPinnedProviderId(scopedDb)
    ]);
    if (pinnedModelId !== null || pinnedProviderId !== null) return null;

    if (service !== MODULE_WORKER_SERVICE_KEY && parseModuleServiceBindingMap(row?.value)[service]) {
      return null;
    }

    const model = await this.safeModelQuery(scopedDb)
      .where("models.id", "=", binding.modelId)
      .where("models.status", "=", "active")
      .where("providers.status", "=", "active")
      .where("providers.purpose", "=", "assistant")
      .where("providers.provider_kind", "in", [...SORTING_PROVIDER_KINDS])
      .where(sql<boolean>`${"json"} = any(${sql.ref("models.capabilities")})`)
      .executeTakeFirst();
    return model ?? null;
  }
```

- [ ] **Step 4: Typecheck, lint, gate**

Run: `pnpm typecheck` - PASS.
Run: `pnpm exec eslint packages/ai/src/repository.ts tests/integration/ai-structured.test.ts --max-warnings=0` - no output.
`verify-gate` skill with `--gate test:ai` - exit code 0.

- [ ] **Step 5: Commit**

```bash
git add packages/ai/src/repository.ts tests/integration/ai-structured.test.ts
git commit -m "feat(ai): resolve the sorting model behind pins, strict jobs and per-job bindings (#2594)"
```

---

### Task 3: Try the sorting model first in structured calls

**Files:**

- Modify: `packages/ai/src/structured/generate-structured.ts` (whole body of `generateStructured`, lines 65-288)
- Modify: `tests/unit/ai-generate-structured.test.ts:77-80,82-91,108-112,142-146` (add `servedBy`)
- Modify: `tests/integration/ai-structured.test.ts:~441` (add `servedBy: "main"` to the end-to-end `toEqual`)
- Test: `tests/unit/ai-generate-structured-sorting.test.ts` (new)

**Interfaces:**

- Consumes: `AiRepository.resolveSortingModel` (Task 2).
- Produces:
  - `GenerateStructuredInput.sorting?: true`.
  - `GenerateStructuredDeps.repository` is `Pick<AiRepository, "resolveModelForService" | "selectProviderWithCredential"> & Partial<Pick<AiRepository, "resolveSortingModel">>`.
  - `type StructuredServedBy = "sorting" | "main"`; success result gains `servedBy?: StructuredServedBy`. `generateStructured` always sets it on success. It is optional in the type so existing fakes that build a result still compile.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/ai-generate-structured-sorting.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import type { DataContextDb } from "@moss/db";

import {
  generateStructured,
  type GenerateStructuredDeps,
  type StructuredProviderAdapter
} from "../../packages/ai/src/structured/generate-structured.js";

const scopedDb = {} as DataContextDb;
const schema = {
  type: "object",
  additionalProperties: false,
  required: ["a"],
  properties: { a: { type: "string" } }
};
const mainModel = {
  id: "main-model",
  provider_config_id: "main-provider",
  provider_kind: "anthropic",
  provider_model_id: "main-x"
} as never;
const sortingModel = {
  id: "sorting-model",
  provider_config_id: "sorting-provider",
  provider_kind: "openai-compatible",
  provider_model_id: "small-x"
} as never;

const ok = (a: string) => ({ rawObject: { a }, usage: { inputTokens: 1, outputTokens: 1 } });

function adapters(sorting: StructuredProviderAdapter, main: StructuredProviderAdapter) {
  return (_kind: string, _key: string, baseUrl: string | null) =>
    baseUrl === "sorting" ? sorting : main;
}

function makeDeps(options: {
  sorting: StructuredProviderAdapter;
  main: StructuredProviderAdapter;
  resolveSortingModel?: ReturnType<typeof vi.fn> | null;
  mainResolves?: unknown;
  logger?: GenerateStructuredDeps["logger"];
}): GenerateStructuredDeps {
  const resolveSortingModel =
    options.resolveSortingModel === null
      ? undefined
      : (options.resolveSortingModel ?? vi.fn(async () => sortingModel));
  return {
    repository: {
      resolveModelForService: vi.fn(async () => ({
        model: (options.mainResolves ?? mainModel) as never,
        reason: "matched-active-model" as const
      })),
      selectProviderWithCredential: vi.fn(async (_db, providerId: string) => ({
        id: providerId,
        auth_method: "api_key",
        base_url: providerId === "sorting-provider" ? "sorting" : "main",
        encrypted_credential: {}
      })) as never,
      ...(resolveSortingModel ? { resolveSortingModel } : {})
    } as GenerateStructuredDeps["repository"],
    cipher: { decryptJson: vi.fn(() => ({ apiKey: "sk-test" })) },
    logger: options.logger,
    createAdapter: adapters(options.sorting, options.main)
  };
}

const input = (overrides: Record<string, unknown> = {}) => ({
  service: "module.news" as const,
  schema,
  prompt: "sort",
  sorting: true as const,
  ...overrides
});

describe("generateStructured sorting path", () => {
  it("serves from the sorting model when it answers", async () => {
    const sorting = { generateStructured: vi.fn(async () => ok("small")) };
    const main = { generateStructured: vi.fn(async () => ok("main")) };
    const result = await generateStructured(scopedDb, input(), makeDeps({ sorting, main }));
    expect(result).toMatchObject({ ok: true, object: { a: "small" }, servedBy: "sorting" });
    expect(main.generateStructured).not.toHaveBeenCalled();
  });

  it("returns aborted and calls nothing when the caller's signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const sorting = { generateStructured: vi.fn(async () => ok("small")) };
    const main = { generateStructured: vi.fn(async () => ok("main")) };
    const deps = makeDeps({ sorting, main });
    const result = await generateStructured(scopedDb, input({ signal: controller.signal }), deps);
    expect(result).toEqual({ ok: false, error: "aborted" });
    expect(deps.repository.resolveSortingModel).not.toHaveBeenCalled();
    expect(sorting.generateStructured).not.toHaveBeenCalled();
  });

  it("an explicit caller model sends no request to the sorting provider", async () => {
    const sorting = { generateStructured: vi.fn(async () => ok("small")) };
    const main = { generateStructured: vi.fn(async () => ok("main")) };
    const deps = makeDeps({ sorting, main });
    const result = await generateStructured(scopedDb, input({ explicitModel: mainModel }), deps);
    expect(result).toMatchObject({ ok: true, servedBy: "main" });
    expect(deps.repository.resolveSortingModel).not.toHaveBeenCalled();
    expect(sorting.generateStructured).not.toHaveBeenCalled();
  });

  it("resolveSortingModel returning null sends no request to the sorting provider", async () => {
    const sorting = { generateStructured: vi.fn(async () => ok("small")) };
    const main = { generateStructured: vi.fn(async () => ok("main")) };
    const result = await generateStructured(
      scopedDb,
      input(),
      makeDeps({ sorting, main, resolveSortingModel: vi.fn(async () => null) })
    );
    expect(result).toMatchObject({ ok: true, object: { a: "main" }, servedBy: "main" });
    expect(sorting.generateStructured).not.toHaveBeenCalled();
  });

  it("without sorting set, never asks for the sorting model", async () => {
    const sorting = { generateStructured: vi.fn(async () => ok("small")) };
    const main = { generateStructured: vi.fn(async () => ok("main")) };
    const deps = makeDeps({ sorting, main });
    const result = await generateStructured(scopedDb, input({ sorting: undefined }), deps);
    expect(result).toMatchObject({ ok: true, servedBy: "main" });
    expect(deps.repository.resolveSortingModel).not.toHaveBeenCalled();
  });

  it("a repository without resolveSortingModel runs today's path", async () => {
    const sorting = { generateStructured: vi.fn(async () => ok("small")) };
    const main = { generateStructured: vi.fn(async () => ok("main")) };
    const result = await generateStructured(
      scopedDb,
      input(),
      makeDeps({ sorting, main, resolveSortingModel: null })
    );
    expect(result).toMatchObject({ ok: true, servedBy: "main" });
  });

  it("falls back once on a provider error", async () => {
    const sorting = {
      generateStructured: vi.fn(async () => {
        throw new Error("AI provider request failed: HTTP 500");
      })
    };
    const main = { generateStructured: vi.fn(async () => ok("main")) };
    const info = vi.fn();
    const result = await generateStructured(
      scopedDb,
      input(),
      makeDeps({ sorting, main, logger: { info, warn: vi.fn() } })
    );
    expect(result).toMatchObject({ ok: true, object: { a: "main" }, servedBy: "main" });
    expect(sorting.generateStructured).toHaveBeenCalledTimes(1);
    expect(main.generateStructured).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      { service: "module.news", servedBy: "main", sortingFailure: "provider_error" },
      "ai.structured sorting fallback"
    );
  });

  it("validation failure on the one sorting try falls back without a repair turn", async () => {
    const sorting = {
      generateStructured: vi.fn(async () => ({
        rawObject: { wrong: 1 },
        usage: { inputTokens: 1, outputTokens: 1 }
      }))
    };
    const main = { generateStructured: vi.fn(async () => ok("main")) };
    const result = await generateStructured(scopedDb, input(), makeDeps({ sorting, main }));
    expect(result).toMatchObject({ ok: true, servedBy: "main" });
    expect(sorting.generateStructured).toHaveBeenCalledTimes(1);
  });

  it("falls back when the sorting provider has no usable credential", async () => {
    const sorting = { generateStructured: vi.fn(async () => ok("small")) };
    const main = { generateStructured: vi.fn(async () => ok("main")) };
    const deps = makeDeps({ sorting, main });
    deps.cipher.decryptJson = vi.fn((sealed: unknown) => {
      void sealed;
      return {};
    }) as never;
    const onlyMainCredential = vi.fn((_: unknown) => ({ apiKey: "sk-test" }));
    let calls = 0;
    deps.cipher.decryptJson = vi.fn((value: unknown) => {
      calls += 1;
      return calls === 1 ? {} : onlyMainCredential(value);
    }) as never;
    const result = await generateStructured(scopedDb, input(), deps);
    expect(result).toMatchObject({ ok: true, servedBy: "main" });
    expect(sorting.generateStructured).not.toHaveBeenCalled();
  });

  it("returns the original failure when today's path resolves to the same model", async () => {
    const sorting = {
      generateStructured: vi.fn(async () => {
        throw new Error("AI provider request failed: HTTP 503");
      })
    };
    const main = { generateStructured: vi.fn(async () => ok("main")) };
    const result = await generateStructured(
      scopedDb,
      input(),
      makeDeps({ sorting, main, mainResolves: sortingModel })
    );
    expect(result).toEqual({ ok: false, error: "provider_error" });
    expect(sorting.generateStructured).toHaveBeenCalledTimes(1);
    expect(main.generateStructured).not.toHaveBeenCalled();
  });

  it("does not fall back when the caller aborts during the sorting attempt", async () => {
    const controller = new AbortController();
    const sorting = {
      generateStructured: vi.fn(
        () =>
          new Promise<never>((_resolve, reject) => {
            setTimeout(() => {
              controller.abort();
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            }, 5);
          })
      )
    };
    const main = { generateStructured: vi.fn(async () => ok("main")) };
    const result = await generateStructured(
      scopedDb,
      input({ signal: controller.signal }),
      makeDeps({ sorting, main })
    );
    expect(result).toEqual({ ok: false, error: "aborted" });
    expect(main.generateStructured).not.toHaveBeenCalled();
  });

  it("a caller abort stops a hanging fallback", async () => {
    const controller = new AbortController();
    const sorting = {
      generateStructured: vi.fn(async () => {
        throw new Error("AI provider request failed: HTTP 500");
      })
    };
    const main = {
      generateStructured: vi.fn(() => {
        setTimeout(() => controller.abort(), 20);
        return new Promise<never>(() => undefined);
      })
    };
    const result = await generateStructured(
      scopedDb,
      input({ signal: controller.signal }),
      makeDeps({ sorting, main })
    );
    expect(result).toEqual({ ok: false, error: "aborted" });
  });
});
```

The "no usable credential" test above has a dead first assignment; delete the first `deps.cipher.decryptJson = ...` block and the unused `onlyMainCredential` indirection if eslint flags it, keeping the behaviour: the first decrypt (sorting provider) returns `{}`, the second (main) returns `{ apiKey: "sk-test" }`. Final form:

```ts
it("falls back when the sorting provider has no usable credential", async () => {
  const sorting = { generateStructured: vi.fn(async () => ok("small")) };
  const main = { generateStructured: vi.fn(async () => ok("main")) };
  const deps = makeDeps({ sorting, main });
  let calls = 0;
  const decryptJson = vi.fn(() => {
    calls += 1;
    return calls === 1 ? {} : { apiKey: "sk-test" };
  });
  const result = await generateStructured(scopedDb, input(), { ...deps, cipher: { decryptJson } });
  expect(result).toMatchObject({ ok: true, servedBy: "main" });
  expect(sorting.generateStructured).not.toHaveBeenCalled();
});
```

Use this final form in the file.

- [ ] **Step 2: Run the new tests and watch them fail**

Run: `pnpm test:unit tests/unit/ai-generate-structured-sorting.test.ts`
Expected: FAIL, the sorting model is never tried and results carry no `servedBy`.

- [ ] **Step 3: Refactor and implement**

In `packages/ai/src/structured/generate-structured.ts`:

Replace `GenerateStructuredDeps.repository`:

```ts
export type GenerateStructuredDeps = {
  readonly repository: Pick<
    AiRepository,
    "resolveModelForService" | "selectProviderWithCredential"
  > &
    Partial<Pick<AiRepository, "resolveSortingModel">>;
  readonly cipher: Pick<AiSecretCipher, "decryptJson">;
  readonly logger?: Pick<FastifyBaseLogger, "info" | "warn">;
  readonly createAdapter?: (
    kind: ProviderKind,
    apiKey: string,
    baseUrl: string | null
  ) => StructuredProviderAdapter;
  /** #982/#869/#981: implemented by chat and injected at module-registry; ai never imports chat. */
  readonly createCliStructuredAdapter?: (kind: ProviderKind) => StructuredProviderAdapter;
};
```

Add to `GenerateStructuredInput`, after `closeScope`:

```ts
  /** #2594: try the admin's sorting model first, then today's path once if it fails. */
  readonly sorting?: true;
```

Replace `GenerateStructuredResult`:

```ts
export type StructuredServedBy = "sorting" | "main";

type StructuredFailure = "needs_config" | "validation_failed" | "provider_error" | "aborted";

export type GenerateStructuredResult =
  | {
      readonly ok: true;
      readonly object: unknown;
      readonly usage: StructuredUsage;
      readonly sources?: readonly { readonly title: string; readonly url: string }[];
      /** Always set by generateStructured. Optional so hand-built results in tests compile. */
      readonly servedBy?: StructuredServedBy;
    }
  | { readonly ok: false; readonly error: StructuredFailure };

type SortingFailure = Exclude<StructuredFailure, "aborted">;

type RunOptions = {
  readonly maxAttempts: number;
  readonly signal: AbortSignal | undefined;
  readonly servedBy: StructuredServedBy;
};
```

Replace the whole `generateStructured` function with the router plus `runOnModel`:

```ts
export async function generateStructured(
  scopedDb: DataContextDb,
  input: GenerateStructuredInput,
  deps: GenerateStructuredDeps
): Promise<GenerateStructuredResult> {
  assertBoundedStructuredSchema(input.schema);
  assertBoundedStructuredPrompt(input.prompt);

  let sortingFailure: { readonly modelId: string; readonly error: SortingFailure } | null = null;
  if (input.sorting) {
    if (input.signal?.aborted) return { ok: false, error: "aborted" };
    const sortingModel = input.explicitModel
      ? null
      : ((await deps.repository.resolveSortingModel?.(scopedDb, input.service, {
          requireExplicitBinding: input.requireExplicitBinding
        })) ?? null);
    if (sortingModel) {
      // No time limit of its own, matching the main model. One try, on the caller's signal.
      const attempt = await runOnModel(scopedDb, input, deps, sortingModel, {
        maxAttempts: 1,
        signal: input.signal,
        servedBy: "sorting"
      });
      if (attempt.ok) return { ...attempt, servedBy: "sorting" };
      if (input.signal?.aborted) return { ok: false, error: "aborted" };
      // An abort the caller did not ask for came from the provider itself.
      sortingFailure = {
        modelId: sortingModel.id,
        error: attempt.error === "aborted" ? "provider_error" : attempt.error
      };
    }
  }

  const model =
    input.explicitModel ??
    (
      await deps.repository.resolveModelForService(scopedDb, input.service, {
        capability: "json",
        tierHint: input.tierHint,
        requireExplicitBinding: input.requireExplicitBinding
      })
    ).model;

  if (sortingFailure) {
    deps.logger?.info(
      { service: input.service, servedBy: "main", sortingFailure: sortingFailure.error },
      "ai.structured sorting fallback"
    );
    // Asking the same model twice would only double the wait.
    if (model?.id === sortingFailure.modelId) {
      return { ok: false, error: sortingFailure.error };
    }
  }
  if (!model) return { ok: false, error: "needs_config" };

  const result = await runOnModel(scopedDb, input, deps, model, {
    maxAttempts: STRUCTURED_MAX_REPAIR_RETRIES + 1,
    signal: input.signal,
    servedBy: "main"
  });
  return result.ok ? { ...result, servedBy: "main" } : result;
}

async function runOnModel(
  scopedDb: DataContextDb,
  input: GenerateStructuredInput,
  deps: GenerateStructuredDeps,
  model: GenerateStructuredExplicitModel,
  options: RunOptions
): Promise<GenerateStructuredResult> {
  const provider = await deps.repository.selectProviderWithCredential(
    scopedDb,
    model.provider_config_id
  );
  if (!provider) return { ok: false, error: "needs_config" };

  if (
    model.provider_kind !== "anthropic" &&
    model.provider_kind !== "openai-compatible" &&
    model.provider_kind !== "google"
  ) {
    deps.logger?.warn(
      { service: input.service, providerKind: model.provider_kind },
      "ai.structured unsupported provider kind"
    );
    return { ok: false, error: "provider_error" };
  }
  const providerKind = model.provider_kind as ProviderKind;
  let adapter: StructuredProviderAdapter;
  if (provider.auth_method === "cli") {
    // #982/#869/#981 D3: CLI credentials are sealed markers, not API keys. Route before decrypt so
    // AES-GCM can never see `{ cli: true }`; composition root supplies chat's CLI implementation.
    if (!deps.createCliStructuredAdapter) return { ok: false, error: "needs_config" };
    adapter = deps.createCliStructuredAdapter(providerKind);
  } else {
    let credential;
    try {
      credential = parseAiApiKeyCredential(deps.cipher.decryptJson(provider.encrypted_credential));
    } catch {
      // #981 defense-in-depth: never log ciphertext, credential material, or raw AES-GCM errors.
      deps.logger?.warn(
        { service: input.service, providerKind },
        "ai.structured credential could not be decrypted"
      );
      return { ok: false, error: "needs_config" };
    }
    if (!credential) return { ok: false, error: "needs_config" };
    const createAdapter =
      deps.createAdapter ??
      ((kind: ProviderKind, apiKey: string, baseUrl: string | null) =>
        new HttpApiAdapter(kind, apiKey, baseUrl ? { baseUrl } : {}));
    adapter = createAdapter(providerKind, credential.apiKey, provider.base_url ?? null);
  }

  const signal = options.signal;
  const ajv = new Ajv({ strict: false, validateFormats: false });
  const validate = ajv.compile(input.schema);
  const maxOutputTokens = input.maxOutputTokens ?? STRUCTURED_DEFAULT_MAX_OUTPUT_TOKENS;
  const messages: StructuredChatTurn[] = [{ role: "user", content: input.prompt }];
  const usage = { inputTokens: 0, outputTokens: 0 };

  for (let attempt = 0; attempt < options.maxAttempts; attempt += 1) {
    if (signal?.aborted) return { ok: false, error: "aborted" };

    let result: Extract<StructuredProviderResult, { readonly rawObject: unknown }>;
    try {
      // The race stops adapters that ignore the signal, such as CLI-backed ones.
      const generated = await raceAbort(
        adapter.generateStructured({
          service: input.service,
          model: { provider_kind: providerKind, provider_model_id: model.provider_model_id },
          messages,
          schema: input.schema,
          maxOutputTokens,
          nativeSearch: input.nativeSearch,
          signal,
          telemetry: input.telemetry,
          priority: input.priority,
          scope: input.scope,
          closeScope: input.closeScope
        }),
        signal
      );
      if (signal?.aborted) return { ok: false, error: "aborted" };
      // ... keep the existing rawText / unfence / StructuredOutputParseError block unchanged ...
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
        return { ok: false, error: "aborted" };
      }
      // ... keep the existing StructuredOutputParseError repair branch and the
      // "ai.structured provider error" warn + return unchanged ...
    }

    // ... keep the existing usage accumulation and byte-cap check unchanged ...

    if (validate(result.rawObject)) {
      deps.logger?.info(
        {
          service: input.service,
          servedBy: options.servedBy,
          modelId: model.id,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          attempts: attempt + 1
        },
        "ai.structured usage"
      );
      const sources = "sources" in result ? result.sources : undefined;
      return { ok: true, object: result.rawObject, usage, ...(sources ? { sources } : {}) };
    }

    // ... keep the existing repair-message push unchanged ...
  }

  return { ok: false, error: "validation_failed" };
}
```

The three "keep ... unchanged" markers mean: move lines 210-228, 233-259, 262-265 and 282-284 of the current file into those places verbatim, replacing `input.signal` with `signal` wherever it appears inside the moved code. Nothing else in those lines changes.

Add this helper below `runOnModel`:

```ts
function raceAbort<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      // The losing promise may still reject later; swallow it so it is never unhandled.
      work.catch(() => undefined);
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}
```

- [ ] **Step 4: Update the existing exact-match expectations**

In `tests/unit/ai-generate-structured.test.ts`, add `servedBy: "main"` to the three `toEqual({ ok: true, ... })` objects (around lines 77, 108, 142) and to the `"ai.structured usage"` log object at line 83:

```ts
      {
        service: "module.demo-module",
        servedBy: "main",
        modelId: "model-1",
        inputTokens: 10,
        outputTokens: 5,
        attempts: 1
      },
```

In `tests/integration/ai-structured.test.ts` around line 441:

```ts
expect(result).toEqual({
  ok: true,
  object: { title: "Staff Engineer" },
  usage: { inputTokens: 11, outputTokens: 7 },
  servedBy: "main"
});
```

- [ ] **Step 5: Run the tests**

Run: `pnpm test:unit tests/unit/ai-generate-structured-sorting.test.ts` - PASS.
Run: `pnpm test:unit tests/unit/ai-generate-structured.test.ts` - PASS.
Run: `pnpm test:unit tests/unit/ai-module-build-write-plan.test.ts tests/unit/module-registry-email-judgement-wiring.test.ts tests/unit/job-search-adapter-custom.test.ts` - PASS (these build results by hand and must still compile and pass).

- [ ] **Step 6: Typecheck, lint, gate**

Run: `pnpm typecheck` - PASS.
Run: `pnpm exec eslint packages/ai/src/structured/generate-structured.ts tests/unit/ai-generate-structured-sorting.test.ts tests/unit/ai-generate-structured.test.ts tests/integration/ai-structured.test.ts --max-warnings=0` - no output.
Run: `pnpm check:file-size` - PASS.
`verify-gate` skill with `--gate test:ai` - exit code 0.

- [ ] **Step 7: Commit**

```bash
git add packages/ai/src/structured/generate-structured.ts tests/unit/ai-generate-structured-sorting.test.ts tests/unit/ai-generate-structured.test.ts tests/integration/ai-structured.test.ts
git commit -m "feat(ai): try the sorting model once before today's path (#2594)"
```

---

### Task 4: Let the story matcher opt in

**Files:**

- Modify: `packages/usefulness-feedback/src/relevance/evaluator.ts:26-38,58-102`
- Modify: `packages/usefulness-feedback/src/relevance/policy.ts:28-36,64-68`
- Modify: `packages/news/src/discovery/ports.ts:123-134`
- Modify: `packages/module-registry/src/index.ts:784` (export), `:859-866` (News input type), `:890` (export), `:946-953` (Sports input type)
- Test: `tests/unit/story-relevance-evaluator.test.ts` (new cases)
- Test: `tests/unit/module-registry-sorting-ports.test.ts` (new)

**Interfaces:**

- Consumes: `GenerateStructuredInput.sorting`, `signal`, and result `servedBy` (Task 3).
- Produces:
  - `StoryRelevanceAiPort.generateJson(scopedDb, { schema, prompt, maxOutputTokens?, sorting?: true, signal?: AbortSignal })` returning `{ ok: true; object: unknown; servedBy?: "sorting" | "main" } | { ok: false; error: ... }`.
  - `NewsAiPort.generateJson` has the same input and result widening.
  - `evaluateStoryRelevance(scopedDb, deps, { candidates, rules, signal?: AbortSignal })`.
  - `StoryRelevancePolicy` input gains `signal?: AbortSignal`.
  - `buildNewsDiscoveryPorts` and `buildSportsDiscoveryPorts` are exported from `packages/module-registry/src/index.ts`.

- [ ] **Step 1: Write the failing evaluator tests**

Add to `tests/unit/story-relevance-evaluator.test.ts` (reuse `activeRule`, `candidates`, `SCOPED_DB`, and the fixtures already imported):

```ts
describe("sorting model opt-in (#2594)", () => {
  function manyCandidates(count: number): StoryRelevanceCandidate[] {
    const base = candidates();
    return Array.from({ length: count }, (_, index) => ({
      ...base[index % base.length]!,
      storyRef: `${base[index % base.length]!.storyRef}-${index}`
    }));
  }

  function recordingPort(servedBy: (call: number) => "sorting" | "main") {
    const calls: {
      sorting?: true;
      signal?: AbortSignal;
      schema: unknown;
      prompt: string;
    }[] = [];
    const port: StoryRelevanceAiPort = {
      async generateJson(_db, input) {
        calls.push(input);
        return { ok: true, object: { verdicts: [] }, servedBy: servedBy(calls.length) };
      }
    };
    return { port, calls };
  }

  it("passes sorting with the unchanged schema and prompt", async () => {
    const { port: plain, prompts } = answeringPort();
    await evaluateStoryRelevance(
      SCOPED_DB,
      { ai: plain },
      { candidates: candidates(), rules: [activeRule()] }
    );
    const { port, calls } = recordingPort(() => "sorting");
    await evaluateStoryRelevance(
      SCOPED_DB,
      { ai: port },
      { candidates: candidates(), rules: [activeRule()] }
    );
    expect(calls[0]?.sorting).toBe(true);
    expect(calls[0]?.schema).toBe(storyRelevanceResponseSchema);
    expect(calls[0]?.prompt).toBe(prompts[0]);
  });

  it("after the sorting model fails on batch one, later batches skip it", async () => {
    // 3 batches: the verdict cap forces a split.
    const { port, calls } = recordingPort((call) => (call === 1 ? "main" : "sorting"));
    await evaluateStoryRelevance(
      SCOPED_DB,
      { ai: port },
      { candidates: manyCandidates(MAX_STORY_RELEVANCE_VERDICTS * 2 + 1), rules: [activeRule()] }
    );
    expect(calls.length).toBe(3);
    expect(calls[0]?.sorting).toBe(true);
    expect(calls[1]?.sorting).toBeUndefined();
    expect(calls[2]?.sorting).toBeUndefined();
  });

  it("keeps using the sorting model while it answers", async () => {
    const { port, calls } = recordingPort(() => "sorting");
    await evaluateStoryRelevance(
      SCOPED_DB,
      { ai: port },
      { candidates: manyCandidates(MAX_STORY_RELEVANCE_VERDICTS + 1), rules: [activeRule()] }
    );
    expect(calls.map((call) => call.sorting)).toEqual([true, true]);
  });

  it("passes the run's signal to every call and stops when it aborts", async () => {
    const controller = new AbortController();
    const seen: (AbortSignal | undefined)[] = [];
    const port: StoryRelevanceAiPort = {
      generateJson(_db, input) {
        seen.push(input.signal);
        return new Promise((resolve) => {
          input.signal?.addEventListener("abort", () => resolve({ ok: false, error: "aborted" }), {
            once: true
          });
          setTimeout(() => controller.abort(), 10);
        });
      }
    };
    const result = await evaluateStoryRelevance(
      SCOPED_DB,
      { ai: port },
      { candidates: candidates(), rules: [activeRule()], signal: controller.signal }
    );
    expect(result).toEqual({ ok: false, error: "aborted" });
    expect(seen[0]).toBe(controller.signal);
  });
});
```

Add `MAX_STORY_RELEVANCE_VERDICTS` to the existing `@moss/shared` import at the top of the file (it is exported from `packages/shared/src/index.js`).

If the existing verdict parser rejects an empty `verdicts` array for a non-empty chunk, return `{ verdicts: chunkRefs.map(...) }` instead: read `parseStoryRelevanceVerdicts` in `packages/shared` and make `recordingPort` answer with `fixtureVerdict`-shaped rows whose `storyRef` matches each candidate in `input.prompt`. The assertions stay the same.

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm test:unit tests/unit/story-relevance-evaluator.test.ts`
Expected: FAIL, `calls[0]?.sorting` is undefined and `signal` is not accepted.

- [ ] **Step 3: Implement the evaluator and policy change**

In `packages/usefulness-feedback/src/relevance/evaluator.ts`, replace the port:

```ts
export interface StoryRelevanceAiPort {
  generateJson(
    scopedDb: DataContextDb,
    input: {
      schema: Record<string, unknown>;
      prompt: string;
      maxOutputTokens?: number;
      /** #2594: try the admin's sorting model first. */
      sorting?: true;
      signal?: AbortSignal;
    }
  ): Promise<
    | { ok: true; object: unknown; servedBy?: "sorting" | "main" }
    | { ok: false; error: "needs_config" | "validation_failed" | "provider_error" | "aborted" }
  >;
}
```

Add `readonly signal?: AbortSignal;` to the evaluator's `input` parameter type, and replace the loop:

```ts
const verdicts: StoryRelevanceVerdict[] = [];
// One sorting failure per run is enough: later batches go straight to the main model.
let trySorting = true;
for (const chunk of chunkCandidates(input.candidates)) {
  const refs = new Set(chunk.map((candidate) => candidate.storyRef));
  const generated = await deps.ai.generateJson(scopedDb, {
    schema: storyRelevanceResponseSchema,
    prompt: [
      INSTRUCTIONS,
      `UNTRUSTED DATA - the person's saved preferences:\n${ruleData}`,
      `UNTRUSTED DATA - candidate stories:\n${JSON.stringify(chunk.map(promptRow))}`
    ].join("\n"),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    ...(trySorting ? { sorting: true as const } : {}),
    ...(input.signal ? { signal: input.signal } : {})
  });
  // One bad chunk fails the whole evaluation. A half-filtered feed is never published: the
  // caller degrades, keeps everything except the exact exclusions, and can simply retry.
  if (!generated.ok) return { ok: false, error: generated.error };
  if (generated.servedBy !== "sorting") trySorting = false;
  const parsed = parseStoryRelevanceVerdicts(generated.object, refs);
  if (!parsed) return { ok: false, error: "malformed_output" };
  verdicts.push(...parsed);
}
return { ok: true, verdicts };
```

In `packages/usefulness-feedback/src/relevance/policy.ts`, add `readonly signal?: AbortSignal;` to the `StoryRelevancePolicy` input type, and pass it through:

```ts
const evaluated = await evaluateStoryRelevance(
  scopedDb,
  { ai: deps.ai },
  {
    candidates: input.candidates,
    rules: ruleRows,
    ...(input.signal ? { signal: input.signal } : {})
  }
);
```

- [ ] **Step 4: Widen the News port and the registry port types**

In `packages/news/src/discovery/ports.ts`:

```ts
export interface NewsAiPort {
  generateJson(
    scopedDb: DataContextDb,
    input: {
      schema: Record<string, unknown>;
      prompt: string;
      maxOutputTokens?: number;
      /** #2594: try the admin's sorting model first. */
      sorting?: true;
      signal?: AbortSignal;
    }
  ): Promise<
    | { ok: true; object: unknown; servedBy?: "sorting" | "main" }
    | {
        ok: false;
        error: "needs_config" | "validation_failed" | "provider_error" | "aborted";
      }
  >;
  fingerprint(scopedDb: DataContextDb): Promise<string | null>;
}
```

In `packages/module-registry/src/index.ts`, change `function buildNewsDiscoveryPorts(` to `export function buildNewsDiscoveryPorts(` and `function buildSportsDiscoveryPorts(` to `export function buildSportsDiscoveryPorts(`. In both `ai.generateJson` inline input types add the two fields:

```ts
        input: {
          schema: Record<string, unknown>;
          prompt: string;
          maxOutputTokens?: number;
          sorting?: true;
          signal?: AbortSignal;
        }
```

The existing `{ service: "module.news", ...input }` and `{ service: "module.sports", ...input }` spreads already carry both fields to `generateStructured`; do not change them.

- [ ] **Step 5: Write the registry pass-through test**

Create `tests/unit/module-registry-sorting-ports.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import type { DataContextDb } from "@moss/db";
import type * as AiModule from "@moss/ai";

const captured = vi.hoisted(() => ({ calls: [] as Record<string, unknown>[] }));

vi.mock("@moss/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof AiModule>();
  return {
    ...actual,
    createAiSecretCipher: () => ({ decryptJson: vi.fn() }),
    generateStructured: vi.fn(async (_db: unknown, input: Record<string, unknown>) => {
      captured.calls.push(input);
      return {
        ok: true,
        object: {},
        usage: { inputTokens: 0, outputTokens: 0 },
        servedBy: "sorting"
      };
    })
  };
});

import {
  buildNewsDiscoveryPorts,
  buildSportsDiscoveryPorts
} from "../../packages/module-registry/src/index.js";

const scopedDb = {} as DataContextDb;
const schema = { type: "object" };

describe("story matcher ports pass the sorting opt-in through (#2594)", () => {
  it.each([
    ["module.news", () => buildNewsDiscoveryPorts()],
    ["module.sports", () => buildSportsDiscoveryPorts()]
  ] as const)("%s forwards sorting, signal, schema and prompt", async (service, build) => {
    captured.calls.length = 0;
    const controller = new AbortController();
    const result = await build().ai.generateJson(scopedDb, {
      schema,
      prompt: "match these",
      maxOutputTokens: 4000,
      sorting: true,
      signal: controller.signal
    });
    expect(result).toMatchObject({ ok: true, servedBy: "sorting" });
    expect(captured.calls).toEqual([
      {
        service,
        schema,
        prompt: "match these",
        maxOutputTokens: 4000,
        sorting: true,
        signal: controller.signal
      }
    ]);
  });
});

describe("external module requests cannot opt in (#2594 slice 4 owns that)", () => {
  it("the worker RPC request allow-list does not admit sorting", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(
        new URL("../../packages/module-registry/src/external/worker-rpc-host.ts", import.meta.url),
        "utf8"
      )
    );
    const allowList = /const allowed = new Set\(\[([^\]]*)\]\)/.exec(source)?.[1] ?? "";
    expect(allowList).toContain('"prompt"');
    expect(allowList).not.toContain("sorting");
  });
});
```

If `AiRepository`'s constructor needs anything at build time in this test, add `AiRepository: class {}` to the mock return. If `buildNewsDiscoveryPorts()` requires arguments beyond the optional ones, pass `undefined` for each.

- [ ] **Step 6: Run the tests**

Run: `pnpm test:unit tests/unit/story-relevance-evaluator.test.ts tests/unit/module-registry-sorting-ports.test.ts tests/unit/story-relevance-contract.test.ts` - PASS.

- [ ] **Step 7: Typecheck and lint**

Run: `pnpm typecheck` - PASS.
Run: `pnpm exec eslint packages/usefulness-feedback/src/relevance/evaluator.ts packages/usefulness-feedback/src/relevance/policy.ts packages/news/src/discovery/ports.ts packages/module-registry/src/index.ts tests/unit/story-relevance-evaluator.test.ts tests/unit/module-registry-sorting-ports.test.ts --max-warnings=0` - no output.

- [ ] **Step 8: Commit**

```bash
git add packages/usefulness-feedback/src/relevance/evaluator.ts packages/usefulness-feedback/src/relevance/policy.ts packages/news/src/discovery/ports.ts packages/module-registry/src/index.ts tests/unit/story-relevance-evaluator.test.ts tests/unit/module-registry-sorting-ports.test.ts
git commit -m "feat(news,sports): story matcher opts into the sorting model (#2594)"
```

---

### Task 5: Settings row to pick the sorting model

Use the `design-system` skill before starting this task.

**Files:**

- Modify: `apps/web/src/api/client.ts:1346` (add `deleteAiServiceBinding` after `putAiServiceBinding`)
- Create: `apps/web/src/settings/settings-ai-sorting-row.tsx`
- Modify: `apps/web/src/settings/settings-ai-admin-pane.tsx:39-51` (import), `:877-887` (render)
- Modify: `tests/unit/settings-ai-admin-pane.test.tsx:26-71` (mock gains `deleteAiServiceBinding`)
- Test: `tests/unit/settings-ai-sorting-row.test.tsx` (new)

**Interfaces:**

- Consumes: `GET/PUT/DELETE` sorting routes (Task 1), `SORTING_SERVICE_KEY`, `isSortingProviderKind` (Task 1).
- Produces: `deleteAiServiceBinding(service: AiServiceKey): Promise<{ service: string }>`; `SortingModelRow(props: { binding: AiServiceBinding | undefined; models: readonly AiConfiguredModelDto[]; providers: readonly AiProviderConfigDto[] })`; exported copy constant `SORTING_DISCLOSURE`.

- [ ] **Step 1: Write the failing row tests**

Create `tests/unit/settings-ai-sorting-row.test.tsx`:

```tsx
// @vitest-environment jsdom
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const putAiServiceBinding = vi.fn(async (_service: string, input: unknown) => ({
  service: "sorting",
  binding: (input as { binding: unknown }).binding
}));
const deleteAiServiceBinding = vi.fn(async (service: string) => ({ service }));

vi.mock("../../apps/web/src/api/client.js", () => ({
  putAiServiceBinding: (service: string, input: unknown) => putAiServiceBinding(service, input),
  deleteAiServiceBinding: (service: string) => deleteAiServiceBinding(service)
}));

import {
  SORTING_DISCLOSURE,
  SortingModelRow
} from "../../apps/web/src/settings/settings-ai-sorting-row.js";
import { FeedbackProvider } from "../../apps/web/src/settings/settings-feedback.js";

const provider = (id: string, displayName: string, providerKind: string) => ({
  id,
  displayName,
  providerKind,
  authMethod: "api_key",
  executionMode: "interactive",
  status: "active",
  hasCredential: true,
  isInstanceDefault: false
});
const model = (
  id: string,
  providerConfigId: string,
  providerKind: string,
  providerDisplayName: string,
  capabilities: string[]
) => ({
  id,
  providerConfigId,
  providerKind,
  providerDisplayName,
  providerStatus: "active",
  providerModelId: id,
  displayName: id,
  capabilities,
  status: "active",
  tier: "economy",
  allowUserOverride: false,
  origin: "manual",
  createdAt: "2026-09-22T00:00:00.000Z",
  updatedAt: "2026-09-22T00:00:00.000Z"
});

const providers = [
  provider("p-local", "Local box", "openai-compatible"),
  provider("p-cloud", "Cloud", "anthropic"),
  provider("p-ollama", "Ollama", "ollama")
];
const models = [
  model("small-json", "p-local", "openai-compatible", "Local box", ["json"]),
  model("cloud-json", "p-cloud", "anthropic", "Cloud", ["chat", "json"]),
  model("cloud-chat", "p-cloud", "anthropic", "Cloud", ["chat"]),
  model("ollama-json", "p-ollama", "ollama", "Ollama", ["json"])
];

async function render(binding?: unknown): Promise<ReactTestRenderer> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          FeedbackProvider,
          null,
          createElement(SortingModelRow, {
            binding: binding as never,
            models: models as never,
            providers: providers as never
          })
        )
      )
    );
  });
  return renderer;
}

const select = (renderer: ReactTestRenderer) => renderer.root.findByType("select");
const text = (renderer: ReactTestRenderer) => JSON.stringify(renderer.toJSON());

describe("SortingModelRow", () => {
  beforeEach(() => {
    putAiServiceBinding.mockClear();
    deleteAiServiceBinding.mockClear();
  });

  it("offers Use main model plus only eligible models, grouped by provider", async () => {
    const renderer = await render();
    expect(select(renderer).props.value).toBe("");
    const groups = renderer.root.findAllByType("optgroup").map((group) => group.props.label);
    expect(groups).toEqual(["Local box", "Cloud"]);
    const values = renderer.root.findAllByType("option").map((option) => option.props.value);
    expect(values).toEqual(["", "model:small-json", "model:cloud-json"]);
    expect(text(renderer)).toContain("Sorting model");
    expect(text(renderer)).toContain("Use main model");
    expect(text(renderer)).not.toContain(SORTING_DISCLOSURE);
  });

  it("selecting a model saves a model binding", async () => {
    const renderer = await render();
    await act(async () => {
      select(renderer).props.onChange({ target: { value: "model:small-json" } });
    });
    expect(putAiServiceBinding).toHaveBeenCalledWith("sorting", {
      binding: { kind: "model", modelId: "small-json" }
    });
  });

  it("choosing Use main model clears the binding", async () => {
    const renderer = await render({ kind: "model", modelId: "small-json" });
    await act(async () => {
      select(renderer).props.onChange({ target: { value: "" } });
    });
    expect(deleteAiServiceBinding).toHaveBeenCalledWith("sorting");
    expect(putAiServiceBinding).not.toHaveBeenCalled();
  });

  it("shows the third-party line whenever a sorting model is chosen", async () => {
    const renderer = await render({ kind: "model", modelId: "small-json" });
    expect(select(renderer).props.value).toBe("model:small-json");
    expect(text(renderer)).toContain(SORTING_DISCLOSURE);
  });

  it("shows the unavailable note when the bound model no longer qualifies", async () => {
    const renderer = await render({ kind: "model", modelId: "ollama-json" });
    expect(select(renderer).props.value).toBe("");
    expect(text(renderer)).toContain("Chosen model is unavailable. Using your main model.");
  });
});
```

The disclosure string is `SORTING_DISCLOSURE` from the component, whose value is fixed in Global Constraints.

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm test:unit tests/unit/settings-ai-sorting-row.test.tsx`
Expected: FAIL, cannot resolve `settings-ai-sorting-row`.

- [ ] **Step 3: Add the client function**

In `apps/web/src/api/client.ts`, after `putAiServiceBinding`:

```ts
export async function deleteAiServiceBinding(service: AiServiceKey): Promise<{ service: string }> {
  return requestJson<{ service: string }>(
    `/api/ai/services/${encodeURIComponent(service)}/binding`,
    { method: "DELETE" }
  );
}
```

- [ ] **Step 4: Create the row**

Create `apps/web/src/settings/settings-ai-sorting-row.tsx`:

```tsx
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { GitCommitHorizontal, MinusCircle } from "lucide-react";

import {
  SORTING_SERVICE_KEY,
  isSortingProviderKind,
  type AiConfiguredModelDto,
  type AiProviderConfigDto,
  type AiServiceBinding
} from "@moss/shared";

import { deleteAiServiceBinding, putAiServiceBinding } from "../api/client";
import { queryKeys } from "../api/query-keys";
import { useFeedback } from "./settings-feedback";
import { readError } from "./settings-types";
import { Select } from "./settings-ui";

export const SORTING_DISCLOSURE =
  "Story details and your saved story preferences go to this model first, and to your main " +
  "model if it does not answer. Each may charge for the request.";

// Models the sorting path can run: active, ready provider, json, structured-capable kind.
function eligibleSortingModels(
  models: readonly AiConfiguredModelDto[],
  providers: readonly AiProviderConfigDto[]
): AiConfiguredModelDto[] {
  return models.filter((model) => {
    const provider = providers.find((candidate) => candidate.id === model.providerConfigId);
    const providerReady =
      provider?.status === "active" &&
      (provider.authMethod === "cli" ? provider.cliAvailable : provider.hasCredential);
    return (
      model.status === "active" &&
      model.providerStatus === "active" &&
      providerReady &&
      isSortingProviderKind(model.providerKind) &&
      model.capabilities.includes("json")
    );
  });
}

export function SortingModelRow(props: {
  readonly binding: AiServiceBinding | undefined;
  readonly models: readonly AiConfiguredModelDto[];
  readonly providers: readonly AiProviderConfigDto[];
}) {
  const { toast } = useFeedback();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (modelId: string | null) =>
      modelId
        ? putAiServiceBinding(SORTING_SERVICE_KEY, { binding: { kind: "model", modelId } })
        : deleteAiServiceBinding(SORTING_SERVICE_KEY),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.ai.serviceBindings });
      toast("Service updated", { icon: <GitCommitHorizontal size={17} /> });
    },
    onError: (error) => toast(readError(error), { tone: "drift" })
  });

  const eligible = eligibleSortingModels(props.models, props.providers);
  const boundId = props.binding?.kind === "model" ? props.binding.modelId : null;
  const bound = boundId ? (eligible.find((model) => model.id === boundId) ?? null) : null;
  const groups = new Map<string, AiConfiguredModelDto[]>();
  for (const model of eligible) {
    const list = groups.get(model.providerDisplayName) ?? [];
    list.push(model);
    groups.set(model.providerDisplayName, list);
  }

  return (
    <div className="rt">
      <div className="rt__main">
        <div className="rt__name">Sorting model</div>
        <div className="rt__desc">
          A small, fast model for sorting, filtering and picking out details. Leave empty to use
          your main model.
        </div>
        {bound ? <div className="rt__desc">{SORTING_DISCLOSURE}</div> : null}
      </div>
      <div className="rt__pick">
        <Select
          value={bound ? `model:${bound.id}` : ""}
          aria-label="Binding for Sorting model"
          disabled={mutation.isPending}
          onChange={(event) => {
            const raw = event.target.value;
            mutation.mutate(raw.startsWith("model:") ? raw.slice("model:".length) : null);
          }}
        >
          <option value="">Use main model</option>
          {[...groups].map(([providerName, list]) => (
            <optgroup key={providerName} label={providerName}>
              {list.map((model) => (
                <option key={model.id} value={`model:${model.id}`}>
                  {model.displayName}
                </option>
              ))}
            </optgroup>
          ))}
        </Select>
        {boundId && !bound ? (
          <span className="rt__none">
            <MinusCircle size={13} aria-hidden="true" />
            Chosen model is unavailable. Using your main model.
          </span>
        ) : null}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Render it in the Services group**

In `apps/web/src/settings/settings-ai-admin-pane.tsx`, add the import next to the other settings imports:

```ts
import { SortingModelRow } from "./settings-ai-sorting-row";
```

and after the `SERVICE_ROWS.map(...)` block inside `<Group title="Services" ...>`:

```tsx
<SortingModelRow
  binding={serviceBindingsQuery.data?.bindings.sorting}
  models={models}
  providers={providers}
/>
```

In `tests/unit/settings-ai-admin-pane.test.tsx`, add `deleteAiServiceBinding: vi.fn(),` to the `vi.mock("../../apps/web/src/api/client.js", ...)` object next to `putAiServiceBinding`.

Add one case to `tests/unit/settings-ai-admin-pane.test.tsx` that proves the row is mounted:

```ts
describe("AiProvidersPane services group (#2594)", () => {
  it("shows the Sorting model row under the per-job rows", async () => {
    const client = await import("../../apps/web/src/api/client.js");
    vi.mocked(client.listAiProviders).mockResolvedValueOnce({
      providers: [
        {
          id: "p1",
          providerKind: "openai-compatible",
          displayName: "Local box",
          authMethod: "api_key",
          executionMode: "interactive",
          status: "active",
          hasCredential: true,
          isInstanceDefault: true
        }
      ]
    } as never);
    const renderer = await renderPane();
    const text = JSON.stringify(renderer.toJSON());
    expect(text.indexOf("Email extraction")).toBeGreaterThan(-1);
    expect(text.indexOf("Sorting model")).toBeGreaterThan(text.indexOf("Email extraction"));
  });
});
```

- [ ] **Step 6: Run the tests**

Run: `pnpm test:unit tests/unit/settings-ai-sorting-row.test.tsx tests/unit/settings-ai-admin-pane.test.tsx` - PASS.

- [ ] **Step 7: Design-system audit, typecheck, lint**

Run the invented-class audit from the `design-system` skill against the touched files:

```bash
grep -rhoE "jds-[a-zA-Z0-9_-]+" apps/web/src/settings/settings-ai-sorting-row.tsx apps/web/src/settings/settings-ai-admin-pane.tsx | sort -u > /tmp/used.txt
grep -rhoE "\.jds-[a-zA-Z0-9_-]+" apps/web/src/styles/ | sed 's/^\.//' | sort -u > /tmp/defined.txt
comm -23 /tmp/used.txt /tmp/defined.txt
grep -ohE 'className="[^"]+"' apps/web/src/settings/settings-ai-sorting-row.tsx | sort -u
```

Expected: the `comm` prints nothing; the last command prints only `rt`, `rt__main`, `rt__name`, `rt__desc`, `rt__pick`, `rt__none`, all defined in `apps/web/src/styles/settings-panes-2.css:415-465`.

Run: `pnpm check:ui-classes` - PASS.
Run: `pnpm typecheck` - PASS.
Run: `pnpm exec eslint apps/web/src/api/client.ts apps/web/src/settings/settings-ai-sorting-row.tsx apps/web/src/settings/settings-ai-admin-pane.tsx tests/unit/settings-ai-sorting-row.test.tsx tests/unit/settings-ai-admin-pane.test.tsx --max-warnings=0` - no output.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/api/client.ts apps/web/src/settings/settings-ai-sorting-row.tsx apps/web/src/settings/settings-ai-admin-pane.tsx tests/unit/settings-ai-sorting-row.test.tsx tests/unit/settings-ai-admin-pane.test.tsx
git commit -m "feat(web): Sorting model row under Settings > AI services (#2594)"
```

---

### Task 6: Keep Moss's app map truthful

**Files:**

- Modify: `packages/ai/src/manifest.ts:113` (new entry at the end of `features`)
- Modify: `packages/shared/src/app-map-core.ts:201-236` (`aiproviders` description)
- Test: `tests/unit/ai-manifest-sorting-model.test.ts` (new)

**Interfaces:**

- Consumes: the row copy from Task 5.
- Produces: feature `ai.sorting_model`, error `ai.sorting_model.not_answering`, remediation `ai.sorting_model.use_main_model`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/ai-manifest-sorting-model.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { aiModuleManifest } from "../../packages/ai/src/manifest.js";
import { CORE_SETTINGS } from "../../packages/shared/src/app-map-core.js";

describe("app map: sorting model (#2594)", () => {
  const feature = (aiModuleManifest.features ?? []).find(
    (entry) => entry.id === "ai.sorting_model"
  );

  it("declares the sorting model feature with its error and remediation", () => {
    expect(feature?.description).toMatch(/Sorting model/);
    expect(feature?.remediations).toEqual([
      {
        id: "ai.sorting_model.use_main_model",
        description:
          "Moss tries your main model instead when it can. To stop trying the sorting model, choose Use main model.",
        path: "/settings?section=aiproviders"
      }
    ]);
    expect(feature?.errors).toEqual([
      expect.objectContaining({
        code: "ai.sorting_model.not_answering",
        class: "transient",
        remediationRef: "ai.sorting_model.use_main_model"
      })
    ]);
    expect(feature?.errors?.[0]?.description).toMatch(/sorting model not answering/);
  });

  it("describes the row on the Assistant & AI settings page", () => {
    const page = CORE_SETTINGS.find((entry) => entry.id === "aiproviders");
    expect(page?.description).toMatch(/Sorting model/);
    expect(page?.description).toMatch(/Use main model/);
  });
});
```

Before running, check the export name of the core settings array: `grep -n "^export const" packages/shared/src/app-map-core.ts`. If it is not `CORE_SETTINGS`, use the real name in the import and the `find` call.

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm test:unit tests/unit/ai-manifest-sorting-model.test.ts`
Expected: FAIL, `feature` is undefined.

- [ ] **Step 3: Add the manifest feature**

Append to `features` in `packages/ai/src/manifest.ts`:

```ts
    {
      id: "ai.sorting_model",
      description:
        "Sorting model: an optional row under Services on Settings > Assistant & AI. An admin " +
        "picks a small, fast model for sorting, filtering and picking out details, or Use main " +
        "model to leave it empty. The News and Sports story matcher tries it first and falls " +
        "back to the main model if it does not answer. Only active JSON-capable models on " +
        "Anthropic, OpenAI-compatible or Google providers are offered. An admin model pin, or a " +
        "News or Sports specific binding, bypasses it.",
      remediations: [
        {
          id: "ai.sorting_model.use_main_model",
          description:
            "Moss tries your main model instead when it can. To stop trying the sorting model, choose Use main model.",
          path: "/settings?section=aiproviders"
        }
      ],
      errors: [
        {
          code: "ai.sorting_model.not_answering",
          class: "transient",
          remediationRef: "ai.sorting_model.use_main_model",
          description:
            "sorting model not answering: the chosen sorting model failed, timed out after 10 " +
            "seconds, or gave an unusable answer. It is logged, not shown; the main model answers " +
            "instead."
        }
      ]
    }
```

- [ ] **Step 4: Add the settings page sentence**

In `packages/shared/src/app-map-core.ts`, in the `aiproviders` description, insert before `"A separate Web search group ..."`:

```ts
      "The Services group ends with a Sorting model row: a dropdown with Use main model and " +
      "every active JSON-capable model, grouped by provider. Once a model is chosen, a line " +
      "under the row says story details and saved story preferences go to that model first and " +
      "to the main model if it does not answer. " +
```

- [ ] **Step 5: Run the test and build the map**

Run: `pnpm test:unit tests/unit/ai-manifest-sorting-model.test.ts tests/unit/app-map-contract.test.ts tests/unit/app-map-build.test.ts` - PASS.
Run: `pnpm build:app-map` - exits 0 (writes the ignored `dist/app-map.json`).

- [ ] **Step 6: Typecheck and lint**

Run: `pnpm typecheck` - PASS.
Run: `pnpm exec eslint packages/ai/src/manifest.ts packages/shared/src/app-map-core.ts tests/unit/ai-manifest-sorting-model.test.ts --max-warnings=0` - no output.

- [ ] **Step 7: Commit**

```bash
git add packages/ai/src/manifest.ts packages/shared/src/app-map-core.ts tests/unit/ai-manifest-sorting-model.test.ts
git commit -m "docs(app-map): declare the sorting model setting, error and remedy (#2594)"
```

---

### Task 7: Full gate, live proof on dev, and the pull request

**Files:**

- No source changes expected. Evidence goes on the PR.

**Interfaces:**

- Consumes: everything above.

- [ ] **Step 1: Run the full gate**

Use the `verify-gate` skill: `scripts/run-gate.sh start`, then `scripts/run-gate.sh wait --follow` with `run_in_background`. Expected: exit code 0. Known unrelated flakes are listed in project memory (gateway worker pattern timeout, browser tests under load); rerun only the failed file:line targets, never bisect this branch over them.

- [ ] **Step 2: Bring up the dev instance from this worktree**

Confirm nothing else is serving `:3000` or `:5173` first (`ss -ltnp` filtered with `grep -e ':3000 ' -e ':5173 '`). If another session owns them, stop and ask the coordinator rather than killing their processes. Otherwise run `pnpm dev:api` and `pnpm dev:web` from `~/Jarv1s-wt/sorting-model`. Web: `http://192.168.50.36:5173`, API `:3000`. **Never `:1533` (production).** Sign in as the dev admin from project memory.

- [ ] **Step 3: Add a small JSON-capable model as the sorting model**

In Settings > Assistant & AI, add a provider of kind **OpenAI-compatible** pointing at a small local or hosted model that answers JSON (for example a small Ollama model through `http://<host>:11434/v1`). Add the model with the `json` capability. In Services, pick it in the Sorting model row. Screenshot the row showing the model and the disclosure line (crop to the row; save to disk, do not pull a full page into context).

- [ ] **Step 4: Prove the story matcher uses it**

In News, mark a story "less like this". Trigger a News refresh. In the API log, find the `ai.structured usage` line with `"service":"module.news"` and `"servedBy":"sorting"`, and confirm the story is hidden in the feed. Record the log line (metadata only) and a cropped screenshot.

- [ ] **Step 5: Prove the fallback**

Disable the sorting model's provider in Settings. Confirm the row shows "Chosen model is unavailable. Using your main model." Trigger another News refresh. Find `ai.structured usage` with `"servedBy":"main"` for `module.news`, and confirm the rule still hides the story. Then re-enable the provider, point it at a dead port so every request is refused, refresh again, and find `ai.structured sorting fallback` with `"sortingFailure":"provider_error"`, followed by a `servedBy: "main"` usage line.

- [ ] **Step 6: Clean up dev state**

Choose Use main model in the row, remove the test provider, and stop the `dev:api` / `dev:web` processes this task started.

- [ ] **Step 7: Open the pull request**

Push the branch and open the PR with `gh pr create`. The body must include the live-proof evidence from Steps 3-5 and this Release note section:

```markdown
## Release note

Category: Added
Title: Sorting model
Description: Pick a small, fast model to sort and filter your news and sports stories. If it does not answer, Moss tries your main model instead.
```

If the body needs editing afterwards, patch it through the REST API (`gh api -X PATCH repos/{owner}/{repo}/pulls/<n> -f body=...`), because `gh pr edit` fails on this repo.

- [ ] **Step 8: Report**

Report in plain English (see the rule at the top of this plan): whether the gate passed, whether the story was hidden by the sorting model, and whether the fallback worked, with the PR link.
