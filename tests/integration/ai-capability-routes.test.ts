import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import pg from "pg";

import { createApiServer } from "../../apps/api/src/server.js";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import { AiRepository } from "@moss/ai";
import { DataContextRunner, createDatabase, type AccessContext, type MossDatabase } from "@moss/db";
import { ids, connectionStrings, resetFoundationDatabase } from "./test-database.js";

const { Client } = pg;

// #870/MED-3 (Fable): provider-create runs live model discovery, which calls
// modelDiscovery.discoverModels() -> `input.fetch ?? globalThis.fetch` (model-discovery.ts:141).
// The route doesn't inject a fetch, so without this stub every seedProvider() would hit
// api.anthropic.com. Rejecting forces the static fallback (fromFallback=true) → routes.ts skips
// persisting fabricated models, leaving each provider's model set fully test-controlled and the
// suite network-independent. Returns a restore fn for afterAll.
function installNetworkStub(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("network disabled in ai-capability-routes.test");
  }) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = original;
  };
}

// #870 Slice 1: the per-capability manual routes + tier preferences are retired. This suite covers
// their replacement — the per-service binding (Chat only, #874 HIGH-2 dropped the transcription
// binding — Voice is now its own dedicated endpoint, see ai-voice-endpoint.test.ts), the
// instance-default provider, and the resolver's mode/model/needs-config behaviour. Admin-owned config
// is created through the HTTP API as the instance admin (adminUser/sessionAdmin); pin behaviour lives
// in ai-admin-pin.test.ts.
describe("AI service bindings + instance-default resolver", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let repository: AiRepository;
  let server: ReturnType<typeof createApiServer>;
  let boss: PgBoss;
  let originalSecretKey: string | undefined;
  let restoreFetch: () => void;
  let providerId: string;

  beforeAll(async () => {
    originalSecretKey = process.env.JARVIS_AI_SECRET_KEY;
    process.env.JARVIS_AI_SECRET_KEY = "test-ai-service-bindings-secret";
    restoreFetch = installNetworkStub();

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

    providerId = await seedProvider("Service binding provider");
    // Make it the instance default so "mode" bindings resolve inside it.
    const setDefault = await server.inject({
      method: "PUT",
      url: `/api/ai/providers/${providerId}/default`,
      headers: { authorization: `Bearer ${ids.sessionAdmin}` }
    });
    expect(setDefault.statusCode).toBe(200);
  });

  afterAll(async () => {
    await Promise.allSettled([server?.close(), appDb?.destroy(), boss?.stop({ graceful: false })]);
    restoreFetch?.();
    if (originalSecretKey === undefined) {
      delete process.env.JARVIS_AI_SECRET_KEY;
    } else {
      process.env.JARVIS_AI_SECRET_KEY = originalSecretKey;
    }
  });

  it("resolves a mode binding inside the instance-default provider at the bound tier", async () => {
    // Two chat-capable models in the default provider on different tiers.
    await seedModel("mode-chat-economy", ["chat"], "economy");
    const reasoningId = await seedModel("mode-chat-reasoning", ["chat"], "reasoning");

    const putRes = await server.inject({
      method: "PUT",
      url: "/api/ai/services/chat/binding",
      headers: { authorization: `Bearer ${ids.sessionAdmin}` },
      payload: { binding: { kind: "mode", tier: "reasoning" } }
    });

    const resolved = await dataContext.withDataContext(adminContext(), (scopedDb) =>
      repository.resolveModelForCapability(scopedDb, "chat", "interactive")
    );

    expect(putRes.statusCode).toBe(200);
    expect(putRes.json()).toMatchObject({
      service: "chat",
      binding: { kind: "mode", tier: "reasoning" }
    });
    expect(resolved.reason).toBe("matched-active-model");
    expect(resolved.model?.id).toBe(reasoningId);
  });

  it("prefers the newest release inside a tier over the most recently registered row (0214)", async () => {
    const seed = (providerModelId: string, releasedAt: string) =>
      dataContext.withDataContext(adminContext(), (scopedDb) =>
        repository.upsertDiscoveredModels(scopedDb, providerId, [
          {
            providerModelId,
            displayName: providerModelId,
            capabilities: ["chat", "summarization"],
            tier: "interactive",
            status: "active",
            releasedAt
          }
        ])
      );
    // The newer release is registered FIRST, so registration order alone would pick the older one.
    await seed("release-newer", "2026-05-01T00:00:00Z");
    await seed("release-older", "2025-09-29T00:00:00Z");
    // Re-discovery of an existing row fills a missing date but never duplicates or clobbers.
    await seed("release-older", "2020-01-01T00:00:00Z");

    const bind = await server.inject({
      method: "PUT",
      url: "/api/ai/services/chat/binding",
      headers: { authorization: `Bearer ${ids.sessionAdmin}` },
      payload: { binding: { kind: "mode", tier: "interactive" } }
    });
    expect(bind.statusCode).toBe(200);

    const [chat, worker] = await dataContext.withDataContext(adminContext(), (scopedDb) =>
      Promise.all([
        repository.resolveModelForCapability(scopedDb, "chat", "interactive"),
        repository.resolveModelForCapability(scopedDb, "summarization", "interactive")
      ])
    );
    expect(chat.model?.provider_model_id).toBe("release-newer");
    expect(worker.model?.provider_model_id).toBe("release-newer");

    const rows = await dataContext.withDataContext(adminContext(), (scopedDb) =>
      scopedDb.db
        .selectFrom("app.ai_configured_models")
        .select(["provider_model_id", "released_at"])
        .where("provider_config_id", "=", providerId)
        .where("provider_model_id", "like", "release-%")
        .orderBy("provider_model_id")
        .execute()
    );
    expect(rows.map((row) => [row.provider_model_id, row.released_at?.toISOString()])).toEqual([
      ["release-newer", "2026-05-01T00:00:00.000Z"],
      ["release-older", "2025-09-29T00:00:00.000Z"]
    ]);
  });

  it("resolves a model binding to the exact model and reports needs-config when it is disabled", async () => {
    // #874 HIGH-2: chat is the only bindable service now, so this exercises the model-binding path on
    // chat (was transcription pre-#874). Restored to the mode binding at the end so later, order-
    // dependent assertions in this stateful suite still see `chat = mode:reasoning`.
    const modelId = await seedModel("bind-exact-chat", ["chat"], "interactive");

    await server.inject({
      method: "PUT",
      url: "/api/ai/services/chat/binding",
      headers: { authorization: `Bearer ${ids.sessionAdmin}` },
      payload: { binding: { kind: "model", modelId } }
    });

    const resolvedActive = await dataContext.withDataContext(adminContext(), (scopedDb) =>
      repository.resolveModelForCapability(scopedDb, "chat", "interactive")
    );

    // Disable the bound model — a user-facing service can't silently cross to another model.
    await server.inject({
      method: "PATCH",
      url: `/api/ai/models/${modelId}`,
      headers: { authorization: `Bearer ${ids.sessionAdmin}` },
      payload: { status: "disabled" }
    });
    const resolvedDisabled = await dataContext.withDataContext(adminContext(), (scopedDb) =>
      repository.resolveModelForCapability(scopedDb, "chat", "interactive")
    );

    expect(resolvedActive.reason).toBe("manual-route");
    expect(resolvedActive.model?.id).toBe(modelId);
    expect(resolvedDisabled.reason).toBe("needs-config");
    expect(resolvedDisabled.model).toBeNull();

    // Restore the mode binding this suite's later tests rely on.
    await server.inject({
      method: "PUT",
      url: "/api/ai/services/chat/binding",
      headers: { authorization: `Bearer ${ids.sessionAdmin}` },
      payload: { binding: { kind: "mode", tier: "reasoning" } }
    });
  });

  it("lists service bindings via GET and never leaks provider credentials", async () => {
    const listRes = await server.inject({
      method: "GET",
      url: "/api/ai/service-bindings",
      headers: { authorization: `Bearer ${ids.sessionAdmin}` }
    });
    const lookupRes = await server.inject({
      method: "GET",
      url: "/api/ai/capability-route/chat",
      headers: { authorization: `Bearer ${ids.sessionAdmin}` }
    });

    expect(listRes.statusCode).toBe(200);
    expect(listRes.json()).toMatchObject({
      bindings: { chat: { kind: "mode", tier: "reasoning" } }
    });
    expect(lookupRes.body).not.toContain("encrypted_credential");
    expect(lookupRes.body).not.toContain("service-binding-secret");
  });

  it("rejects a non-admin service binding write", async () => {
    const response = await server.inject({
      method: "PUT",
      url: "/api/ai/services/chat/binding",
      headers: { authorization: `Bearer ${ids.sessionB}` },
      payload: { binding: { kind: "mode", tier: "interactive" } }
    });

    expect(response.statusCode).toBe(403);
  });

  it("rejects binding a non-chat capability (#874 HIGH-2: only Chat is bindable)", async () => {
    // A worker capability was never bindable; #874 HIGH-2 also drops transcription (Voice moved to
    // its dedicated endpoint). Both must 400 at the route as "not bindable".
    const worker = await server.inject({
      method: "PUT",
      url: "/api/ai/services/summarization/binding",
      headers: { authorization: `Bearer ${ids.sessionAdmin}` },
      payload: { binding: { kind: "mode", tier: "interactive" } }
    });
    const transcription = await server.inject({
      method: "PUT",
      url: "/api/ai/services/transcription/binding",
      headers: { authorization: `Bearer ${ids.sessionAdmin}` },
      payload: { binding: { kind: "mode", tier: "interactive" } }
    });

    expect(worker.statusCode).toBe(400);
    expect(transcription.statusCode).toBe(400);
  });

  it("keeps worker capabilities cross-provider automatic (no binding required)", async () => {
    const summaryId = await seedModel("worker-summary", ["summarization"], "economy");

    const resolved = await dataContext.withDataContext(adminContext(), (scopedDb) =>
      repository.resolveModelForCapability(scopedDb, "summarization", "economy")
    );

    expect(resolved.reason).toBe("matched-active-model");
    expect(resolved.model?.id).toBe(summaryId);
  });

  it("promotes a provider to instance-default and clears the prior flag (H1 singleton)", async () => {
    const secondId = await seedProvider("Second provider");

    const putRes = await server.inject({
      method: "PUT",
      url: `/api/ai/providers/${secondId}/default`,
      headers: { authorization: `Bearer ${ids.sessionAdmin}` }
    });
    const listRes = await server.inject({
      method: "GET",
      url: "/api/ai/providers",
      headers: { authorization: `Bearer ${ids.sessionAdmin}` }
    });
    const providers = listRes.json<{
      providers: { id: string; isInstanceDefault: boolean }[];
    }>().providers;
    const defaults = providers.filter((p) => p.isInstanceDefault);

    expect(putRes.statusCode).toBe(200);
    expect(putRes.json()).toMatchObject({ provider: { id: secondId, isInstanceDefault: true } });
    expect(defaults).toHaveLength(1);
    expect(defaults[0]!.id).toBe(secondId);

    // Restore the original default so later assertions in this file stay stable.
    await server.inject({
      method: "PUT",
      url: `/api/ai/providers/${providerId}/default`,
      headers: { authorization: `Bearer ${ids.sessionAdmin}` }
    });
  });

  // #874 HIGH-2: `transcription` is no longer a bindable service (Voice is its own dedicated
  // endpoint). The old "two services bound concurrently" M1 lost-update test is gone with it — chat
  // is now the ONLY bindable service, so a cross-service concurrent write is unreachable. What
  // remains worth guarding is the repository-level rejection: setServiceBinding must refuse a
  // non-user-facing service outright, so no assistant provider can ever be wired to Voice from here.
  it("setServiceBinding rejects transcription at the repository layer (#874 HIGH-2)", async () => {
    const voiceId = await seedModel("high2-voice", ["transcription"], "interactive");

    await expect(
      dataContext.withDataContext(adminContext(), (scopedDb) =>
        repository.setServiceBinding(
          scopedDb,
          "transcription",
          { kind: "model", modelId: voiceId },
          ids.adminUser
        )
      )
    ).rejects.toThrow(/not bindable/);

    const stored = await dataContext.withDataContext(adminContext(), (scopedDb) =>
      repository.getServiceBinding(scopedDb, "transcription")
    );
    expect(stored).toBeNull();
  });

  async function seedProvider(displayName: string): Promise<string> {
    const response = await server.inject({
      method: "POST",
      url: "/api/ai/providers",
      headers: { authorization: `Bearer ${ids.sessionAdmin}` },
      payload: {
        providerKind: "anthropic",
        displayName,
        credentialPayload: { apiKey: "service-binding-secret" }
      }
    });
    expect(response.statusCode).toBe(201);
    return response.json<{ provider: { id: string } }>().provider.id;
  }

  async function seedModel(
    providerModelId: string,
    capabilities: readonly string[],
    tier: string
  ): Promise<string> {
    const response = await server.inject({
      method: "POST",
      url: "/api/ai/models",
      headers: { authorization: `Bearer ${ids.sessionAdmin}` },
      payload: {
        providerConfigId: providerId,
        providerModelId,
        displayName: providerModelId,
        capabilities,
        tier
      }
    });
    expect(response.statusCode).toBe(201);
    return response.json<{ model: { id: string } }>().model.id;
  }
});

