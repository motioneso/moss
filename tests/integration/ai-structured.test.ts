import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import Fastify from "fastify";

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
import { createModuleBuildSourceGenerator } from "../../apps/worker/src/module-build-source.js";

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

describe("Workshop source credential ownership", () => {
  it("restricts credential lookup to the authenticated database actor", async () => {
    await dataContext.withDataContext(adminContext(), async (db) => {
      const owned = await repository.selectProviderWithCredential(db, providerId, {
        ownerOnly: true
      });
      expect(owned?.id).toBe(providerId);
      expect(owned?.owner_user_id).toBe(ids.adminUser);
    });
    await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "workshop-foreign-provider" },
      async (db) => {
        expect(
          await repository.selectProviderWithCredential(db, providerId, { ownerOnly: true })
        ).toBeUndefined();
      }
    );
  });

  it("routes real HTTP source generation with owner credentials and rejects foreign actors and conflicting pins", async () => {
    const provider = Fastify({ logger: false, bodyLimit: 131_072, requestTimeout: 5_000 });
    const received: string[] = [];
    const source = { files: [{ path: "SPEC.md", content: "Synthetic owner-only proposal." }] };
    provider.post<{ Body: { model: string; messages: unknown; tools?: unknown } }>(
      "/v1/chat/completions",
      async (request) => {
        expect(request.headers.authorization).toBe("Bearer workshop-http-synthetic-secret");
        expect(JSON.stringify(request.body.messages)).toContain("workshop-owner-plan");
        expect(JSON.stringify(request.body.messages)).not.toContain("synthetic-secret");
        expect(request.body.tools).toBeUndefined();
        received.push(request.body.model);
        return {
          choices: [{ message: { content: JSON.stringify(source) } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 }
        };
      }
    );
    const baseUrl = await provider.listen({ host: "127.0.0.1", port: 0 });
    const blockedFetch = globalThis.fetch;
    let fixtureProviderId: string | undefined;
    // Exercise the default production HTTP adapter, allowing only this synthetic endpoint.
    globalThis.fetch = (input, init) => {
      if (String(input) !== `${baseUrl}/v1/chat/completions`) {
        throw new Error("network disabled outside Workshop fixture");
      }
      return realFetch(input, { ...init, redirect: "error" });
    };
    try {
      const created = await server.inject({
        method: "POST",
        url: "/api/ai/providers",
        headers: { authorization: `Bearer ${ids.sessionAdmin}` },
        payload: {
          providerKind: "openai-compatible",
          displayName: "Workshop local HTTP fixture",
          baseUrl,
          credentialPayload: { apiKey: "workshop-http-synthetic-secret" }
        }
      });
      expect(created.statusCode).toBe(201);
      expect(created.json().provider.baseUrl).toBe(baseUrl);
      fixtureProviderId = created.json().provider.id as string;
      const reasoning = await seedModel(
        fixtureProviderId,
        "workshop-http-reasoning",
        ["json"],
        "reasoning"
      );
      const interactive = await seedModel(
        fixtureProviderId,
        "workshop-http-interactive",
        ["json"],
        "interactive"
      );
      await dataContext.withDataContext(adminContext(), async (db) => {
        await repository.setServiceBinding(
          db,
          "module.workshop.plan",
          { kind: "model", modelId: reasoning },
          ids.adminUser
        );
        await repository.setServiceBinding(
          db,
          "module.workshop",
          { kind: "model", modelId: interactive },
          ids.adminUser
        );
      });
      const generate = (actorUserId: string, step: "writing_spec" | "writing_code") =>
        dataContext.withDataContext({ actorUserId, requestId: "workshop-http-proof" }, (db) =>
          createModuleBuildSourceGenerator(db, actorUserId, {
            repository,
            cipher: createAiSecretCipher(process.env)
          })({ step, plan: { description: "workshop-owner-plan" } })
        );

      await expect(generate(ids.adminUser, "writing_spec")).resolves.toEqual(source);
      await expect(generate(ids.adminUser, "writing_code")).resolves.toEqual(source);
      await expect(generate(ids.userA, "writing_code")).rejects.toThrow("owner-bound connection");
      expect(received).toEqual(["workshop-http-reasoning", "workshop-http-interactive"]);

      await dataContext.withDataContext(adminContext(), (db) =>
        repository.setAdminPinnedModel(db, reasoning)
      );
      await expect(generate(ids.adminUser, "writing_code")).resolves.toEqual(source);
      await dataContext.withDataContext(adminContext(), (db) =>
        repository.setAdminPinnedModel(db, interactive)
      );
      await expect(generate(ids.adminUser, "writing_spec")).rejects.toThrow(
        "owner-bound connection"
      );
      expect(received).toEqual([
        "workshop-http-reasoning",
        "workshop-http-interactive",
        "workshop-http-reasoning"
      ]);
    } finally {
      globalThis.fetch = blockedFetch;
      await provider.close();
      await dataContext.withDataContext(adminContext(), async (db) => {
        await repository.setAdminPinnedModel(db, null);
        await repository.deleteModuleServiceBinding(db, "module.workshop", ids.adminUser);
        await repository.deleteModuleServiceBinding(db, "module.workshop.plan", ids.adminUser);
        if (fixtureProviderId) {
          await repository.updateProvider(db, fixtureProviderId, { status: "disabled" });
        }
      });
    }
  });
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

  it("migrates legacy Workshop planning via admin API, preserves a new binding, and never resurrects deletion", async () => {
    const legacy = "module.moss.workshop-build-plan";
    const current = "module.workshop.plan";
    try {
      for (const explicit of [false, true]) {
        await dataContext.withDataContext(adminContext(), async (db) => {
          await repository.deleteModuleServiceBinding(db, current, ids.adminUser);
          await repository.setServiceBinding(
            db,
            legacy,
            { kind: "mode", tier: "reasoning" },
            ids.adminUser
          );
          if (explicit)
            await repository.setServiceBinding(
              db,
              current,
              { kind: "mode", tier: "interactive" },
              ids.adminUser
            );
          expect(await repository.getModuleServiceBinding(db, current)).toEqual({
            kind: "mode",
            tier: explicit ? "interactive" : "reasoning"
          });
        });
        for (let count = 0; count < 2; count += 1) {
          const response = await server.inject({
            method: "GET",
            url: "/api/ai/service-bindings",
            headers: auth
          });
          expect(response.statusCode, response.body).toBe(200);
          expect(response.json().bindings[current]).toEqual({
            kind: "mode",
            tier: explicit ? "interactive" : "reasoning"
          });
          expect(response.json().bindings).not.toHaveProperty(legacy);
        }
        await dataContext.withDataContext(adminContext(), async (db) => {
          const stored = await db.db
            .selectFrom("app.instance_settings")
            .select("value")
            .where("key", "=", "ai.service_bindings")
            .executeTakeFirstOrThrow();
          expect(stored.value).not.toHaveProperty(legacy);
        });
      }
      await dataContext.withDataContext(adminContext(), (db) =>
        repository.setServiceBinding(db, legacy, { kind: "mode", tier: "reasoning" }, ids.adminUser)
      );
      const deleted = await server.inject({
        method: "DELETE",
        url: `/api/ai/services/${current}/binding`,
        headers: auth
      });
      expect(deleted.statusCode, deleted.body).toBe(200);
      const list = await server.inject({
        method: "GET",
        url: "/api/ai/service-bindings",
        headers: auth
      });
      expect(list.json().bindings).not.toHaveProperty(current);
    } finally {
      await dataContext.withDataContext(adminContext(), (db) =>
        repository.deleteModuleServiceBinding(db, current, ids.adminUser)
      );
    }
  });

  it("round-trips the installed Workshop planning key and rejects a selected non-reasoning route before provider access", async () => {
    const service = "module.workshop.plan";
    try {
      const put = await server.inject({
        method: "PUT",
        url: `/api/ai/services/${service}/binding`,
        headers: auth,
        payload: { binding: { kind: "model", modelId: modelEconomyJsonId } }
      });
      expect(put.statusCode, put.body).toBe(200);
      const result = await dataContext.withDataContext(adminContext(), (db) =>
        generateStructured(
          db,
          {
            service,
            schema: { type: "object" },
            prompt: "plan",
            tierHint: "reasoning",
            requiredTier: "reasoning"
          },
          {
            repository,
            cipher: {
              decryptJson: () => {
                throw new Error("must reject before credential access");
              }
            }
          }
        )
      );
      expect(result).toEqual({ ok: false, error: "needs_config" });
    } finally {
      await dataContext.withDataContext(adminContext(), (db) =>
        repository.deleteModuleServiceBinding(db, service, ids.adminUser)
      );
    }
  });

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
