import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";

import { createApiServer } from "../../apps/api/src/server.js";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import { AiRepository } from "@moss/ai";
import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import { ids, connectionStrings, resetFoundationDatabase } from "./test-database.js";

// Needs a database: run through the verify-gate skill, scoped to this file (#2570).
//
// The Trail Marker focus judgment is platform code, not a module, so its service key names no
// installed module. The binding check accepts it through a short list of platform-owned names, and
// the model is never defaulted: it resolves only when an admin has bound this exact key.

const SERVICE = "module.trail-marker.judge";

describe("Trail Marker focus judgment model binding", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let repository: AiRepository;
  let server: ReturnType<typeof createApiServer>;
  let boss: PgBoss;
  let originalSecretKey: string | undefined;
  let originalFetch: typeof globalThis.fetch;
  let providerId: string;
  let modelId: string;

  beforeAll(async () => {
    originalSecretKey = process.env.JARVIS_AI_SECRET_KEY;
    process.env.JARVIS_AI_SECRET_KEY = "test-trail-marker-binding-secret";
    // Provider creation runs live model discovery; reject so the suite never touches the network.
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("network disabled in ai-trail-marker-binding.test");
    }) as typeof globalThis.fetch;

    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    dataContext = new DataContextRunner(appDb);
    repository = new AiRepository();
    boss = createPgBossClient(connectionStrings.app, { connectionTimeoutMillis: 25_000 });
    server = createApiServer({ appDb, boss, logger: false });
    await server.ready();

    providerId = await seedProvider();
    // A default provider with a json model exists, which is exactly the situation where a
    // "default" fallback would wrongly serve the judgment.
    const setDefault = await server.inject({
      method: "PUT",
      url: `/api/ai/providers/${providerId}/default`,
      headers: { authorization: `Bearer ${ids.sessionAdmin}` }
    });
    expect(setDefault.statusCode).toBe(200);
    modelId = await seedModel("judge-model", ["json"]);
  });

  afterAll(async () => {
    await Promise.allSettled([server?.close(), appDb?.destroy(), boss?.stop({ graceful: false })]);
    globalThis.fetch = originalFetch;
    if (originalSecretKey === undefined) delete process.env.JARVIS_AI_SECRET_KEY;
    else process.env.JARVIS_AI_SECRET_KEY = originalSecretKey;
  });

  async function seedProvider(): Promise<string> {
    const response = await server.inject({
      method: "POST",
      url: "/api/ai/providers",
      headers: { authorization: `Bearer ${ids.sessionAdmin}` },
      payload: {
        providerKind: "anthropic",
        displayName: "Trail Marker binding provider",
        credentialPayload: { apiKey: "trail-marker-binding-secret" }
      }
    });
    expect(response.statusCode).toBe(201);
    return response.json<{ provider: { id: string } }>().provider.id;
  }

  async function seedModel(providerModelId: string, capabilities: readonly string[]) {
    const response = await server.inject({
      method: "POST",
      url: "/api/ai/models",
      headers: { authorization: `Bearer ${ids.sessionAdmin}` },
      payload: {
        providerConfigId: providerId,
        providerModelId,
        displayName: providerModelId,
        capabilities,
        tier: "economy"
      }
    });
    expect(response.statusCode).toBe(201);
    return response.json<{ model: { id: string } }>().model.id;
  }

  function bind(service: string, payload: unknown, session: string = ids.sessionAdmin) {
    return server.inject({
      method: "PUT",
      url: `/api/ai/services/${service}/binding`,
      headers: { authorization: `Bearer ${session}` },
      payload: payload as never
    });
  }

  async function resolveAsAdmin() {
    return dataContext.withDataContext(
      { actorUserId: ids.adminUser, requestId: "trail-marker-binding-resolve" },
      (scopedDb) =>
        repository.resolveModelForService(scopedDb, SERVICE, {
          capability: "json",
          requireExplicitBinding: true
        })
    );
  }

  it("never resolves a model for the key while nothing is bound, even with a default provider and a json model (fails if a default is used)", async () => {
    const resolved = await resolveAsAdmin();
    expect(resolved.model).toBeNull();
  });

  it("binds with no module of that name installed, and then resolves that exact model", async () => {
    const response = await bind(SERVICE, { binding: { kind: "model", modelId } });
    expect(response.statusCode).toBe(200);

    const resolved = await resolveAsAdmin();
    expect(resolved.model?.id).toBe(modelId);
  });

  it("refuses a name that is not platform-owned and not an installed module (fails if the allowance is a blanket pass)", async () => {
    for (const service of [
      "module.nonexistent",
      "module.trail-markers",
      "module.trail-marker-evil"
    ]) {
      const response = await bind(service, { binding: { kind: "model", modelId } });
      expect(response.statusCode, service).toBe(400);
      expect(response.json<{ error: string }>().error).toContain("installed module");
    }
  });

  it("refuses a mode binding for this key: it must name one specific model", async () => {
    const response = await bind(SERVICE, { binding: { kind: "mode", tier: "economy" } });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toContain("specific model");
  });

  it("refuses anyone who is not an instance admin", async () => {
    const response = await bind(SERVICE, { binding: { kind: "model", modelId } }, ids.sessionA);
    expect(response.statusCode).toBe(403);
  });

  it("returns to never resolving once the binding is removed", async () => {
    const removed = await server.inject({
      method: "DELETE",
      url: `/api/ai/services/${SERVICE}/binding`,
      headers: { authorization: `Bearer ${ids.sessionAdmin}` }
    });
    expect(removed.statusCode).toBe(200);
    expect((await resolveAsAdmin()).model).toBeNull();
  });
});
