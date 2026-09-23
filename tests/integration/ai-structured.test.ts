import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";

import {
  AiRepository,
  createAiSecretCipher,
  generateStructured,
  type GenerateStructuredProviderInput
} from "@moss/ai";
import { DataContextRunner, createDatabase, type AccessContext, type MossDatabase } from "@moss/db";

import { createApiServer } from "../../apps/api/src/server.js";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

// #915 slice 3: module service bindings, service-aware resolution, and generateStructured.
// Suites are STATEFUL and order-dependent (shared instance_settings blob + seeded models) —
// every test restores the bindings it writes.

let appDb: Kysely<MossDatabase>;
let dataContext: DataContextRunner;
let repository: AiRepository;
let server: Awaited<ReturnType<typeof createApiServer>>;
let boss: PgBoss;
let previousSecretKey: string | undefined;
let realFetch: typeof globalThis.fetch;

let providerId: string;
let modelEconomyJsonId: string;
let modelReasoningJsonId: string;
let modelChatJsonId: string;
let ollamaJsonModelId: string;

function adminContext(): AccessContext {
  return { actorUserId: ids.adminUser, requestId: "request:ai-structured-test" };
}

async function seedProvider(displayName: string): Promise<string> {
  const response = await server.inject({
    method: "POST",
    url: "/api/ai/providers",
    headers: { authorization: `Bearer ${ids.sessionAdmin}` },
    payload: {
      providerKind: "anthropic",
      displayName,
      credentialPayload: { apiKey: "structured-test-secret" }
    }
  });
  expect(response.statusCode).toBe(201);
  return response.json().provider.id as string;
}

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

async function seedModel(
  providerConfigId: string,
  providerModelId: string,
  capabilities: readonly string[],
  tier: string
): Promise<string> {
  const response = await server.inject({
    method: "POST",
    url: "/api/ai/models",
    headers: { authorization: `Bearer ${ids.sessionAdmin}` },
    payload: { providerConfigId, providerModelId, displayName: providerModelId, capabilities, tier }
  });
  expect(response.statusCode).toBe(201);
  return response.json().model.id as string;
}

beforeAll(async () => {
  previousSecretKey = process.env.JARVIS_AI_SECRET_KEY;
  process.env.JARVIS_AI_SECRET_KEY = "test-ai-service-bindings-secret";

  realFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("network disabled in ai-structured tests");
  }) as typeof globalThis.fetch;

  await resetFoundationDatabase();
  appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
  dataContext = new DataContextRunner(appDb);
  repository = new AiRepository();
  // #1124: createApiServer()'s default boss falls back to pg-boss's own 10s
  // connectionTimeoutMillis, which a loaded CI runner's PG connection establishment can
  // exceed even when the connection ultimately succeeds. Pass an explicit, longer-but-still-
  // under-hookTimeout override so a slow-but-healthy CI connection isn't killed prematurely.
  // Test-only — production callers of createApiServer() are unaffected.
  boss = createPgBossClient(connectionStrings.app, { connectionTimeoutMillis: 25_000 });
  server = createApiServer({ appDb, boss, logger: false });
  await server.ready();

  providerId = await seedProvider("Structured Test Provider");
  const defaultResponse = await server.inject({
    method: "PUT",
    url: `/api/ai/providers/${providerId}/default`,
    headers: { authorization: `Bearer ${ids.sessionAdmin}` }
  });
  expect(defaultResponse.statusCode).toBe(200);

  // Seed the non-qualifying ollama provider BEFORE the anthropic models: automatic module.*
  // resolution breaks an economy-tier tie by newest created_at, so creating this provider's model
  // last would hijack the existing "json-economy" expectations further down this file.
  const ollamaProviderId = await seedProviderOfKind(
    "ollama",
    "Local Ollama",
    "http://127.0.0.1:11434"
  );
  ollamaJsonModelId = await seedModel(ollamaProviderId, "ollama-json", ["json"], "economy");

  modelEconomyJsonId = await seedModel(providerId, "json-economy", ["json"], "economy");
  modelReasoningJsonId = await seedModel(providerId, "json-reasoning", ["json"], "reasoning");
  modelChatJsonId = await seedModel(providerId, "chat-json", ["chat", "json"], "interactive");
});