function adminContext(): AccessContext {
  return {
    actorUserId: ids.adminUser,
    requestId: "request:admin-ai-service-bindings"
  };
}

// #870/H2 (Fable HIGH-2): legacy `ai.capability_routes` read-through. An instance upgraded from a
// prior release may still carry the retired key; we surface a legacy route ONLY when its model is
// still active-under-active-provider, drop stale entries with no outage, and stop consulting legacy
// entirely once a unified service binding is saved. Fresh DB so no service binding masks the legacy
// path (the sibling suite binds chat/voice for its own assertions).
describe("AI legacy capability-route read-through (H2)", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let repository: AiRepository;
  let server: ReturnType<typeof createApiServer>;
  let boss: PgBoss;
  let originalSecretKey: string | undefined;
  let restoreFetch: () => void;
  let providerId: string;
  let activeChatId: string;

  const LEGACY_KEY = "ai.capability_routes";

  beforeAll(async () => {
    originalSecretKey = process.env.JARVIS_AI_SECRET_KEY;
    process.env.JARVIS_AI_SECRET_KEY = "test-ai-legacy-routes-secret";
    restoreFetch = installNetworkStub();

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

    providerId = await seedProvider("Legacy read-through provider");
    const setDefault = await server.inject({
      method: "PUT",
      url: `/api/ai/providers/${providerId}/default`,
      headers: { authorization: `Bearer ${ids.sessionAdmin}` }
    });
    expect(setDefault.statusCode).toBe(200);
    // The active chat model the instance-default provider falls back to (proves "no outage").
    activeChatId = await seedModel("legacy-active-chat", ["chat"], "interactive");
  });

  afterAll(async () => {
    await Promise.allSettled([server?.close(), appDb?.destroy(), boss?.stop({ graceful: false })]);
    restoreFetch?.();
    if (originalSecretKey === undefined) {
      delete process.env.JARVIS_AI_SECRET_KEY;
    } else {
      process.env.JARVIS_AI_SECRET_KEY = originalSecretKey;
    }
  });

  it("(a) resolves a legacy route whose model is active-under-active-provider", async () => {
    await writeLegacyRoutes({ chat: activeChatId });

    const resolved = await dataContext.withDataContext(adminContext(), (scopedDb) =>
      repository.resolveModelForCapability(scopedDb, "chat", "interactive")
    );

    // Surfaced as a model binding → resolver reason "manual-route".
    expect(resolved).toMatchObject({ reason: "manual-route", model: { id: activeChatId } });
  });

  it("(b) ignores a legacy route whose model is disabled — no outage, falls back to default provider", async () => {
    const disabledId = await seedModel("legacy-disabled-chat", ["chat"], "interactive");
    await server.inject({
      method: "PATCH",
      url: `/api/ai/models/${disabledId}`,
      headers: { authorization: `Bearer ${ids.sessionAdmin}` },
      payload: { status: "disabled" }
    });
    await writeLegacyRoutes({ chat: disabledId });

    const resolved = await dataContext.withDataContext(adminContext(), (scopedDb) =>
      repository.resolveModelForCapability(scopedDb, "chat", "interactive")
    );

    // The stale legacy route is dropped (never converted to needs-config); resolution falls through
    // to the instance-default provider's still-active chat model.
    expect(resolved).toMatchObject({ reason: "matched-active-model", model: { id: activeChatId } });
  });

  it("(c) stops consulting the legacy route once a service binding is saved (binding wins)", async () => {
    const boundId = await seedModel("legacy-superseded-by-binding", ["chat"], "interactive");
    // Legacy still points at the active chat model...
    await writeLegacyRoutes({ chat: activeChatId });
    // ...but an explicit binding to a DIFFERENT model must take precedence.
    const putRes = await server.inject({
      method: "PUT",
      url: "/api/ai/services/chat/binding",
      headers: { authorization: `Bearer ${ids.sessionAdmin}` },
      payload: { binding: { kind: "model", modelId: boundId } }
    });

    const resolved = await dataContext.withDataContext(adminContext(), (scopedDb) =>
      repository.resolveModelForCapability(scopedDb, "chat", "interactive")
    );

    expect(putRes.statusCode).toBe(200);
    expect(resolved).toMatchObject({ reason: "manual-route", model: { id: boundId } });
    expect(resolved.model?.id).not.toBe(activeChatId);
  });

  // Seed the retired ai.capability_routes instance-settings key directly (never written by app code
  // anymore) via the bootstrap role to bypass RLS — mimics an upgraded instance's leftover artifact.
  async function writeLegacyRoutes(routes: Record<string, string | null>): Promise<void> {
    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      await client.query(
        `
          INSERT INTO app.instance_settings (key, value, updated_by_user_id, created_at, updated_at)
          VALUES ($1, $2::jsonb, $3, now(), now())
          ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()
        `,
        [LEGACY_KEY, JSON.stringify(routes), ids.adminUser]
      );
    } finally {
      await client.end();
    }
  }

  async function seedProvider(displayName: string): Promise<string> {
    const response = await server.inject({
      method: "POST",
      url: "/api/ai/providers",
      headers: { authorization: `Bearer ${ids.sessionAdmin}` },
      payload: {
        providerKind: "anthropic",
        displayName,
        credentialPayload: { apiKey: "legacy-routes-secret" }
      }
    });
    expect(response.statusCode).toBe(201);
    return response.json<{ provider: { id: string } }>().provider.id;
  }

  async function seedModel(
    providerModelId: string,
    capabilities: readonly string[],
    tier: string
  ): Promise<string> {
    const response = await server.inject({
      method: "POST",
      url: "/api/ai/models",
      headers: { authorization: `Bearer ${ids.sessionAdmin}` },
      payload: {
        providerConfigId: providerId,
        providerModelId,
        displayName: providerModelId,
        capabilities,
        tier
      }
    });
    expect(response.statusCode).toBe(201);
    return response.json<{ model: { id: string } }>().model.id;
  }
});
