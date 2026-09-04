import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";

import {
  AiRepository,
  ModelDiscoveryService,
  createAiSecretCipher,
  registerAiRoutes,
  type AiSecretCipher
} from "@moss/ai";
import { DataContextRunner, createDatabase, type AccessContext, type MossDatabase } from "@moss/db";
import type { AiCliModelListResult } from "@moss/shared";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const { Client } = pg;

/**
 * #2208 slices 3-4: POST /api/ai/providers/:id/models/refresh and the discovered/manual rule.
 * The runner's live list is stubbed per test through a swappable lister, so each case controls
 * exactly what "the vendor" answers.
 */
describe("AI provider model refresh (#2208)", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let repository: AiRepository;
  let cipher: AiSecretCipher;
  let server: FastifyInstance;
  let originalSecretKey: string | undefined;
  let listerAnswer: AiCliModelListResult = { status: "unsupported" };

  beforeAll(async () => {
    originalSecretKey = process.env.JARVIS_AI_SECRET_KEY;
    process.env.JARVIS_AI_SECRET_KEY = "test-ai-secret-key";

    await resetFoundationDatabase();
    await setInstanceAdmin(ids.userA);

    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    dataContext = new DataContextRunner(appDb);
    repository = new AiRepository();
    cipher = createAiSecretCipher();

    server = Fastify({ logger: false });
    server.after(() =>
      registerAiRoutes(server, {
        resolveAccessContext: async (request) =>
          request.headers.authorization === `Bearer ${ids.sessionB}`
            ? userContext(ids.userB)
            : userContext(ids.userA),
        dataContext,
        resolveActiveModules: async () => [],
        repository,
        secretCipher: cipher,
        modelDiscovery: new ModelDiscoveryService({ cliModelLister: async () => listerAnswer })
      })
    );
    await server.ready();
  });

  afterAll(async () => {
    await Promise.allSettled([server?.close(), appDb?.destroy()]);
    if (originalSecretKey === undefined) {
      delete process.env.JARVIS_AI_SECRET_KEY;
    } else {
      process.env.JARVIS_AI_SECRET_KEY = originalSecretKey;
    }
  });

  beforeEach(async () => {
    await truncateAiTables();
    listerAnswer = { status: "unsupported" };
  });

  async function createCliProvider(): Promise<string> {
    return dataContext.withDataContext(userContext(ids.userA), async (db) => {
      const provider = await repository.createProvider(db, {
        providerKind: "anthropic",
        displayName: "Claude",
        authMethod: "cli",
        encryptedCredential: cipher.encryptJson({ cli: true })
      });
      // The #367 sentinel every CLI provider carries.
      await repository.upsertDiscoveredModels(db, provider.id, [
        {
          providerModelId: "default",
          displayName: "Default",
          capabilities: ["chat"],
          tier: "interactive",
          status: "active"
        }
      ]);
      return provider.id;
    });
  }

  async function refresh(providerId: string, session: string = ids.sessionA) {
    return server.inject({
      method: "POST",
      url: `/api/ai/providers/${providerId}/models/refresh`,
      headers: { authorization: `Bearer ${session}` }
    });
  }

  async function storedModelIds(providerId: string): Promise<string[]> {
    const models = await dataContext.withDataContext(userContext(ids.userA), (db) =>
      repository.listModels(db)
    );
    return models
      .filter((model) => model.provider_config_id === providerId)
      .map((model) => model.provider_model_id)
      .sort();
  }

  it("requires an instance admin", async () => {
    const providerId = await createCliProvider();
    const response = await refresh(providerId, ids.sessionB);
    expect(response.statusCode).toBe(403);
  });

  it("stores the vendor's list and reports the count", async () => {
    const providerId = await createCliProvider();
    listerAnswer = {
      status: "ok",
      models: [{ id: "claude-fable-5-1" }, { id: "claude-haiku-4-5-20251001" }]
    };

    const response = await refresh(providerId);

    expect(response.statusCode).toBe(200);
    const body = response.json<{ models: { providerModelId: string; origin: string }[] }>();
    expect(body).not.toHaveProperty("reason");
    expect(body.models.map((m) => m.providerModelId).sort()).toEqual([
      "claude-fable-5-1",
      "claude-haiku-4-5-20251001",
      "default"
    ]);
    expect(body.models.every((m) => m.origin === "discovered")).toBe(true);
    expect(await storedModelIds(providerId)).toEqual([
      "claude-fable-5-1",
      "claude-haiku-4-5-20251001",
      "default"
    ]);
  });

  it("prunes discovered rows that left the list but keeps manual rows and the sentinel", async () => {
    const providerId = await createCliProvider();
    listerAnswer = { status: "ok", models: [{ id: "claude-old" }, { id: "claude-kept" }] };
    expect((await refresh(providerId)).statusCode).toBe(200);

    // Admin adds a model by hand through the existing create route.
    const created = await server.inject({
      method: "POST",
      url: "/api/ai/models",
      headers: { authorization: `Bearer ${ids.sessionA}`, "content-type": "application/json" },
      payload: {
        providerConfigId: providerId,
        providerModelId: "claude-by-hand",
        displayName: "By hand",
        capabilities: ["chat"],
        tier: "reasoning"
      }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ model: { origin: "manual" } });

    // The vendor's next list drops "claude-old" and, of course, never mentions the manual row.
    listerAnswer = { status: "ok", models: [{ id: "claude-kept" }, { id: "claude-new" }] };
    const response = await refresh(providerId);

    expect(response.statusCode).toBe(200);
    expect(await storedModelIds(providerId)).toEqual([
      "claude-by-hand",
      "claude-kept",
      "claude-new",
      "default"
    ]);
    const byHand = response
      .json<{ models: { providerModelId: string; origin: string }[] }>()
      .models.find((m) => m.providerModelId === "claude-by-hand");
    expect(byHand?.origin).toBe("manual");
  });

  it.each([
    ["not_logged_in", "Not logged in"],
    ["unsupported", undefined],
    ["error", "HTTP 503"]
  ] as const)(
    "changes nothing and reports %s when the list cannot be fetched",
    async (status, message) => {
      const providerId = await createCliProvider();
      listerAnswer = { status: "ok", models: [{ id: "claude-kept" }] };
      expect((await refresh(providerId)).statusCode).toBe(200);
      const before = await storedModelIds(providerId);

      listerAnswer = message === undefined ? { status } : { status, message };
      const response = await refresh(providerId);

      expect(response.statusCode).toBe(200);
      const body = response.json<{ reason: string; message?: string; models: unknown[] }>();
      expect(body.reason).toBe(status);
      if (message !== undefined) expect(body.message).toBe(message);
      expect(body.models).toHaveLength(before.length);
      expect(await storedModelIds(providerId)).toEqual(before);
    }
  );

  it("does not cache a previous answer: a login after a failed refresh is seen at once", async () => {
    const providerId = await createCliProvider();
    listerAnswer = { status: "not_logged_in" };
    expect((await refresh(providerId)).json()).toMatchObject({ reason: "not_logged_in" });

    listerAnswer = { status: "ok", models: [{ id: "claude-fable-5-1" }] };
    const response = await refresh(providerId);
    expect(response.json()).not.toHaveProperty("reason");
    expect(await storedModelIds(providerId)).toEqual(["claude-fable-5-1", "default"]);
  });

  it("answers 404 for the voice (STT) provider row", async () => {
    const voice = await dataContext.withDataContext(userContext(ids.userA), (db) =>
      repository.upsertVoiceEndpoint(db, {
        baseUrl: "https://stt.example.test/v1",
        modelName: "whisper-1",
        encryptedCredential: cipher.encryptJson({ apiKey: "voice-secret" })
      })
    );
    const response = await refresh(voice.provider.id);
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain("voice-secret");
  });

  it("answers 400 for a revoked provider", async () => {
    const providerId = await createCliProvider();
    await dataContext.withDataContext(userContext(ids.userA), (db) =>
      repository.revokeProvider(db, providerId, cipher.encryptJson({ revoked: true }))
    );
    expect((await refresh(providerId)).statusCode).toBe(400);
  });
});

function userContext(actorUserId: string): AccessContext {
  return { actorUserId, requestId: `request:${actorUserId}-model-refresh` };
}

async function setInstanceAdmin(userId: string): Promise<void> {
  const client = new Client({ connectionString: connectionStrings.bootstrap });
  await client.connect();
  try {
    await client.query(`UPDATE app.users SET is_instance_admin = true WHERE id = $1`, [userId]);
  } finally {
    await client.end();
  }
}

async function truncateAiTables(): Promise<void> {
  const client = new Client({ connectionString: connectionStrings.bootstrap });
  await client.connect();
  try {
    await client.query(
      `TRUNCATE app.ai_configured_models, app.ai_provider_configs RESTART IDENTITY CASCADE`
    );
  } finally {
    await client.end();
  }
}