afterAll(async () => {
  await Promise.allSettled([server?.close(), appDb?.destroy(), boss?.stop({ graceful: false })]);
  globalThis.fetch = realFetch;
  if (previousSecretKey === undefined) delete process.env.JARVIS_AI_SECRET_KEY;
  else process.env.JARVIS_AI_SECRET_KEY = previousSecretKey;
});

describe("module service binding CRUD (repository)", () => {
  it("stores, lists, gets, and deletes module bindings without touching the chat binding", async () => {
    await dataContext.withDataContext(adminContext(), async (scopedDb) => {
      await repository.setServiceBinding(
        scopedDb,
        "chat",
        { kind: "mode", tier: "interactive" },
        ids.adminUser
      );
      await repository.setServiceBinding(
        scopedDb,
        "module.worker",
        { kind: "mode", tier: "economy" },
        ids.adminUser
      );
      await repository.setServiceBinding(
        scopedDb,
        "module.demo-module",
        { kind: "model", modelId: modelEconomyJsonId },
        ids.adminUser
      );

      expect(await repository.listModuleServiceBindings(scopedDb)).toEqual({
        "module.worker": { kind: "mode", tier: "economy" },
        "module.demo-module": { kind: "model", modelId: modelEconomyJsonId }
      });
      expect(await repository.getModuleServiceBinding(scopedDb, "module.worker")).toEqual({
        kind: "mode",
        tier: "economy"
      });
      expect(await repository.getServiceBinding(scopedDb, "chat")).toEqual({
        kind: "mode",
        tier: "interactive"
      });

      await repository.deleteModuleServiceBinding(scopedDb, "module.demo-module", ids.adminUser);
      expect(await repository.getModuleServiceBinding(scopedDb, "module.demo-module")).toBeNull();
      expect(await repository.getServiceBinding(scopedDb, "chat")).toEqual({
        kind: "mode",
        tier: "interactive"
      });

      await repository.deleteModuleServiceBinding(scopedDb, "module.worker", ids.adminUser);
    });
  });

  it("still rejects non-bindable worker capabilities", async () => {
    await dataContext.withDataContext(adminContext(), async (scopedDb) => {
      await expect(
        repository.setServiceBinding(
          scopedDb,
          "json" as never,
          { kind: "mode", tier: "economy" },
          ids.adminUser
        )
      ).rejects.toThrow(/not bindable/);
    });
  });
});

