import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import pg from "pg";

import { createApiServer } from "../../apps/api/src/server.js";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import {
  AiRepository,
  aiModuleManifest,
  createAiSecretCipher,
  type EncryptedAiSecret
} from "@moss/ai";
import { DataContextRunner, createDatabase, type AccessContext, type MossDatabase } from "@moss/db";
import {
  getBuiltInModuleManifests,
  getBuiltInModuleRegistrations,
  getBuiltInSqlMigrationDirectories
} from "@moss/module-registry";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const { Client } = pg;

const actionRequestIds = {
  forgedForUserA: "62000000-0000-4000-8000-000000000001"
} as const;

describe("AI provider foundation", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let repository: AiRepository;
  let server: ReturnType<typeof createApiServer>;
  let boss: PgBoss;
  let originalSecretKey: string | undefined;

  beforeAll(async () => {
    originalSecretKey = process.env.JARVIS_AI_SECRET_KEY;
    process.env.JARVIS_AI_SECRET_KEY = "test-ai-secret-key";

    await resetFoundationDatabase();
    await setUserAInstanceAdmin();

    appDb = createDatabase({
      connectionString: connectionStrings.app,
      maxConnections: 1
    });
    dataContext = new DataContextRunner(appDb);
    repository = new AiRepository();
    boss = createPgBossClient(connectionStrings.app, { connectionTimeoutMillis: 25_000 }); // #1124: CI PG connect can exceed pg-boss's 10s default even on success (test-only)
    server = createApiServer({
      appDb,
      boss,
      logger: false
    });
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

  it("applies AI migrations with forced RLS and no worker table grants", async () => {
    const client = new Client({ connectionString: connectionStrings.migration });

    await client.connect();
    try {
      const migrations = await client.query<{ version: string; name: string }>(
        `
          SELECT version, name
          FROM app.schema_migrations
          WHERE version IN ('0013', '0016', '0091')
          ORDER BY version
        `
      );
      const overrideColumn = await client.query<{
        column_default: string | null;
        is_nullable: string;
      }>(
        `
          SELECT column_default, is_nullable
          FROM information_schema.columns
          WHERE table_schema = 'app'
            AND table_name = 'ai_configured_models'
            AND column_name = 'allow_user_override'
        `
      );
      const tables = await client.query<{
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
        owner: string;
        worker_has_access: boolean;
      }>(
        `
          SELECT
            c.relname,
            c.relrowsecurity,
            c.relforcerowsecurity,
            pg_get_userbyid(c.relowner) AS owner,
            (
              has_table_privilege('jarvis_worker_runtime', c.oid, 'SELECT')
              OR has_table_privilege('jarvis_worker_runtime', c.oid, 'INSERT')
              OR has_table_privilege('jarvis_worker_runtime', c.oid, 'UPDATE')
              OR has_table_privilege('jarvis_worker_runtime', c.oid, 'DELETE')
            ) AS worker_has_access
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'app'
            AND c.relname IN (
              'ai_provider_configs',
              'ai_configured_models',
              'ai_assistant_action_requests'
            )
          ORDER BY c.relname
        `
      );

      expect(migrations.rows).toEqual([
        { version: "0013", name: "0013_ai_module.sql" },
        { version: "0016", name: "0016_ai_assistant_actions.sql" },
        { version: "0091", name: "0091_chat_model_override.sql" }
      ]);
      expect(overrideColumn.rows).toEqual([
        expect.objectContaining({
          column_default: "true",
          is_nullable: "NO"
        })
      ]);
      // The chat-execution worker (jarvis_worker_runtime) resolves the active chat
      // model and reads the provider config (with encrypted credential) to make the
      // AI call, so it has SELECT on ai_configured_models + ai_provider_configs
      // (granted in 0037_ai_worker_read_grants.sql, owner-only RLS). The export worker
      // also needs SELECT on ai_assistant_action_requests to include it in a user's
      // data export (granted in 0168_worker_action_requests_grant.sql, owner-only RLS,
      // SELECT only — no worker write access).
      expect(tables.rows).toEqual([
        {
          relname: "ai_assistant_action_requests",
          relrowsecurity: true,
          relforcerowsecurity: true,
          owner: "jarvis_migration_owner",
          worker_has_access: true
        },
        {
          relname: "ai_configured_models",
          relrowsecurity: true,
          relforcerowsecurity: true,
          owner: "jarvis_migration_owner",
          worker_has_access: true
        },
        {
          relname: "ai_provider_configs",
          relrowsecurity: true,
          relforcerowsecurity: true,
          owner: "jarvis_migration_owner",
          worker_has_access: true
        }
      ]);
    } finally {
      await client.end();
    }
  });

  it("loads AI as a required built-in module", () => {
    const manifests = getBuiltInModuleManifests();
    const registration = getBuiltInModuleRegistrations().find(
      (item) => item.manifest.id === aiModuleManifest.id
    );
    const manifest = manifests.find((item) => item.id === aiModuleManifest.id);

    expect(manifests.map((item) => item.id)).toEqual([
      "settings",
      "connectors",
      "tasks",
      "jarvis.goals",
      "web",
      "notifications",
      "calendar",
      "email",
      "ai",
      "chat",
      "briefings",
      "memory",
      "usefulness-feedback",
      "structured-state",
      "wellness",
      "weather",
      "sports",
      "news",
      "notes",
      "proactive-monitoring",
      "jarvis.commitments",
      "people"
    ]);
    expect(manifest?.database?.ownedTables).toEqual([
      "app.ai_provider_configs",
      "app.ai_configured_models",
      "app.ai_assistant_action_requests",
      "app.moss_action_audit_log",
      "app.moss_error_log"
    ]);
    expect(manifest?.settings?.[0]).toMatchObject({
      id: "ai.user-settings",
      path: "/settings/ai",
      permissionId: "ai.manage"
    });
    expect(registration?.queueDefinitions.map((q) => q.name)).toEqual(["ai-purge-audit-log"]);
    expect(manifest?.routes?.map((route) => route.path)).toContain("/api/ai/assistant-actions");
    expect(manifest?.routes?.map((route) => route.path)).toContain(
      "/api/ai/assistant-actions/:id/resolve"
    );
    expect(getBuiltInSqlMigrationDirectories()).toContainEqual(
      expect.stringContaining("packages/ai/sql")
    );
  });

  it("forbids inserting an assistant action request that claims another owner", async () => {
    await expect(
      dataContext.withDataContext(userBContext(), (scopedDb) =>
        scopedDb.db
          .insertInto("app.ai_assistant_action_requests")
          .values({
            id: actionRequestIds.forgedForUserA,
            owner_user_id: ids.userA,
            tool_module_id: "tasks",
            tool_module_name: "Tasks",
            tool_name: "tasks.updateStatus",
            permission_id: "tasks.update",
            risk: "write",
            status: "pending",
            input_summary: { taskId: "forged-cross-actor" },
            request_id: "request:forged-action"
          })
          .execute()
      )
    ).rejects.toThrow(/row-level security/i);
  });

  it("requires an explicit AI secret key in production", () => {
    expect(() =>
      createAiSecretCipher({
        NODE_ENV: "production"
      })
    ).toThrow("JARVIS_AI_SECRET_KEY is required in production");
  });

  it("decrypts legacy AI secret envelope (no keyId) with current key for backward compat", () => {
    const cipher = createAiSecretCipher({ JARVIS_AI_SECRET_KEY: "test-key" });
    const encrypted = cipher.encryptJson({ apiKey: "sk-test" });
    // Strip keyId to simulate a pre-keyId envelope
    const { keyId: _omit, ...legacyEnvelope } = encrypted;
    const legacy = legacyEnvelope as EncryptedAiSecret;
    expect(cipher.decryptJson(legacy)).toEqual({ apiKey: "sk-test" });
  });

  it("decrypts old AI key envelope after rotating to a new current key", () => {
    const cipherV1 = createAiSecretCipher({
      JARVIS_AI_SECRET_KEY: "old-ai-secret",
      JARVIS_AI_SECRET_KEY_ID: "v1"
    });
    const encryptedV1 = cipherV1.encryptJson({ apiKey: "old-key" });
    expect(encryptedV1.keyId).toBe("v1");

    // Rotate: v2 is current, v1 is retired (still in keyring)
    const cipherV2 = createAiSecretCipher({
      JARVIS_AI_SECRET_KEY: "new-ai-secret",
      JARVIS_AI_SECRET_KEY_ID: "v2",
      JARVIS_AI_SECRET_KEYS: JSON.stringify({ v1: "old-ai-secret" })
    });
    // Old envelope still decrypts
    expect(cipherV2.decryptJson(encryptedV1)).toEqual({ apiKey: "old-key" });
    // New encrypt stamps v2
    const encryptedV2 = cipherV2.encryptJson({ apiKey: "new-key" });
    expect(encryptedV2.keyId).toBe("v2");
    expect(cipherV2.decryptJson(encryptedV2)).toEqual({ apiKey: "new-key" });
  });

  it("throws a named error for an unknown AI key id instead of an opaque GCM failure", () => {
    const cipher = createAiSecretCipher({ JARVIS_AI_SECRET_KEY: "test-key" });
    const envelope = cipher.encryptJson({ apiKey: "sk-secret" });
    const tampered: EncryptedAiSecret = { ...envelope, keyId: "unknown-key-xyz" };
    expect(() => cipher.decryptJson(tampered)).toThrow("Unknown AI secret key id: unknown-key-xyz");
  });

  it("encrypts provider credentials at rest and never returns secret material", async () => {
    const createResponse = await server.inject({
      method: "POST",
      url: "/api/ai/providers",
      headers: {
        authorization: `Bearer ${ids.sessionA}`
      },
      payload: {
        providerKind: "openai-compatible",
        displayName: "Local OpenAI Compatible",
        baseUrl: "https://llm.example.test/v1",
        credentialPayload: {
          apiKey: "secret-ai-api-key"
        }
      }
    });
    const provider = createResponse.json<{ provider: { id: string; hasCredential: boolean } }>()
      .provider;
    const encryptedCredential = await readEncryptedCredential(provider.id);
    const encryptedJson = JSON.stringify(encryptedCredential);
    const decrypted = createAiSecretCipher().decryptJson(encryptedCredential);
    const listResponse = await server.inject({
      method: "GET",
      url: "/api/ai/providers",
      headers: {
        authorization: `Bearer ${ids.sessionA}`
      }
    });

    expect(createResponse.statusCode).toBe(201);
    expect(provider.hasCredential).toBe(true);
    expect(createResponse.body).not.toContain("secret-ai-api-key");
    expect(createResponse.body).not.toContain("encrypted_credential");
    expect(createResponse.body).not.toContain("ciphertext");
    expect(encryptedJson).not.toContain("secret-ai-api-key");
    expect(decrypted).toEqual({
      apiKey: "secret-ai-api-key"
    });
    expect(listResponse.body).not.toContain("secret-ai-api-key");
    expect(listResponse.body).not.toContain("ciphertext");
  });

  it("exposes safe instance provider and model metadata without giving access to credentials", async () => {
    const userAProvider = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.createProvider(scopedDb, {
        providerKind: "custom",
        displayName: "Instance metadata provider",
        baseUrl: "https://instance.example.test",
        encryptedCredential: createAiSecretCipher().encryptJson({
          apiKey: "instance-ai-secret"
        })
      })
    );
    await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.createModel(scopedDb, {
        providerConfigId: userAProvider.id,
        providerModelId: "instance-model",
        displayName: "Instance model",
        capabilities: ["chat"]
      })
    );
    const userBProviders = await dataContext.withDataContext(userBContext(), (scopedDb) =>
      repository.listProviders(scopedDb)
    );
    const userBModels = await dataContext.withDataContext(userBContext(), (scopedDb) =>
      repository.listModels(scopedDb)
    );

    expect(userBProviders.some((provider) => provider.id === userAProvider.id)).toBe(true);
    expect(userBModels.some((model) => model.provider_config_id === userAProvider.id)).toBe(true);
    expect(JSON.stringify(userBProviders)).not.toContain("instance-ai-secret");
    expect(JSON.stringify(userBProviders)).not.toContain("encrypted_credential");
  });

  it("lets authenticated users read safe instance AI metadata without credentials", async () => {
    const adminProvider = await server.inject({
      method: "POST",
      url: "/api/ai/providers",
      headers: {
        authorization: `Bearer ${ids.sessionAdmin}`
      },
      payload: {
        providerKind: "anthropic",
        displayName: "Instance Provider",
        credentialPayload: {
          apiKey: "instance-secret"
        }
      }
    });
    const providerId = adminProvider.json<{ provider: { id: string } }>().provider.id;
    const adminModel = await server.inject({
      method: "POST",
      url: "/api/ai/models",
      headers: {
        authorization: `Bearer ${ids.sessionAdmin}`
      },
      payload: {
        providerConfigId: providerId,
        providerModelId: "claude-instance",
        displayName: "Claude Instance",
        capabilities: ["chat"]
      }
    });
    const modelId = adminModel.json<{ model: { id: string } }>().model.id;
    const userModels = await server.inject({
      method: "GET",
      url: "/api/ai/models",
      headers: {
        authorization: `Bearer ${ids.sessionA}`
      }
    });

    expect(adminProvider.statusCode).toBe(201);
    expect(adminModel.statusCode).toBe(201);
    expect(adminModel.json()).toMatchObject({
      model: {
        allowUserOverride: true
      }
    });
    expect(userModels.statusCode).toBe(200);
    expect(
      userModels.json<{ models: Array<{ id: string; allowUserOverride: boolean }> }>().models
    ).toContainEqual(
      expect.objectContaining({
        id: modelId,
        allowUserOverride: true
      })
    );
    expect(userModels.body).not.toContain("instance-secret");
    expect(userModels.body).not.toContain("encrypted_credential");
    expect(userModels.body).not.toContain("ciphertext");
  });

  it("requires an instance admin for AI provider and model writes", async () => {
    const providerResponse = await server.inject({
      method: "POST",
      url: "/api/ai/providers",
      headers: {
        authorization: `Bearer ${ids.sessionB}`
      },
      payload: {
        providerKind: "anthropic",
        displayName: "Member Provider",
        credentialPayload: {
          apiKey: "member-secret"
        }
      }
    });

    expect(providerResponse.statusCode).toBe(403);
  });

  it("selects an active configured model by capability without returning secrets", async () => {
    const providerResponse = await server.inject({
      method: "POST",
      url: "/api/ai/providers",
      headers: {
        authorization: `Bearer ${ids.sessionA}`
      },
      payload: {
        providerKind: "anthropic",
        displayName: "Anthropic BYO",
        credentialPayload: {
          apiKey: "capability-secret"
        }
      }
    });
    const disabledProviderResponse = await server.inject({
      method: "POST",
      url: "/api/ai/providers",
      headers: {
        authorization: `Bearer ${ids.sessionA}`
      },
      payload: {
        providerKind: "custom",
        displayName: "Disabled Provider",
        status: "disabled",
        credentialPayload: {
          apiKey: "disabled-secret"
        }
      }
    });
    const providerId = providerResponse.json<{ provider: { id: string } }>().provider.id;
    const disabledProviderId = disabledProviderResponse.json<{ provider: { id: string } }>()
      .provider.id;
    const disabledModelResponse = await server.inject({
      method: "POST",
      url: "/api/ai/models",
      headers: {
        authorization: `Bearer ${ids.sessionA}`
      },
      payload: {
        providerConfigId: disabledProviderId,
        providerModelId: "disabled-model",
        displayName: "Disabled model",
        capabilities: ["chat"],
        status: "active"
      }
    });
    const modelResponse = await server.inject({
      method: "POST",
      url: "/api/ai/models",
      headers: {
        authorization: `Bearer ${ids.sessionA}`
      },
      payload: {
        providerConfigId: providerId,
        providerModelId: "claude-3-5-haiku",
        displayName: "Haiku",
        capabilities: ["chat", "tool-use"],
        status: "active"
      }
    });
    const model = modelResponse.json<{ model: { id: string } }>().model;
    // #870 D2/D3: chat is a user-facing service — it resolves INSIDE the instance-default provider,
    // not by picking any active capable model (the retired pre-#870 behaviour). Earlier tests in this
    // file leave several admin-owned providers active, so auto-default is ambiguous (>1, none flagged);
    // explicitly flag this provider as the instance default so chat resolves to its model.
    const setDefaultResponse = await server.inject({
      method: "PUT",
      url: `/api/ai/providers/${providerId}/default`,
      headers: { authorization: `Bearer ${ids.sessionA}` }
    });
    expect(setDefaultResponse.statusCode).toBe(200);
    const routeResponse = await server.inject({
      method: "GET",
      url: "/api/ai/capability-route/chat",
      headers: {
        authorization: `Bearer ${ids.sessionA}`
      }
    });

    expect(disabledModelResponse.statusCode).toBe(201);
    expect(modelResponse.statusCode).toBe(201);
    expect(routeResponse.statusCode).toBe(200);
    expect(routeResponse.json()).toMatchObject({
      route: {
        capability: "chat",
        available: true,
        reason: "matched-active-model",
        model: {
          id: model.id,
          providerConfigId: providerId,
          providerStatus: "active",
          providerModelId: "claude-3-5-haiku"
        }
      }
    });
    expect(routeResponse.body).not.toContain("capability-secret");
    expect(routeResponse.body).not.toContain("disabled-secret");
    expect(routeResponse.body).not.toContain("ciphertext");
  });

  it("updates, deactivates, and revokes configs without leaking replacement credentials", async () => {
    const providerResponse = await server.inject({
      method: "POST",
      url: "/api/ai/providers",
      headers: {
        authorization: `Bearer ${ids.sessionA}`
      },
      payload: {
        providerKind: "google",
        displayName: "Google BYO",
        credentialPayload: {
          apiKey: "before-update"
        }
      }
    });
    const providerId = providerResponse.json<{ provider: { id: string } }>().provider.id;
    const updateProviderResponse = await server.inject({
      method: "PATCH",
      url: `/api/ai/providers/${providerId}`,
      headers: {
        authorization: `Bearer ${ids.sessionA}`
      },
      payload: {
        displayName: "Google Updated",
        status: "disabled",
        credentialPayload: {
          apiKey: "after-update"
        }
      }
    });
    const modelResponse = await server.inject({
      method: "POST",
      url: "/api/ai/models",
      headers: {
        authorization: `Bearer ${ids.sessionA}`
      },
      payload: {
        providerConfigId: providerId,
        providerModelId: "gemini-test",
        displayName: "Gemini Test",
        capabilities: ["json"],
        status: "active"
      }
    });
    const modelId = modelResponse.json<{ model: { id: string } }>().model.id;
    const updateModelResponse = await server.inject({
      method: "PATCH",
      url: `/api/ai/models/${modelId}`,
      headers: {
        authorization: `Bearer ${ids.sessionA}`
      },
      payload: {
        status: "disabled",
        capabilities: ["json", "vision"]
      }
    });
    const updatedSecret = await readEncryptedCredential(providerId);
    const revokeProviderResponse = await server.inject({
      method: "POST",
      url: `/api/ai/providers/${providerId}/revoke`,
      headers: {
        authorization: `Bearer ${ids.sessionA}`
      }
    });
    const revokedSecret = await readEncryptedCredential(providerId);

    expect(updateProviderResponse.statusCode).toBe(200);
    expect(updateProviderResponse.body).not.toContain("after-update");
    expect(updateProviderResponse.json()).toMatchObject({
      provider: {
        id: providerId,
        displayName: "Google Updated",
        status: "disabled",
        hasCredential: true
      }
    });
    expect(createAiSecretCipher().decryptJson(updatedSecret)).toEqual({
      apiKey: "after-update"
    });
    expect(updateModelResponse.statusCode).toBe(200);
    expect(updateModelResponse.json()).toMatchObject({
      model: {
        id: modelId,
        status: "disabled",
        capabilities: ["json", "vision"]
      }
    });
    expect(revokeProviderResponse.statusCode).toBe(200);
    expect(revokeProviderResponse.body).not.toContain("after-update");
    expect(revokeProviderResponse.json()).toMatchObject({
      provider: {
        id: providerId,
        status: "revoked",
        revokedAt: expect.any(String)
      }
    });
    expect(createAiSecretCipher().decryptJson(revokedSecret)).toEqual({
      revoked: true
    });
  });

  it("serves assistant tool metadata from module manifests without execution access", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/api/ai/assistant-tools",
      headers: {
        authorization: `Bearer ${ids.sessionA}`
      }
    });
    const tools = response.json<{
      tools: Array<{
        moduleId: string;
        name: string;
        permissionId: string;
        risk: string;
        inputSchema: Record<string, unknown> | null;
      }>;
    }>().tools;
    const manifestTools = getBuiltInModuleManifests().flatMap((module) =>
      (module.assistantTools ?? []).map((tool) => `${module.id}:${tool.name}`)
    );

    expect(response.statusCode).toBe(200);
    expect(tools.map((tool) => `${tool.moduleId}:${tool.name}`)).toEqual(manifestTools);
    expect(tools).toContainEqual(
      expect.objectContaining({
        moduleId: "tasks",
        name: "tasks.updateStatus",
        permissionId: "tasks.update",
        risk: "write",
        inputSchema: expect.objectContaining({
          type: "object"
        })
      })
    );
    expect(response.body).not.toContain("execute");
    expect(response.body).not.toContain("encrypted_credential");
    expect(response.body).not.toContain("ciphertext");
  });

  it("creates a cli-auth provider without a credential and reads back authMethod + hasCredential", async () => {
    const createResponse = await server.inject({
      method: "POST",
      url: "/api/ai/providers",
      headers: {
        authorization: `Bearer ${ids.sessionA}`
      },
      payload: {
        providerKind: "anthropic",
        displayName: "Claude CLI",
        authMethod: "cli"
      }
    });

    expect(createResponse.statusCode).toBe(201);
    const provider = createResponse.json<{
      provider: { id: string; authMethod: string; hasCredential: boolean; cliAvailable: boolean };
    }>().provider;
    expect(provider.authMethod).toBe("cli");
    expect(provider.hasCredential).toBe(false);
    // cliAvailable is a boolean (depends on host having 'claude' binary)
    expect(typeof provider.cliAvailable).toBe("boolean");
    const cliModels = await dataContext.withDataContext(userAContext(), (db) =>
      repository.listModels(db)
    );
    expect(
      cliModels
        .filter((model) => model.provider_config_id === provider.id)
        .map((model) => [model.provider_model_id, model.status])
    ).toEqual(
      expect.arrayContaining([
        ["claude-opus-4-8", "active"],
        ["claude-sonnet-4-6", "active"],
        ["claude-haiku-4-5-20251001", "active"]
      ])
    );

    // #982/#869 D7: Codex CLI create uses curated statics instead of remaining sentinel-only.
    const codexResponse = await server.inject({
      method: "POST",
      url: "/api/ai/providers",
      headers: { authorization: `Bearer ${ids.sessionA}` },
      payload: {
        providerKind: "openai-compatible",
        displayName: "Codex CLI",
        authMethod: "cli"
      }
    });
    const codexId = codexResponse.json<{ provider: { id: string } }>().provider.id;
    const codexModels = await dataContext.withDataContext(userAContext(), (db) =>
      repository.listModels(db)
    );
    expect(
      codexModels
        .filter((model) => model.provider_config_id === codexId)
        .map((model) => model.provider_model_id)
    ).toEqual(expect.arrayContaining(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]));

    // Verify api_key default
    const apiKeyResponse = await server.inject({
      method: "POST",
      url: "/api/ai/providers",
      headers: {
        authorization: `Bearer ${ids.sessionA}`
      },
      payload: {
        providerKind: "anthropic",
        displayName: "Anthropic API Key",
        credentialPayload: { apiKey: "sk-test" }
      }
    });
    expect(apiKeyResponse.statusCode).toBe(201);
    const apiKeyProvider = apiKeyResponse.json<{
      provider: { authMethod: string; hasCredential: boolean; cliAvailable: boolean };
    }>().provider;
    expect(apiKeyProvider.authMethod).toBe("api_key");
    expect(apiKeyProvider.hasCredential).toBe(true);
    expect(apiKeyProvider.cliAvailable).toBe(false);
  });

  it("fails loudly when the AI repository is called without withDataContext", async () => {
    await expect(repository.listProviders({} as never)).rejects.toThrow(
      "Repository access requires withDataContext"
    );
    await expect(repository.selectModelForCapability({} as never, "chat")).rejects.toThrow(
      "Repository access requires withDataContext"
    );
  });
});

