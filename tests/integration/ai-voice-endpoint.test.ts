import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import pg from "pg";

import { createApiServer } from "../../apps/api/src/server.js";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import { AiRepository, createAiSecretCipher, createConfiguredTranscription } from "@moss/ai";
import { DataContextRunner, createDatabase, type AccessContext, type MossDatabase } from "@moss/db";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const { Client } = pg;

// #874 — the dedicated Voice (STT) admin endpoint. These tests pin down the invariants that keep the
// voice endpoint isolated from the assistant (chat) provider surface — the ones a naive refactor
// would silently break:
//   (a) save round-trips base URL + model; the key is write-only and omit-means-keep;
//   (b) an un-pinned user's transcription resolves against the voice endpoint;
//   (c) no endpoint → transcription unavailable (mic disabled, not hidden — a reason is still emitted);
//   (d) the voice row is excluded from chat resolution AND the instance-default candidate set;
//   (e) an assistant provider is never used as a voice source, and the voice create path runs NO
//       discovery (CRIT-1) — the voice row gets exactly one transcription model, never a chat model;
//   (f) a pinned user's audio stays inside the pinned provider → unavailable, never escaping to the
//       instance voice endpoint (HIGH-3);
//   (g) repeated PUTs / a retried create still leave exactly one `purpose='voice'` row (HIGH-5);
//   (h) every voice route is admin-gated — a non-admin gets 403 on GET and PUT (#886 MED-1);
//   (i) the generic provider/model routes refuse the hidden voice row by id (#886 MED-2);
//   (j) a re-PUT reactivates a tombstoned endpoint, and omit-`enabled` keeps a disabled one disabled.
// No test here drives the actual STT POST (that lives in ai-transcription.test.ts, which stubs
// `fetch`); these exercise config + resolution only, so no network call fires.
describe("AI Voice (STT) endpoint (#874)", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let repository: AiRepository;
  let server: ReturnType<typeof createApiServer>;
  let boss: PgBoss;
  let originalSecretKey: string | undefined;

  beforeAll(async () => {
    // Stable key so the omit-means-keep test can decrypt the stored credential and compare it.
    originalSecretKey = process.env.JARVIS_AI_SECRET_KEY;
    process.env.JARVIS_AI_SECRET_KEY = "test-ai-voice-endpoint-secret";

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
  });

  afterAll(async () => {
    await Promise.allSettled([server?.close(), appDb?.destroy(), boss?.stop({ graceful: false })]);
    if (originalSecretKey === undefined) {
      delete process.env.JARVIS_AI_SECRET_KEY;
    } else {
      process.env.JARVIS_AI_SECRET_KEY = originalSecretKey;
    }
  });

  // Each (a)-(g) case is independent: wipe the AI provider/model tables, clear any admin pin, and drop
  // the AI instance-settings (bindings / instance-default live there). The two pin keys live in
  // app.preferences; bindings + the default flag are on ai_provider_configs (a column) / instance
  // settings — truncating the tables clears the flag, the DELETEs clear the rest.
  beforeEach(async () => {
    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      await client.query(
        `TRUNCATE app.ai_configured_models, app.ai_provider_configs RESTART IDENTITY CASCADE`
      );
      await client.query(
        `DELETE FROM app.preferences WHERE key IN ('ai.admin_pinned_model_id', 'ai.admin_pinned_provider_id')`
      );
      await client.query(`DELETE FROM app.instance_settings WHERE key LIKE 'ai.%'`);
    } finally {
      await client.end();
    }
  });

  it("(a) round-trips base URL + model, never returns the key, and keeps the key when omitted", async () => {
    const created = await putVoice({
      baseUrl: "https://voice.example",
      modelName: "whisper-1",
      apiKey: "sk-first-key"
    });
    expect(created.statusCode).toBe(200);
    // The API key is write-only: it must not appear anywhere in the response — not as plaintext,
    // not as ciphertext, not as the raw column name.
    expect(created.body).not.toContain("sk-first-key");
    expect(created.body).not.toContain("ciphertext");
    expect(created.body).not.toContain("encrypted_credential");
    expect(created.json()).toMatchObject({
      endpoint: {
        configured: true,
        enabled: true,
        baseUrl: "https://voice.example",
        modelName: "whisper-1",
        hasKey: true
      }
    });
    // The DTO carries hasKey but never the key/apiKey field itself.
    expect(created.json().endpoint).not.toHaveProperty("apiKey");
    expect(created.json().endpoint).not.toHaveProperty("key");

    const afterCreate = await getVoice();
    expect(afterCreate.json()).toMatchObject({
      endpoint: {
        configured: true,
        baseUrl: "https://voice.example",
        modelName: "whisper-1",
        hasKey: true
      }
    });

    // Edit the model name WITHOUT sending a key → the stored credential must be untouched.
    const edited = await putVoice({
      baseUrl: "https://voice.example",
      modelName: "whisper-large-v3"
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json()).toMatchObject({
      endpoint: { modelName: "whisper-large-v3", hasKey: true }
    });

    const stored = await voiceProviderRow();
    const cipher = createAiSecretCipher();
    const decrypted = cipher.decryptJson(cipher.parseEnvelope(stored!.encrypted_credential));
    expect(decrypted).toEqual({ apiKey: "sk-first-key" });
  });

  it("(b) resolves transcription against the voice endpoint for an un-pinned user", async () => {
    await putVoice({
      baseUrl: "https://voice.example",
      modelName: "parakeet-ctc",
      apiKey: "sk-voice"
    });

    const resolved = await resolveTranscription(ids.userB);
    expect(resolved.reason).toBe("manual-route");
    expect(resolved.model?.provider_model_id).toBe("parakeet-ctc");
  });

  it("transports vocabulary through actual legacy and pinned resolver paths", async () => {
    await putVoice({
      baseUrl: "https://legacy.invalid",
      modelName: "legacy-asr",
      apiKey: "synthetic-key"
    });
    const requests: { url: string; form: FormData }[] = [];
    const runtime = createConfiguredTranscription({
      dataContext,
      repository,
      fetch: async (url, options) => {
        requests.push({ url: String(url), form: options!.body as FormData });
        return new Response(
          JSON.stringify({
            text: "Ignored hints accepted",
            segments: [{ start: 0, end: 0.1, text: "Ignored hints accepted" }]
          })
        );
      }
    });
    async function send() {
      const actor = ctx(ids.userB);
      const selected = await runtime.availability(actor);
      await runtime.transcribe(actor, {
        audio: new Uint8Array([1, 2, 3]),
        language: "en",
        prompt: "Moss, Vocci",
        signal: new AbortController().signal,
        expectedModelRoute: selected.modelRoute!,
        dispatch: async (send, validate) => {
          await dataContext.withDataContext(actor, async (db) => validate?.(db));
          return send();
        }
      });
    }
    await send();
    const providerId = await seedAssistantProvider("Pinned vocabulary provider");
    await seedAssistantModel(providerId, "pinned-asr", ["transcription"]);
    await setProviderPin(ids.userB, providerId);
    await send();
    expect(requests).toHaveLength(2);
    expect(requests[0]!.url).toBe("https://legacy.invalid/v1/audio/transcriptions");
    expect(requests.map((request) => request.form.get("model"))).toEqual([
      "legacy-asr",
      "pinned-asr"
    ]);
    for (const request of requests) {
      expect(request.form.get("language")).toBe("en");
      expect(request.form.get("prompt")).toBe("Moss, Vocci");
    }
  });

  it("(c) reports transcription unavailable with a reason when no voice endpoint is configured", async () => {
    // Resolver: no voice row → needs-config (never a silent success, so the mic can render a
    // disabled-with-tooltip state rather than vanishing).
    const resolved = await resolveTranscription(ids.userB);
    expect(resolved).toMatchObject({ model: null, reason: "needs-config" });

    const lookup = await server.inject({
      method: "GET",
      url: "/api/ai/capability-route/transcription",
      headers: { authorization: `Bearer ${ids.sessionB}` }
    });
    expect(lookup.statusCode).toBe(200);
    expect(lookup.json()).toMatchObject({
      route: { capability: "transcription", available: false, reason: "needs-config" }
    });
  });

  it("(d) excludes the voice row from chat resolution + the instance-default set and rejects it as default", async () => {
    // One assistant provider (admin-owned, active) → the implicit chat instance-default.
    const assistantProviderId = await seedAssistantProvider("Chat Backend");
    const chatModelId = await seedAssistantModel(assistantProviderId, "gpt-chat", ["chat"]);
    await putVoice({
      baseUrl: "https://voice.example",
      modelName: "whisper-1",
      apiKey: "sk-voice"
    });

    const voiceProviderId = (await voiceProviderRow())!.id;

    // Chat resolves inside the assistant provider (unbound → implicit instance-default →
    // "matched-active-model") — the voice row is invisible to chat resolution.
    const chat = await resolveChat(ids.userB);
    expect(chat.reason).toBe("matched-active-model");
    expect(chat.model?.id).toBe(chatModelId);
    expect(chat.model?.provider_config_id).toBe(assistantProviderId);

    // HIGH-4: the instance-default count stays 1 (assistant only) even though a voice row now exists —
    // otherwise adding voice would flip 1→2 and cause a chat needs-config outage.
    const defaultProviderId = await dataContext.withDataContext(ctx(ids.adminUser), (scopedDb) =>
      repository.resolveDefaultProviderId(scopedDb)
    );
    expect(defaultProviderId).toBe(assistantProviderId);

    // The admin Providers list is assistant-only → never surfaces the voice row.
    const providers = await dataContext.withDataContext(ctx(ids.adminUser), (scopedDb) =>
      repository.listProviders(scopedDb)
    );
    expect(providers.some((p) => p.id === voiceProviderId)).toBe(false);
    expect(providers.every((p) => p.purpose === "assistant")).toBe(true);

    // setInstanceDefaultProvider must reject a voice id → 404 at the route.
    const promote = await server.inject({
      method: "PUT",
      url: `/api/ai/providers/${voiceProviderId}/default`,
      headers: { authorization: `Bearer ${ids.sessionAdmin}` }
    });
    expect(promote.statusCode).toBe(404);
  });

  it("(e) never sources voice from an assistant provider and runs no discovery on the voice create path", async () => {
    // An assistant provider that HAPPENS to have a transcription-capable model — a tempting but wrong
    // voice source. The voice branch must ignore it entirely.
    const assistantProviderId = await seedAssistantProvider("Assistant With Audio");
    await seedAssistantModel(assistantProviderId, "assistant-whisper", ["chat", "transcription"]);

    await putVoice({
      baseUrl: "https://voice.example",
      modelName: "dedicated-whisper",
      apiKey: "sk-voice"
    });
    const voiceProviderId = (await voiceProviderRow())!.id;

    // Transcription resolves to the DEDICATED voice provider, not the assistant's transcription model.
    const resolved = await resolveTranscription(ids.userB);
    expect(resolved.reason).toBe("manual-route");
    expect(resolved.model?.provider_config_id).toBe(voiceProviderId);
    expect(resolved.model?.provider_model_id).toBe("dedicated-whisper");

    // CRIT-1: the voice create path runs NO auto-discovery. The voice provider has exactly ONE model,
    // capabilities are precisely ['transcription'], and it never gains a chat model.
    const voiceModels = await voiceModelRows(voiceProviderId);
    expect(voiceModels).toHaveLength(1);
    expect(voiceModels[0]!.capabilities).toEqual(["transcription"]);
    expect(voiceModels.some((m) => (m.capabilities as string[]).includes("chat"))).toBe(false);
  });

  it("(f) keeps a pinned user's transcription inside the pinned provider, never escaping to voice", async () => {
    // Pin userB to an assistant provider that CANNOT serve voice (chat model only). A voice endpoint
    // exists — but the pinned user's audio must not reach it.
    const assistantProviderId = await seedAssistantProvider("Pinned Chat-only Backend");
    await seedAssistantModel(assistantProviderId, "pin-chat", ["chat"]);
    await putVoice({
      baseUrl: "https://voice.example",
      modelName: "whisper-1",
      apiKey: "sk-voice"
    });

    await setProviderPin(ids.userB, assistantProviderId);

    // HIGH-3: pinned user whose provider can't serve voice → admin-pin-unavailable, NOT the endpoint.
    const pinned = await resolveTranscription(ids.userB);
    expect(pinned).toMatchObject({ model: null, reason: "admin-pin-unavailable" });

    // Control: an un-pinned user DOES reach the voice endpoint (proves the block is pin-specific).
    const unpinned = await resolveTranscription(ids.userA);
    expect(unpinned.reason).toBe("manual-route");
    expect(unpinned.model?.provider_model_id).toBe("whisper-1");
  });

  it("(g) leaves exactly one voice row after repeated PUTs / a retried create", async () => {
    const first = await putVoice({
      baseUrl: "https://voice.example",
      modelName: "whisper-1",
      apiKey: "sk-voice"
    });
    const second = await putVoice({
      baseUrl: "https://voice2.example",
      modelName: "whisper-2",
      apiKey: "sk-voice-2"
    });
    const third = await putVoice({ baseUrl: "https://voice2.example", modelName: "whisper-2" });
    expect([first.statusCode, second.statusCode, third.statusCode]).toEqual([200, 200, 200]);

    expect(await countVoiceProviders()).toBe(1);
    const voiceProviderId = (await voiceProviderRow())!.id;
    expect(await voiceModelRows(voiceProviderId)).toHaveLength(1);
  });

  it("(h) MED-1: rejects a non-admin on both GET and PUT (403)", async () => {
    // Every voice route is admin-gated. This guards against a refactor dropping assertInstanceAdmin:
    // a non-admin (sessionB) must never read baseUrl/hasKey nor rewrite the instance STT target/key.
    const getRes = await server.inject({
      method: "GET",
      url: "/api/ai/voice-endpoint",
      headers: { authorization: `Bearer ${ids.sessionB}` }
    });
    expect(getRes.statusCode).toBe(403);

    const putRes = await server.inject({
      method: "PUT",
      url: "/api/ai/voice-endpoint",
      headers: { authorization: `Bearer ${ids.sessionB}` },
      payload: { baseUrl: "https://evil.example", modelName: "whisper-1", apiKey: "sk-attacker" }
    });
    expect(putRes.statusCode).toBe(403);
    // The blocked PUT wrote nothing — no voice row was created.
    expect(await countVoiceProviders()).toBe(0);
  });

  it("(i) MED-2: the generic provider/model routes refuse the hidden voice row by id", async () => {
    // An admin can learn the voice UUID (it leaks as providerConfigId on the transcription
    // capability-route). The generic write routes must still treat it as absent so the STT row can't
    // be mutated, revoked, model-stuffed, or probed from that surface.
    await putVoice({
      baseUrl: "https://voice.example",
      modelName: "whisper-1",
      apiKey: "sk-voice"
    });
    const voiceProviderId = (await voiceProviderRow())!.id;
    const admin = { authorization: `Bearer ${ids.sessionAdmin}` };

    const patched = await server.inject({
      method: "PATCH",
      url: `/api/ai/providers/${voiceProviderId}`,
      headers: admin,
      payload: { displayName: "hijacked" }
    });
    expect(patched.statusCode).toBe(404);

    const revoked = await server.inject({
      method: "POST",
      url: `/api/ai/providers/${voiceProviderId}/revoke`,
      headers: admin
    });
    expect(revoked.statusCode).toBe(404);

    const createdModel = await server.inject({
      method: "POST",
      url: "/api/ai/models",
      headers: admin,
      payload: {
        providerConfigId: voiceProviderId,
        providerModelId: "sneaky",
        displayName: "Sneaky",
        capabilities: ["transcription"]
      }
    });
    expect(createdModel.statusCode).toBe(404);

    // The discovery/test probe must never fire a live call at the STT host.
    const discovered = await server.inject({
      method: "GET",
      url: `/api/ai/providers/${voiceProviderId}/models/discover`,
      headers: admin
    });
    expect(discovered.statusCode).toBe(404);

    // Every attack was a no-op: still one voice row with its single transcription model, untouched.
    expect(await countVoiceProviders()).toBe(1);
    expect(await voiceModelRows(voiceProviderId)).toHaveLength(1);
    const row = await voiceProviderStatusRow();
    expect(row).toMatchObject({
      status: "active",
      revoked_at: null,
      display_name: "Voice (STT) endpoint"
    });
  });

  it("(j) MED-2: a re-PUT reactivates a tombstoned endpoint; omit-`enabled` keeps a disabled one disabled", async () => {
    await putVoice({
      baseUrl: "https://voice.example",
      modelName: "whisper-1",
      apiKey: "sk-voice"
    });

    // Simulate a legacy tombstone (the 0013 CHECK pairs status='revoked' with revoked_at NOT NULL).
    await tombstoneVoiceRow();
    expect(await voiceProviderStatusRow()).toMatchObject({ status: "revoked" });

    // Re-PUT with NO enabled flag must reactivate: clearing revoked_at forces status off 'revoked'.
    const reactivated = await putVoice({
      baseUrl: "https://voice.example",
      modelName: "whisper-1"
    });
    expect(reactivated.statusCode).toBe(200);
    expect(await voiceProviderStatusRow()).toMatchObject({ status: "active", revoked_at: null });

    // Now deliberately disable, then edit WITHOUT sending enabled — omit-means-keep leaves it disabled.
    await putVoice({ baseUrl: "https://voice.example", modelName: "whisper-1", enabled: false });
    expect(await voiceProviderStatusRow()).toMatchObject({ status: "disabled", revoked_at: null });

    const editedName = await putVoice({
      baseUrl: "https://voice.example",
      modelName: "whisper-large"
    });
    expect(editedName.statusCode).toBe(200);
    const afterEdit = await getVoice();
    expect(afterEdit.json().endpoint).toMatchObject({ enabled: false, modelName: "whisper-large" });
    expect(await voiceProviderStatusRow()).toMatchObject({ status: "disabled" });
  });

  it("selects a configured provider for all unpinned users without changing chat or the legacy endpoint", async () => {
    await putVoice({
      baseUrl: "https://legacy.example",
      modelName: "legacy-asr",
      apiKey: "legacy-key"
    });
    const before = await voiceProviderRow();
    const providerId = await seedAssistantProvider("Selected transcription");
    const modelId = await seedAssistantModel(providerId, "selected-asr", ["transcription"]);
    const chatBefore = await resolveChat(ids.userA);
    expect((await bindTranscription(modelId)).statusCode).toBe(200);
    for (const user of [ids.userA, ids.userB]) {
      expect((await resolveTranscription(user)).model?.id).toBe(modelId);
    }
    expect(await resolveChat(ids.userA)).toEqual(chatBefore);
    expect(await voiceProviderRow()).toEqual(before);
    const listed = await server.inject({
      url: "/api/ai/service-bindings",
      headers: { authorization: `Bearer ${ids.sessionAdmin}` }
    });
    expect(listed.json().bindings.transcription).toEqual({ kind: "model", modelId });
    expect(listed.body).not.toContain("legacy-key");
    expect((await clearTranscription()).statusCode).toBe(200);
    expect((await resolveTranscription(ids.userB)).model?.provider_model_id).toBe("legacy-asr");
    expect(await voiceProviderRow()).toEqual(before);
  });

  it("does not resurrect old transcription bindings or capability routes on upgrade", async () => {
    await putVoice({
      baseUrl: "https://legacy.example",
      modelName: "legacy-asr",
      apiKey: "legacy-key"
    });
    const providerId = await seedAssistantProvider("Old transcription binding");
    const modelId = await seedAssistantModel(providerId, "old-asr", ["transcription"]);
    await dataContext.withDataContext(ctx(ids.adminUser), async (db) => {
      await db.db
        .insertInto("app.instance_settings")
        .values({
          key: "ai.service_bindings",
          value: { transcription: { kind: "model", modelId } },
          updated_by_user_id: ids.adminUser
        })
        .execute();
      await db.db
        .insertInto("app.instance_settings")
        .values({
          key: "ai.capability_routes",
          value: { transcription: modelId },
          updated_by_user_id: ids.adminUser
        })
        .execute();
    });
    expect((await resolveTranscription(ids.userB)).model?.provider_model_id).toBe("legacy-asr");
    expect((await bindTranscription(modelId)).statusCode).toBe(200);
    expect((await resolveTranscription(ids.userB)).model?.id).toBe(modelId);
    expect((await clearTranscription()).statusCode).toBe(200);
    expect((await resolveTranscription(ids.userB)).model?.provider_model_id).toBe("legacy-asr");
  });

  it("does not fall back when the selected model becomes unavailable and retains pin precedence", async () => {
    await putVoice({
      baseUrl: "https://legacy.example",
      modelName: "legacy-asr",
      apiKey: "legacy-key"
    });
    const selectedProvider = await seedAssistantProvider("Selected transcription");
    const selectedModel = await seedAssistantModel(selectedProvider, "selected-asr", [
      "transcription"
    ]);
    expect((await bindTranscription(selectedModel)).statusCode).toBe(200);
    const pinnedProvider = await seedAssistantProvider("Pinned chat");
    await seedAssistantModel(pinnedProvider, "pinned-chat", ["chat"]);
    await setProviderPin(ids.userB, pinnedProvider);
    expect(await resolveTranscription(ids.userB)).toMatchObject({
      model: null,
      reason: "admin-pin-unavailable"
    });
    await dataContext.withDataContext(ctx(ids.adminUser), async (db) => {
      await db.db
        .updateTable("app.ai_configured_models")
        .set({ status: "disabled" })
        .where("id", "=", selectedModel)
        .execute();
    });
    expect(await resolveTranscription(ids.userA)).toMatchObject({
      model: null,
      reason: "needs-config"
    });
    expect((await clearTranscription()).statusCode).toBe(200);
    expect((await resolveTranscription(ids.userA)).model?.provider_model_id).toBe("legacy-asr");
  });

  it("rejects non-admin selection/clearing and incompatible provider selections", async () => {
    const providerId = await seedAssistantProvider("Selected transcription");
    const modelId = await seedAssistantModel(providerId, "selected-asr", ["transcription"]);
    expect((await bindTranscription(modelId, ids.sessionB)).statusCode).toBe(403);
    expect((await clearTranscription(ids.sessionB)).statusCode).toBe(403);
    const chatId = await seedAssistantModel(providerId, "chat-only", ["chat"]);
    expect((await bindTranscription(chatId)).statusCode).toBe(400);
    expect((await bindTranscription(randomUUID())).statusCode).toBe(400);
    expect((await bindTranscription(modelId)).statusCode).toBe(200);
    const encrypted = createAiSecretCipher().encryptJson({ apiKey: "fixture-selection-key" });
    for (const patch of [
      { provider_kind: "anthropic" as const },
      { auth_method: "cli" as const, acp_agent_id: "codex-acp" },
      { status: "disabled" as const },
      { status: "revoked" as const, revoked_at: new Date() }
    ]) {
      await dataContext.withDataContext(ctx(ids.adminUser), async (db) => {
        await db.db
          .updateTable("app.ai_provider_configs")
          .set({
            provider_kind: "openai-compatible",
            auth_method: "api_key",
            acp_agent_id: null,
            status: "active",
            revoked_at: null,
            encrypted_credential: encrypted,
            ...patch
          })
          .where("id", "=", providerId)
          .execute();
      });
      expect((await bindTranscription(modelId)).statusCode).toBe(400);
      expect(await resolveTranscription(ids.userA)).toMatchObject({
        model: null,
        reason: "needs-config"
      });
    }
  });

  it("rejects selection with a missing API key and fails closed if a selected key is cleared", async () => {
    const providerId = await seedAssistantProvider("Selected transcription");
    const modelId = await seedAssistantModel(providerId, "selected-asr", ["transcription"]);
    expect((await bindTranscription(modelId)).statusCode).toBe(200);
    const cleared = await server.inject({
      method: "PATCH",
      url: `/api/ai/providers/${providerId}`,
      headers: { authorization: `Bearer ${ids.sessionAdmin}` },
      payload: { credentialPayload: {} }
    });
    expect(cleared.statusCode).toBe(200);
    expect((await bindTranscription(modelId)).statusCode).toBe(400);
    const transcription = await server.inject({
      method: "POST",
      url: "/api/ai/transcriptions",
      headers: { authorization: `Bearer ${ids.sessionB}`, "content-type": "audio/wav" },
      payload: Buffer.from([1, 2, 3])
    });
    expect(transcription.statusCode).toBe(422);
  });

  function bindTranscription(modelId: string, session: string = ids.sessionAdmin) {
    return server.inject({
      method: "PUT",
      url: "/api/ai/services/transcription/binding",
      headers: { authorization: `Bearer ${session}` },
      payload: { binding: { kind: "model", modelId } }
    });
  }
  function clearTranscription(session: string = ids.sessionAdmin) {
    return server.inject({
      method: "DELETE",
      url: "/api/ai/services/transcription/binding",
      headers: { authorization: `Bearer ${session}` }
    });
  }

  // ---- helpers -------------------------------------------------------------------------------------

  function putVoice(payload: {
    baseUrl: string;
    modelName: string;
    apiKey?: string;
    enabled?: boolean;
  }) {
    return server.inject({
      method: "PUT",
      url: "/api/ai/voice-endpoint",
      headers: { authorization: `Bearer ${ids.sessionAdmin}` },
      payload
    });
  }

  function getVoice() {
    return server.inject({
      method: "GET",
      url: "/api/ai/voice-endpoint",
      headers: { authorization: `Bearer ${ids.sessionAdmin}` }
    });
  }

  function resolveTranscription(userId: string) {
    return dataContext.withDataContext(ctx(userId), (scopedDb) =>
      repository.resolveModelForCapability(scopedDb, "transcription", "interactive")
    );
  }

  function resolveChat(userId: string) {
    return dataContext.withDataContext(ctx(userId), (scopedDb) =>
      repository.resolveModelForCapability(scopedDb, "chat", "interactive")
    );
  }

  async function setProviderPin(userId: string, providerId: string): Promise<void> {
    const res = await server.inject({
      method: "PUT",
      url: `/api/admin/users/${userId}/ai-pin`,
      headers: { authorization: `Bearer ${ids.sessionAdmin}` },
      payload: { providerId }
    });
    expect(res.statusCode).toBe(200);
  }

  async function seedAssistantProvider(displayName: string): Promise<string> {
    const id = randomUUID();
    // Admin-owned + active so it counts as the implicit instance-default candidate (HIGH-4 check in d).
    const credential = createAiSecretCipher().encryptJson({ apiKey: `assistant-secret-${id}` });
    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      await client.query(
        `
          INSERT INTO app.ai_provider_configs (
            id, owner_user_id, provider_kind, display_name, status, auth_method, encrypted_credential, purpose
          )
          VALUES ($1, $2, 'openai-compatible', $3, 'active', 'api_key', $4::jsonb, 'assistant')
        `,
        [id, ids.adminUser, displayName, JSON.stringify(credential)]
      );
    } finally {
      await client.end();
    }
    return id;
  }

  async function seedAssistantModel(
    providerConfigId: string,
    providerModelId: string,
    capabilities: readonly ("chat" | "json" | "transcription" | "summarization")[]
  ): Promise<string> {
    const id = randomUUID();
    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      await client.query(
        `
          INSERT INTO app.ai_configured_models (
            id, provider_config_id, owner_user_id, provider_model_id, display_name,
            capabilities, status, tier, allow_user_override
          )
          VALUES ($1, $2, $3, $4, $4, $5::text[], 'active', 'interactive', true)
        `,
        [id, providerConfigId, ids.adminUser, providerModelId, capabilities]
      );
    } finally {
      await client.end();
    }
    return id;
  }

  async function voiceProviderRow(): Promise<{ id: string; encrypted_credential: unknown } | null> {
    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      const { rows } = await client.query(
        `SELECT id, encrypted_credential FROM app.ai_provider_configs WHERE purpose = 'voice'`
      );
      return rows[0] ?? null;
    } finally {
      await client.end();
    }
  }

  async function voiceProviderStatusRow(): Promise<{
    status: string;
    revoked_at: Date | null;
    display_name: string;
  } | null> {
    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      const { rows } = await client.query(
        `SELECT status, revoked_at, display_name FROM app.ai_provider_configs WHERE purpose = 'voice'`
      );
      return rows[0] ?? null;
    } finally {
      await client.end();
    }
  }

  // Force the voice row into the legacy revoked state (status + revoked_at move together per the 0013
  // CHECK) so the reactivation-on-re-PUT path (#886 MED-2) can be exercised.
  async function tombstoneVoiceRow(): Promise<void> {
    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      await client.query(
        `UPDATE app.ai_provider_configs SET status = 'revoked', revoked_at = now() WHERE purpose = 'voice'`
      );
    } finally {
      await client.end();
    }
  }

  async function voiceModelRows(providerConfigId: string): Promise<{ capabilities: string[] }[]> {
    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      const { rows } = await client.query(
        `SELECT capabilities FROM app.ai_configured_models WHERE provider_config_id = $1`,
        [providerConfigId]
      );
      return rows;
    } finally {
      await client.end();
    }
  }

  async function countVoiceProviders(): Promise<number> {
    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM app.ai_provider_configs WHERE purpose = 'voice'`
      );
      return rows[0].n;
    } finally {
      await client.end();
    }
  }
});

function ctx(userId: string): AccessContext {
  return { actorUserId: userId, requestId: `request:${userId}-ai-voice-endpoint` };
}