describe("resolveModelForService precedence", () => {
  const resolve = (service: `module.${string}`) =>
    dataContext.withDataContext(adminContext(), (scopedDb) =>
      repository.resolveModelForService(scopedDb, service, { capability: "json" })
    );

  it("unbound service resolves exactly like an automatic worker capability", async () => {
    const route = await resolve("module.demo-module");
    expect(route.reason).toBe("matched-active-model");
    expect(route.model?.id).toBe(modelEconomyJsonId);
  });

  it("module.worker mode binding overrides the tier for every module", async () => {
    await dataContext.withDataContext(adminContext(), (scopedDb) =>
      repository.setServiceBinding(
        scopedDb,
        "module.worker",
        { kind: "mode", tier: "reasoning" },
        ids.adminUser
      )
    );
    const route = await resolve("module.demo-module");
    expect(route.reason).toBe("matched-active-model");
    expect(route.model?.id).toBe(modelReasoningJsonId);
  });

  it("a module-specific model binding beats module.worker; other modules keep riding it", async () => {
    await dataContext.withDataContext(adminContext(), (scopedDb) =>
      repository.setServiceBinding(
        scopedDb,
        "module.demo-module",
        { kind: "model", modelId: modelChatJsonId },
        ids.adminUser
      )
    );
    const specific = await resolve("module.demo-module");
    expect(specific.reason).toBe("manual-route");
    expect(specific.model?.id).toBe(modelChatJsonId);

    const other = await resolve("module.other");
    expect(other.model?.id).toBe(modelReasoningJsonId);
  });

  it("an unresolved model binding falls through to the provider default (#1083 F2)", async () => {
    const disable = await server.inject({
      method: "PATCH",
      url: `/api/ai/models/${modelChatJsonId}`,
      headers: { authorization: `Bearer ${ids.sessionAdmin}` },
      payload: { status: "disabled" }
    });
    expect(disable.statusCode).toBe(200);

    const route = await resolve("module.demo-module");
    // #1083 F2: service bindings are UUIDs in a blob with no FK. Disabled/deleted rows must degrade
    // to the configured provider's capable default instead of breaking structured module work.
    expect(route.reason).toBe("matched-active-model");
    expect(route.model?.id).toBe(modelEconomyJsonId);

    const enable = await server.inject({
      method: "PATCH",
      url: `/api/ai/models/${modelChatJsonId}`,
      headers: { authorization: `Bearer ${ids.sessionAdmin}` },
      payload: { status: "active" }
    });
    expect(enable.statusCode).toBe(200);
  });

  it("an admin model pin beats every module binding; cleanup restores automatic", async () => {
    await dataContext.withDataContext(adminContext(), async (scopedDb) => {
      await repository.setServiceBinding(
        scopedDb,
        "module.demo-module",
        { kind: "model", modelId: modelEconomyJsonId },
        ids.adminUser
      );
      await repository.setAdminPinnedModel(scopedDb, modelChatJsonId);
    });

    const pinned = await resolve("module.demo-module");
    expect(pinned.model?.id).toBe(modelChatJsonId);

    await dataContext.withDataContext(adminContext(), async (scopedDb) => {
      await repository.setAdminPinnedModel(scopedDb, null);
      await repository.deleteModuleServiceBinding(scopedDb, "module.demo-module", ids.adminUser);
      await repository.deleteModuleServiceBinding(scopedDb, "module.worker", ids.adminUser);
    });
    const restored = await resolve("module.demo-module");
    expect(restored.model?.id).toBe(modelEconomyJsonId);
  });
});

describe("module service binding routes", () => {
  const auth = { authorization: `Bearer ${ids.sessionAdmin}` };

  it("PUT + GET round-trip a module.worker binding (fjs must not strip module keys)", async () => {
    const put = await server.inject({
      method: "PUT",
      url: "/api/ai/services/module.worker/binding",
      headers: auth,
      payload: { binding: { kind: "mode", tier: "economy" } }
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({
      service: "module.worker",
      binding: { kind: "mode", tier: "economy" }
    });

    const list = await server.inject({
      method: "GET",
      url: "/api/ai/service-bindings",
      headers: auth
    });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().bindings["module.worker"]).toEqual({ kind: "mode", tier: "economy" });
  });

  it("rejects a module-specific binding for a module that is not installed", async () => {
    const put = await server.inject({
      method: "PUT",
      url: "/api/ai/services/module.definitely-not-installed/binding",
      headers: auth,
      payload: { binding: { kind: "mode", tier: "economy" } }
    });
    expect(put.statusCode).toBe(400);
    expect(put.json().message ?? put.json().error).toMatch(/installed module/);
  });

  it("accepts a module-specific binding for an installed module", async () => {
    const put = await server.inject({
      method: "PUT",
      url: "/api/ai/services/module.ai/binding",
      headers: auth,
      payload: { binding: { kind: "mode", tier: "economy" } }
    });
    expect(put.statusCode).toBe(200);

    const del = await server.inject({
      method: "DELETE",
      url: "/api/ai/services/module.ai/binding",
      headers: auth
    });
    expect(del.statusCode).toBe(200);
  });

  it("accepts a namespaced service owned by an installed module", async () => {
    const put = await server.inject({
      method: "PUT",
      url: "/api/ai/services/module.connectors.email-extract/binding",
      headers: auth,
      payload: { binding: { kind: "model", modelId: modelEconomyJsonId } }
    });
    expect(put.statusCode, put.body).toBe(200);

    const list = await server.inject({
      method: "GET",
      url: "/api/ai/service-bindings",
      headers: auth
    });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().bindings["module.connectors.email-extract"]).toEqual({
      kind: "model",
      modelId: modelEconomyJsonId
    });

    const del = await server.inject({
      method: "DELETE",
      url: "/api/ai/services/module.connectors.email-extract/binding",
      headers: auth
    });
    expect(del.statusCode).toBe(200);
  });

  it("rejects a model binding whose model lacks the json capability", async () => {
    const chatOnlyModelId = await seedModel(providerId, "chat-only", ["chat"], "interactive");
    const put = await server.inject({
      method: "PUT",
      url: "/api/ai/services/module.worker/binding",
      headers: auth,
      payload: { binding: { kind: "model", modelId: chatOnlyModelId } }
    });
    expect(put.statusCode).toBe(400);

    const chatPut = await server.inject({
      method: "PUT",
      url: "/api/ai/services/chat/binding",
      headers: auth,
      payload: { binding: { kind: "model", modelId: chatOnlyModelId } }
    });
    expect(chatPut.statusCode).toBe(200);
  });

  it("DELETE unbinds module keys only", async () => {
    const del = await server.inject({
      method: "DELETE",
      url: "/api/ai/services/module.worker/binding",
      headers: auth
    });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ service: "module.worker" });

    const list = await server.inject({
      method: "GET",
      url: "/api/ai/service-bindings",
      headers: auth
    });
    expect(list.json().bindings["module.worker"]).toBeUndefined();

    const chatDel = await server.inject({
      method: "DELETE",
      url: "/api/ai/services/chat/binding",
      headers: auth
    });
    expect(chatDel.statusCode).toBe(400);
  });

  it("requires auth and instance-admin", async () => {
    const anon = await server.inject({
      method: "PUT",
      url: "/api/ai/services/module.worker/binding",
      payload: { binding: { kind: "mode", tier: "economy" } }
    });
    expect(anon.statusCode).toBe(401);

    const nonAdmin = await server.inject({
      method: "PUT",
      url: "/api/ai/services/module.worker/binding",
      headers: { authorization: `Bearer ${ids.sessionA}` },
      payload: { binding: { kind: "mode", tier: "economy" } }
    });
    expect(nonAdmin.statusCode).toBe(403);
  });
});

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