async function readEncryptedCredential(providerId: string): Promise<EncryptedAiSecret> {
  const client = new Client({ connectionString: connectionStrings.bootstrap });

  await client.connect();
  try {
    const row = await client.query<{ encrypted_credential: EncryptedAiSecret }>(
      `
        SELECT encrypted_credential
        FROM app.ai_provider_configs
        WHERE id = $1
      `,
      [providerId]
    );
    const encryptedCredential = row.rows[0]?.encrypted_credential;

    if (!encryptedCredential) {
      throw new Error(`Missing AI provider config ${providerId}`);
    }

    return encryptedCredential;
  } finally {
    await client.end();
  }
}

describe("AI capability tier routing", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let repository: AiRepository;
  let server: ReturnType<typeof createApiServer>;
  let boss: PgBoss;
  let sharedProviderId: string;

  beforeAll(async () => {
    await resetFoundationDatabase();
    await setUserAInstanceAdmin();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    dataContext = new DataContextRunner(appDb);
    repository = new AiRepository();
    boss = createPgBossClient(connectionStrings.app, { connectionTimeoutMillis: 25_000 }); // #1124: CI PG connect can exceed pg-boss's 10s default even on success (test-only)
    server = createApiServer({ appDb, boss, logger: false });
    await server.ready();

    const providerRes = await server.inject({
      method: "POST",
      url: "/api/ai/providers",
      headers: { authorization: `Bearer ${ids.sessionA}` },
      payload: {
        providerKind: "anthropic",
        displayName: "Tier test provider",
        credentialPayload: { apiKey: "tier-test-key" }
      }
    });
    sharedProviderId = providerRes.json<{ provider: { id: string } }>().provider.id;
  });

  afterAll(async () => {
    await Promise.allSettled([server?.close(), appDb?.destroy(), boss?.stop({ graceful: false })]);
  });

  // Uses "json" capability — isolated from other tests by capability name
  it("selects exact-tier match when available", async () => {
    const interactiveRes = await server.inject({
      method: "POST",
      url: "/api/ai/models",
      headers: { authorization: `Bearer ${ids.sessionA}` },
      payload: {
        providerConfigId: sharedProviderId,
        providerModelId: "json-interactive",
        displayName: "JSON Interactive",
        capabilities: ["json"],
        tier: "interactive"
      }
    });
    const economyRes = await server.inject({
      method: "POST",
      url: "/api/ai/models",
      headers: { authorization: `Bearer ${ids.sessionA}` },
      payload: {
        providerConfigId: sharedProviderId,
        providerModelId: "json-economy",
        displayName: "JSON Economy",
        capabilities: ["json"],
        tier: "economy"
      }
    });
    const reasoningRes = await server.inject({
      method: "POST",
      url: "/api/ai/models",
      headers: { authorization: `Bearer ${ids.sessionA}` },
      payload: {
        providerConfigId: sharedProviderId,
        providerModelId: "json-reasoning",
        displayName: "JSON Reasoning",
        capabilities: ["json"],
        tier: "reasoning"
      }
    });

    expect(interactiveRes.statusCode).toBe(201);
    expect(economyRes.statusCode).toBe(201);
    expect(reasoningRes.statusCode).toBe(201);

    const economyDto = economyRes.json<{ model: { id: string; tier: string } }>().model;
    expect(economyDto.tier).toBe("economy");

    const economyId = economyDto.id;
    const interactiveId = interactiveRes.json<{ model: { id: string } }>().model.id;

    const economySelected = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.selectModelForCapability(scopedDb, "json", "economy")
    );
    expect(economySelected?.id).toBe(economyId);

    const interactiveSelected = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.selectModelForCapability(scopedDb, "json", "interactive")
    );
    expect(interactiveSelected?.id).toBe(interactiveId);
  });

  // Uses "vision" capability — only interactive configured, so economy request falls back
  it("falls back up the tier ladder when exact tier is not configured", async () => {
    const interactiveRes = await server.inject({
      method: "POST",
      url: "/api/ai/models",
      headers: { authorization: `Bearer ${ids.sessionA}` },
      payload: {
        providerConfigId: sharedProviderId,
        providerModelId: "vision-interactive",
        displayName: "Vision Interactive",
        capabilities: ["vision"],
        tier: "interactive"
      }
    });
    expect(interactiveRes.statusCode).toBe(201);
    const interactiveId = interactiveRes.json<{ model: { id: string } }>().model.id;

    const result = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.selectModelForCapability(scopedDb, "vision", "economy")
    );
    expect(result?.id).toBe(interactiveId);
    expect(result?.tier).toBe("interactive");
  });

  // Uses "summarization" capability — only reasoning configured, economy falls through entire ladder
  it("returns the single configured model regardless of tier (single-model setup)", async () => {
    const reasoningRes = await server.inject({
      method: "POST",
      url: "/api/ai/models",
      headers: { authorization: `Bearer ${ids.sessionA}` },
      payload: {
        providerConfigId: sharedProviderId,
        providerModelId: "summ-reasoning",
        displayName: "Summary Reasoning",
        capabilities: ["summarization"],
        tier: "reasoning"
      }
    });
    expect(reasoningRes.statusCode).toBe(201);
    const reasoningId = reasoningRes.json<{ model: { id: string } }>().model.id;

    const result = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.selectModelForCapability(scopedDb, "summarization", "economy")
    );
    expect(result?.id).toBe(reasoningId);
  });

  // Uses "tool-use" capability for create/update; asserts tier in DTO
  it("tier can be set on create and updated via PATCH", async () => {
    const createRes = await server.inject({
      method: "POST",
      url: "/api/ai/models",
      headers: { authorization: `Bearer ${ids.sessionA}` },
      payload: {
        providerConfigId: sharedProviderId,
        providerModelId: "tool-economy",
        displayName: "Tool Economy",
        capabilities: ["tool-use"],
        tier: "economy"
      }
    });
    expect(createRes.statusCode).toBe(201);
    const model = createRes.json<{ model: { id: string; tier: string } }>().model;
    expect(model.tier).toBe("economy");

    const updateRes = await server.inject({
      method: "PATCH",
      url: `/api/ai/models/${model.id}`,
      headers: { authorization: `Bearer ${ids.sessionA}` },
      payload: { tier: "interactive" }
    });
    expect(updateRes.statusCode).toBe(200);
    expect(updateRes.json<{ model: { tier: string } }>().model.tier).toBe("interactive");
  });
});

function userAContext(): AccessContext {
  return {
    actorUserId: ids.userA,
    requestId: "request:user-a-ai"
  };
}

function userBContext(): AccessContext {
  return {
    actorUserId: ids.userB,
    requestId: "request:user-b-ai"
  };
}

async function setUserAInstanceAdmin(): Promise<void> {
  const client = new Client({ connectionString: connectionStrings.bootstrap });

  await client.connect();
  try {
    await client.query(`UPDATE app.users SET is_instance_admin = true WHERE id = $1`, [ids.userA]);
  } finally {
    await client.end();
  }
}
