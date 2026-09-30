import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import pg from "pg";

import { createApiServer } from "../../apps/api/src/server.js";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const { Client } = pg;

describe("AI chat model override", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let server: ReturnType<typeof createApiServer>;
  let boss: PgBoss;

  beforeAll(async () => {
    await resetFoundationDatabase();
    await setUserAInstanceAdmin();

    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    dataContext = new DataContextRunner(appDb);
    // #1124: createApiServer()'s default boss falls back to pg-boss's own 10s
    // connectionTimeoutMillis, which a loaded CI runner's PG connection establishment can
    // exceed even when the connection ultimately succeeds. Pass an explicit, longer-but-still-
    // under-hookTimeout override so a slow-but-healthy CI connection isn't killed prematurely.
    // Test-only — production callers of createApiServer() are unaffected.
    boss = createPgBossClient(connectionStrings.app, { connectionTimeoutMillis: 25_000 });
    server = createApiServer({ appDb, boss, logger: false });
    await server.ready();
  });

  afterAll(async () => {
    await Promise.allSettled([server?.close(), appDb?.destroy(), boss?.stop({ graceful: false })]);
  });

  it("persists per-user chat model overrides and falls back when globally disabled or disallowed", async () => {
    const providerResponse = await server.inject({
      method: "POST",
      url: "/api/ai/providers",
      headers: { authorization: `Bearer ${ids.sessionA}` },
      payload: {
        providerKind: "anthropic",
        displayName: "Override Provider",
        credentialPayload: { apiKey: "override-secret" }
      }
    });
    const providerId = providerResponse.json<{ provider: { id: string } }>().provider.id;
    const overrideResponse = await server.inject({
      method: "POST",
      url: "/api/ai/models",
      headers: { authorization: `Bearer ${ids.sessionA}` },
      payload: {
        providerConfigId: providerId,
        providerModelId: "claude-override",
        displayName: "Claude Override",
        capabilities: ["chat"]
      }
    });
    const defaultResponse = await server.inject({
      method: "POST",
      url: "/api/ai/models",
      headers: { authorization: `Bearer ${ids.sessionA}` },
      payload: {
        providerConfigId: providerId,
        providerModelId: "claude-default",
        displayName: "Claude Default",
        capabilities: ["chat"]
      }
    });
    const overrideId = overrideResponse.json<{ model: { id: string } }>().model.id;
    const defaultId = defaultResponse.json<{ model: { id: string } }>().model.id;

    const initial = await server.inject({
      method: "GET",
      url: "/api/ai/chat-model-override",
      headers: { authorization: `Bearer ${ids.sessionB}` }
    });
    const deniedAdminWrite = await server.inject({
      method: "PUT",
      url: "/api/admin/ai/chat-model-override",
      headers: { authorization: `Bearer ${ids.sessionB}` },
      payload: { enabled: true }
    });
    const enabled = await server.inject({
      method: "PUT",
      url: "/api/admin/ai/chat-model-override",
      headers: { authorization: `Bearer ${ids.sessionA}` },
      payload: { enabled: true }
    });
    const saved = await server.inject({
      method: "PUT",
      url: "/api/ai/chat-model-override",
      headers: { authorization: `Bearer ${ids.sessionB}` },
      payload: { modelId: overrideId }
    });
    const userASettings = await server.inject({
      method: "GET",
      url: "/api/ai/chat-model-override",
      headers: { authorization: `Bearer ${ids.sessionA}` }
    });
    const userAPreferenceRows = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "request:user-a-ai-override" },
      (scopedDb) =>
        scopedDb.db
          .selectFrom("app.preferences")
          .select(["key", "value_json"])
          .where("key", "=", "chat.modelOverride")
          .execute()
    );
    const disabledModel = await server.inject({
      method: "PATCH",
      url: `/api/ai/models/${overrideId}`,
      headers: { authorization: `Bearer ${ids.sessionA}` },
      payload: { allowUserOverride: false }
    });
    const afterDisallow = await server.inject({
      method: "GET",
      url: "/api/ai/chat-model-override",
      headers: { authorization: `Bearer ${ids.sessionB}` }
    });
    const disabledGlobal = await server.inject({
      method: "PUT",
      url: "/api/admin/ai/chat-model-override",
      headers: { authorization: `Bearer ${ids.sessionA}` },
      payload: { enabled: false }
    });

    expect(providerResponse.statusCode).toBe(201);
    expect(overrideResponse.statusCode).toBe(201);
    expect(defaultResponse.statusCode).toBe(201);
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({
      settings: {
        overrideEnabled: false,
        currentOverrideModelId: null,
        effectiveOverrideModelId: null,
        selectedModel: {
          id: defaultId,
          providerModelId: null
        }
      }
    });
    expect(deniedAdminWrite.statusCode).toBe(403);
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json()).toMatchObject({ settings: { overrideEnabled: true } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      settings: {
        currentOverrideModelId: overrideId,
        effectiveOverrideModelId: overrideId,
        selectedModel: {
          id: overrideId,
          providerModelId: null
        }
      }
    });
    expect(userASettings.json()).toMatchObject({
      settings: {
        currentOverrideModelId: null,
        selectedModel: { id: defaultId }
      }
    });
    expect(userAPreferenceRows).toEqual([]);
    expect(disabledModel.statusCode).toBe(200);
    expect(afterDisallow.json()).toMatchObject({
      settings: {
        currentOverrideModelId: overrideId,
        effectiveOverrideModelId: null,
        selectedModel: { id: defaultId }
      }
    });
    expect(disabledGlobal.statusCode).toBe(200);
    expect(disabledGlobal.json()).toMatchObject({ settings: { overrideEnabled: false } });
  });

  it("stores starred chat models per user, deduped, and keeps them private to the owner", async () => {
    const empty = await server.inject({
      method: "GET",
      url: "/api/ai/chat-model-favorites",
      headers: { authorization: `Bearer ${ids.sessionB}` }
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ modelIds: [] });

    const saved = await server.inject({
      method: "PUT",
      url: "/api/ai/chat-model-favorites",
      headers: { authorization: `Bearer ${ids.sessionB}` },
      payload: { modelIds: ["model-x", "model-y", "model-x"] }
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ modelIds: ["model-x", "model-y"] });

    const reread = await server.inject({
      method: "GET",
      url: "/api/ai/chat-model-favorites",
      headers: { authorization: `Bearer ${ids.sessionB}` }
    });
    expect(reread.json()).toEqual({ modelIds: ["model-x", "model-y"] });

    // Another user, including an instance admin, sees only their own (empty) list.
    const otherUser = await server.inject({
      method: "GET",
      url: "/api/ai/chat-model-favorites",
      headers: { authorization: `Bearer ${ids.sessionA}` }
    });
    expect(otherUser.json()).toEqual({ modelIds: [] });
    const userARows = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "request:user-a-chat-favorites" },
      (scopedDb) =>
        scopedDb.db
          .selectFrom("app.preferences")
          .select("key")
          .where("key", "=", "chat.favoriteModels")
          .execute()
    );
    expect(userARows).toEqual([]);

    const tooMany = await server.inject({
      method: "PUT",
      url: "/api/ai/chat-model-favorites",
      headers: { authorization: `Bearer ${ids.sessionB}` },
      payload: { modelIds: Array.from({ length: 101 }, (_, index) => `model-${index}`) }
    });
    expect(tooMany.statusCode).toBe(400);

    const cleared = await server.inject({
      method: "PUT",
      url: "/api/ai/chat-model-favorites",
      headers: { authorization: `Bearer ${ids.sessionB}` },
      payload: { modelIds: [] }
    });
    expect(cleared.json()).toEqual({ modelIds: [] });
  });

  it("rejects favorites requests without a session", async () => {
    const response = await server.inject({ method: "GET", url: "/api/ai/chat-model-favorites" });
    expect(response.statusCode).toBe(401);
  });
});

async function setUserAInstanceAdmin(): Promise<void> {
  const client = new Client({ connectionString: connectionStrings.bootstrap });

  await client.connect();
  try {
    await client.query(`UPDATE app.users SET is_instance_admin = true WHERE id = $1`, [ids.userA]);
  } finally {
    await client.end();
  }
}