describe("resolveSortingModel precedence", () => {
  const sortingFor = (service: `module.${string}`, requireExplicitBinding = false) =>
    dataContext.withDataContext(adminContext(), (scopedDb) =>
      repository.resolveSortingModel(scopedDb, service, { requireExplicitBinding })
    );
  const setSorting = (modelId: string) =>
    dataContext.withDataContext(adminContext(), (scopedDb) =>
      repository.setServiceBinding(scopedDb, "sorting", { kind: "model", modelId }, ids.adminUser)
    );

  // These tests share the instance's single settings row, so cleanup must run even when an
  // assertion throws — otherwise a failure leaks a binding or pin into every later suite.
  afterEach(async () => {
    await dataContext.withDataContext(adminContext(), async (scopedDb) => {
      await repository.setAdminPinnedModel(scopedDb, null);
      await repository.deleteModuleServiceBinding(scopedDb, "module.news", ids.adminUser);
      await repository.deleteModuleServiceBinding(scopedDb, "module.worker", ids.adminUser);
      await repository.deleteModuleServiceBinding(scopedDb, "sorting", ids.adminUser);
    });
  });

  it("returns null when no sorting binding exists", async () => {
    expect(await sortingFor("module.news")).toBeNull();
  });

  it("returns the sorting model when it is bound and qualifies", async () => {
    await setSorting(modelReasoningJsonId);
    expect((await sortingFor("module.news"))?.id).toBe(modelReasoningJsonId);
  });

  it("a strict job never reaches the sorting model", async () => {
    await setSorting(modelReasoningJsonId);
    expect(await sortingFor("module.news", true)).toBeNull();
  });

  it("an admin pin beats the sorting model", async () => {
    await setSorting(modelReasoningJsonId);
    await dataContext.withDataContext(adminContext(), (scopedDb) =>
      repository.setAdminPinnedModel(scopedDb, modelChatJsonId)
    );
    expect(await sortingFor("module.news")).toBeNull();
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
  });

  it("a model that no longer qualifies is ignored", async () => {
    // Bypass the route check to simulate a binding that went stale after saving.
    await setSorting(ollamaJsonModelId);
    expect(await sortingFor("module.news")).toBeNull();
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
  });
});

