import Fastify from "fastify";
import pg from "pg";
import { createDatabase, getMossDatabaseUrls } from "@moss/db";
import { createApiServer } from "../../../apps/api/src/server.js";
import { createPgBossClient, assertModuleJobPayload } from "@moss/jobs";
import { assertRouteCoverage } from "../../../packages/module-registry/src/route-guard.js";
import { buildAppMap } from "../../../scripts/build-app-map.js";
import { HttpApiAdapter } from "../../../packages/ai/src/adapters/http-api.js";
import type { ExternalModuleQueueDeclaration, MossModuleManifest } from "@moss/module-sdk";
import type { ChatTurn } from "../../../packages/ai/src/chat-adapter.js";
import type { ProviderKind } from "../../../packages/ai/src/adapters/transcript-reader.js";

type Model = {
  id: string;
  providerId: string;
  providerModelId: string;
  capabilities: string[];
  tier: string;
  active: boolean;
  providerActive: boolean;
  assistant: boolean;
  automaticEligible: boolean;
  defaultSentinel: boolean;
  sharedTranscriptionEligible: boolean;
  voiceEndpoint: boolean;
  releasedAt: string | null;
  createdAt: string;
  allowUserOverride?: boolean;
};
export type Configuration = {
  providers?: { id: string; active: boolean; assistant: boolean; adminOwned: boolean }[];
  models: Model[];
  pinnedModel: string | null;
  pinnedProvider: string | null;
  defaultProvider: string | null;
  chatBinding: unknown;
  transcriptionBinding: unknown;
  chatOverride: string | null;
  overrideEnabled?: boolean;
};
export async function startReference(port: number, apiPort: number) {
  if (process.env.JARVIS_GATE_RUN !== "1") throw new Error("verify-gate required");
  const urls = getMossDatabaseUrls();
  const seed = new pg.Client({ connectionString: urls.bootstrap });
  await seed.connect();
  for (let n = 1; n <= 3; n++) {
    const user = `00000000-0000-4000-8000-00000000000${n}`;
    await seed.query(
      "INSERT INTO app.users(id,email,is_instance_admin) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING",
      [user, `fixture-${n}@example.test`, n === 3]
    );
    await seed.query(
      "INSERT INTO app.auth_sessions(id,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour') ON CONFLICT(id) DO UPDATE SET expires_at=excluded.expires_at",
      [`40000000-0000-4000-8000-00000000000${n}`, user]
    );
  }
  const appDb = createDatabase({ connectionString: urls.app, maxConnections: 3 });
  const boss = createPgBossClient(urls.app);
  const api = createApiServer({ appDb, boss, logger: false });
  await api.listen({ host: "127.0.0.1", port: apiPort });
  const server = Fastify({ logger: false, bodyLimit: 8 * 1024 * 1024 });
  server.get("/health", async () => ({ ok: true }));
  server.post<{ Body: { actor: string; config: Configuration } }>(
    "/probe/configure",
    async (req) => {
      const { actor, config } = req.body;
      const admin = "00000000-0000-4000-8000-000000000003";
      await seed.query(
        "DELETE FROM app.preferences WHERE key IN ('ai.admin_pinned_model_id','ai.admin_pinned_provider_id','chat.modelOverride') AND owner_user_id=$1",
        [actor]
      );
      await seed.query("DELETE FROM app.ai_configured_models");
      await seed.query("DELETE FROM app.ai_provider_configs");
      const providers = new Map(config.models.map((m) => [m.providerId, m]));
      for (const [id, m] of providers) {
        await seed.query(
          "INSERT INTO app.ai_provider_configs(id,owner_user_id,provider_kind,display_name,status,encrypted_credential,purpose,is_instance_default,auth_method) VALUES($1,$2,$3,'fixture',$4,'{}'::jsonb,$5,$6,'api_key')",
          [
            id,
            admin,
            m.automaticEligible ? "openai-compatible" : "system-one",
            m.providerActive ? "active" : "disabled",
            m.voiceEndpoint ? "voice" : "assistant",
            id === config.defaultProvider
          ]
        );
      }
      for (const m of config.models) {
        await seed.query(
          "INSERT INTO app.ai_configured_models(id,provider_config_id,owner_user_id,provider_model_id,display_name,capabilities,tier,status,allow_user_override,created_at,released_at) VALUES($1,$2,$3,$4,'fixture',$5,$6,$7,$8,$9,$10)",
          [
            m.id,
            m.providerId,
            admin,
            m.providerModelId,
            m.capabilities,
            m.tier,
            m.active ? "active" : "disabled",
            m.allowUserOverride ?? false,
            m.createdAt,
            m.releasedAt
          ]
        );
      }
      for (const [key, value] of [
        ["ai.admin_pinned_model_id", config.pinnedModel],
        ["ai.admin_pinned_provider_id", config.pinnedProvider],
        ["chat.modelOverride", config.chatOverride]
      ] as const) {
        if (value !== null)
          await seed.query(
            "INSERT INTO app.preferences(owner_user_id,key,value_json) VALUES($1,$2,$3::jsonb)",
            [actor, key, JSON.stringify(value)]
          );
      }
      const bindings: Record<string, unknown> = {};
      if (config.chatBinding) bindings.chat = config.chatBinding;
      if (config.transcriptionBinding)
        bindings["voice.transcription"] = config.transcriptionBinding;
      for (const [key, value] of [
        ["ai.service_bindings", bindings],
        ["ai.capability_routes", {}],
        ["ai.chat_model_override.enabled", { value: config.overrideEnabled ?? false }]
      ] as const) {
        await seed.query(
          "INSERT INTO app.instance_settings(key,value,updated_by_user_id) VALUES($1,$2::jsonb,$3) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          [key, JSON.stringify(value), admin]
        );
      }
      return { configured: true };
    }
  );
  server.post<{ Body: { queue: ExternalModuleQueueDeclaration; payload: unknown } }>(
    "/probe/payload",
    async (req) => {
      try {
        assertModuleJobPayload(req.body.queue, req.body.payload);
        return { accepted: true };
      } catch {
        return { accepted: false };
      }
    }
  );
  server.post<{
    Body: {
      manifests: MossModuleManifest[];
      registered: { method: string; path: string }[];
      platform: string[];
    };
  }>("/probe/coverage", async (req) => {
    try {
      assertRouteCoverage({
        manifests: req.body.manifests,
        registered: req.body.registered.map((r) => ({ method: r.method, url: r.path })),
        platformAllowlist: new Set(req.body.platform)
      });
      return { accepted: true };
    } catch {
      return { accepted: false };
    }
  });
  server.post<{
    Body: {
      manifests: MossModuleManifest[];
      core: { screens: []; settings: []; errors: []; remediations: [] };
    };
  }>("/probe/app-map", async (req) =>
    buildAppMap({
      manifests: req.body.manifests,
      coreScreens: req.body.core.screens,
      coreSettings: req.body.core.settings,
      coreErrors: req.body.core.errors,
      coreRemediations: req.body.core.remediations,
      version: "test",
      buildId: "parity",
      narrative: "fixture"
    })
  );
  server.post<{
    Body: { protocol: ProviderKind; model: Model; messages: ChatTurn[]; baseUrl: string };
  }>("/probe/adapter", async (req) => {
    const { protocol, model, messages, baseUrl } = req.body;
    const adapter = new HttpApiAdapter(protocol, "TEST-NOT-A-REAL-SECRET", {
      baseUrl,
      fetch: (url, init) =>
        fetch(`${baseUrl.replace(/\/v1\/?$/, "")}${new URL(String(url)).pathname}`, init),
      onModelCall: async () => {}
    });
    try {
      return await adapter.generateChat({
        model: { provider_kind: protocol, provider_model_id: model.providerModelId },
        messages,
        maxOutputTokens: 42
      });
    } catch {
      return { error: "Transport" };
    }
  });
  await server.listen({ host: "127.0.0.1", port });
  return async () => {
    await server.close();
    await api.close();
    await boss.stop({ graceful: false });
    await appDb.destroy();
    await seed.end();
  };
}