describe("generateStructured end-to-end", () => {
  it("resolves the service, decrypts the real credential, calls the adapter, validates", async () => {
    const captured: { apiKey?: string; input?: GenerateStructuredProviderInput } = {};
    const fakeAdapter = {
      generateStructured: async (input: GenerateStructuredProviderInput) => {
        captured.input = input;
        return {
          rawObject: { title: "Staff Engineer" },
          usage: { inputTokens: 11, outputTokens: 7 }
        };
      }
    };

    const result = await dataContext.withDataContext(adminContext(), (scopedDb) =>
      generateStructured(
        scopedDb,
        {
          service: "module.demo-module",
          prompt: "Extract the job title.",
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["title"],
            properties: { title: { type: "string" } }
          }
        },
        {
          repository,
          cipher: createAiSecretCipher(process.env),
          createAdapter: (kind, apiKey) => {
            captured.apiKey = apiKey;
            expect(kind).toBe("anthropic");
            return fakeAdapter;
          }
        }
      )
    );

    expect(result).toEqual({
      ok: true,
      object: { title: "Staff Engineer" },
      usage: { inputTokens: 11, outputTokens: 7 }
    });
    expect(captured.apiKey).toBe("structured-test-secret");
    expect(captured.input?.model.provider_model_id).toBe("json-economy");
    expect(captured.input?.messages).toEqual([{ role: "user", content: "Extract the job title." }]);
  });

  it("binds CLI json models and routes generation through the injected CLI adapter", async () => {
    const create = await server.inject({
      method: "POST",
      url: "/api/ai/providers",
      headers: { authorization: `Bearer ${ids.sessionAdmin}` },
      payload: {
        providerKind: "openai-compatible",
        displayName: "Codex CLI",
        authMethod: "cli"
      }
    });
    expect(create.statusCode).toBe(201);
    const cliProviderId = create.json().provider.id as string;
    // #2208: CLI providers no longer ship a static model list; with no cli-runner reachable the
    // create path adds only the sentinel. Add the json-capable model by hand, as an admin would.
    const cliModel = await dataContext.withDataContext(adminContext(), (db) =>
      repository.createModel(db, {
        providerConfigId: cliProviderId,
        providerModelId: "gpt-5.6-luna",
        displayName: "gpt-5.6-luna",
        capabilities: ["chat", "json"]
      })
    );
    expect(cliModel).toBeDefined();

    const binding = await server.inject({
      method: "PUT",
      url: "/api/ai/services/module.news/binding",
      headers: { authorization: `Bearer ${ids.sessionAdmin}` },
      payload: { binding: { kind: "model", modelId: cliModel!.id } }
    });
    expect(binding.statusCode).toBe(200);

    const generate = async (outputs: string[]) => {
      const adapter = {
        generateStructured: async () => ({
          rawText: outputs.shift() ?? "{}",
          usage: { inputTokens: 0, outputTokens: 0 }
        })
      };
      return dataContext.withDataContext(adminContext(), (scopedDb) =>
        generateStructured(
          scopedDb,
          {
            service: "module.news",
            prompt: "Return a title.",
            schema: {
              type: "object",
              required: ["title"],
              properties: { title: { type: "string" } }
            }
          },
          {
            repository,
            cipher: {
              decryptJson: () => {
                throw new Error("CLI must not decrypt");
              }
            },
            createCliStructuredAdapter: (kind) => {
              expect(kind).toBe("openai-compatible");
              return adapter;
            }
          }
        )
      );
    };

    expect(await generate(['{"title":"CLI"}'])).toMatchObject({
      ok: true,
      object: { title: "CLI" }
    });
    expect(await generate(["not-json", '{"title":"Repaired"}'])).toMatchObject({
      ok: true,
      object: { title: "Repaired" }
    });
    await dataContext.withDataContext(adminContext(), (db) =>
      repository.deleteModuleServiceBinding(db, "module.news", ids.adminUser)
    );
  });
});
