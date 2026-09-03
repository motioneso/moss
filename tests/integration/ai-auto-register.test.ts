import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import pg from "pg";

import {
  AiAutoRegisterService,
  AiRepository,
  CLI_STATIC_MODELS,
  ModelDiscoveryService,
  createAiSecretCipher,
  type AiSecretCipher
} from "@moss/ai";
import { DataContextRunner, createDatabase, type AccessContext, type MossDatabase } from "@moss/db";
import { SettingsRepository } from "@moss/settings";

import { discoverAndPersistModels } from "../../packages/ai/src/discover-and-persist-models.js";
import { buildOnboardingLogin } from "../../packages/module-registry/src/onboarding-login.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const { Client } = pg;

describe("AI auto-register default chat model on login (#367)", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let repository: AiRepository;
  let cipher: AiSecretCipher;
  let service: AiAutoRegisterService;
  let originalSecretKey: string | undefined;

  beforeAll(async () => {
    originalSecretKey = process.env.JARVIS_AI_SECRET_KEY;
    process.env.JARVIS_AI_SECRET_KEY = "test-ai-secret-key";

    await resetFoundationDatabase();
    await setUserAInstanceAdmin();

    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    dataContext = new DataContextRunner(appDb);
    repository = new AiRepository();
    cipher = createAiSecretCipher();
    service = new AiAutoRegisterService({ repository, cipher });
  });

  afterAll(async () => {
    await appDb?.destroy();
    if (originalSecretKey === undefined) {
      delete process.env.JARVIS_AI_SECRET_KEY;
    } else {
      process.env.JARVIS_AI_SECRET_KEY = originalSecretKey;
    }
  });

  beforeEach(async () => {
    // Each test starts from a clean AI config slate (admin-scoped truncate via bootstrap role).
    await truncateAiTables();
  });

  it("registers a default cli provider config + 'default' chat model on first ready (anthropic)", async () => {
    await dataContext.withDataContext(adminCtx(), (db) =>
      service.ensureDefaultChatModel(db, "anthropic")
    );

    const { providers, model, models } = await dataContext.withDataContext(
      adminCtx(),
      async (db) => ({
        providers: await repository.listProviders(db),
        model: await repository.selectChatModelForUser(db),
        models: await repository.listModels(db)
      })
    );

    const cli = providers.find((p) => p.provider_kind === "anthropic");
    expect(cli).toBeDefined();
    expect(cli?.auth_method).toBe("cli");
    expect(model?.provider_model_id).toBe("default");
    expect(model?.capabilities).toContain("chat");
    expect(model?.status).toBe("active");
    expect(cli?.is_instance_default).toBe(true);
    expect(models.filter((row) => row.provider_config_id === cli?.id)).toHaveLength(4);
    expect(
      models
        .filter((row) => row.provider_model_id !== "default")
        .every((row) => row.status === "active")
    ).toBe(true);
  });

  it("registers a default cli provider config + codex chat model on first ready (openai-compatible)", async () => {
    await dataContext.withDataContext(adminCtx(), (db) =>
      service.ensureDefaultChatModel(db, "openai-compatible")
    );

    const { providers, model, models } = await dataContext.withDataContext(
      adminCtx(),
      async (db) => ({
        providers: await repository.listProviders(db),
        model: await repository.selectChatModelForUser(db),
        models: await repository.listModels(db)
      })
    );

    const cli = providers.find((p) => p.provider_kind === "openai-compatible");
    expect(cli).toBeDefined();
    expect(cli?.auth_method).toBe("cli");
    expect(model?.provider_model_id).toBe("default");
    expect(model?.capabilities).toContain("chat");
    expect(model?.status).toBe("active");
    expect(
      Object.fromEntries(models.map((row) => [row.provider_model_id, row.tier]))
    ).toMatchObject({
      "gpt-5.6-sol": "reasoning",
      "gpt-5.6-terra": "interactive",
      "gpt-5.6-luna": "economy"
    });
  });

  it("is idempotent across re-login — creates nothing new on a second call", async () => {
    await dataContext.withDataContext(adminCtx(), (db) =>
      service.ensureDefaultChatModel(db, "anthropic")
    );
    await dataContext.withDataContext(adminCtx(), (db) =>
      service.ensureDefaultChatModel(db, "anthropic")
    );

    const { providers, models } = await dataContext.withDataContext(adminCtx(), async (db) => ({
      providers: (await repository.listProviders(db)).filter(
        (p) => p.provider_kind === "anthropic"
      ),
      models: await repository.listModels(db)
    }));

    expect(providers).toHaveLength(1);
    expect(models.filter((m) => m.provider_model_id === "default")).toHaveLength(1);
  });

  it("preserves a bound concrete model row across re-login reconcile (#1083 F2)", async () => {
    await dataContext.withDataContext(adminCtx(), async (db) => {
      await service.ensureDefaultChatModel(db, "anthropic");
      const boundBefore = (await repository.listModels(db)).find(
        (model) => model.provider_model_id === "claude-haiku-4-5-20251001"
      )!;
      await repository.setServiceBinding(
        db,
        "module.news",
        { kind: "model", modelId: boundBefore.id },
        ids.userA
      );

      // #1083 F2: token expiry followed by re-login repeats this exact login-ready reconcile. The
      // natural-key row must keep its UUID, not merely its name/count, because the service binding
      // stores that UUID and would otherwise dangle even though the discovered catalog is unchanged.
      await service.ensureDefaultChatModel(db, "anthropic");

      const boundAfter = (await repository.listModels(db)).find(
        (model) => model.provider_model_id === boundBefore.provider_model_id
      );
      const route = await repository.resolveModelForService(db, "module.news", {
        capability: "json"
      });
      expect(boundAfter?.id).toBe(boundBefore.id);
      expect(await repository.getModuleServiceBinding(db, "module.news")).toEqual({
        kind: "model",
        modelId: boundBefore.id
      });
      expect(route).toMatchObject({ reason: "manual-route", model: { id: boundBefore.id } });
    });
  });

  it("falls back inside the default provider when changed discovery removes the bound model (#1083 F2)", async () => {
    await dataContext.withDataContext(adminCtx(), async (db) => {
      await service.ensureDefaultChatModel(db, "anthropic");
      const defaultCliProvider = (await repository.listProviders(db)).find(
        (provider) => provider.provider_kind === "anthropic"
      )!;
      const bound = (await repository.listModels(db)).find(
        (model) => model.provider_model_id === "claude-opus-4-8"
      )!;
      await repository.setServiceBinding(
        db,
        "module.news",
        { kind: "model", modelId: bound.id },
        ids.userA
      );

      // Make cross-provider automatic routing observably wrong: this newer economy model must not
      // outrank the configured default provider when #1083 F2's residual dangling UUID is handled.
      const secondaryProvider = await repository.createProvider(db, {
        providerKind: "custom",
        displayName: "Secondary provider",
        encryptedCredential: cipher.encryptJson({ apiKey: "secondary-test-key" })
      });
      await repository.createModel(db, {
        providerConfigId: secondaryProvider.id,
        providerModelId: "secondary-json",
        displayName: "Secondary JSON",
        capabilities: ["json"],
        tier: "economy"
      });

      const changedDiscovery = new ModelDiscoveryService();
      changedDiscovery.discoverModels = async () => ({
        models: CLI_STATIC_MODELS.anthropic!.filter(
          (model) => model.providerModelId !== bound.provider_model_id
        ),
        fromCache: false,
        fromFallback: true,
        cacheExpiresAt: null
      });
      await discoverAndPersistModels(
        db,
        {
          actorUserId: defaultCliProvider.owner_user_id,
          providerId: defaultCliProvider.id,
          providerKind: defaultCliProvider.provider_kind,
          authMethod: defaultCliProvider.auth_method,
          baseUrl: defaultCliProvider.base_url,
          credential: { cli: true }
        },
        { repository, modelDiscovery: changedDiscovery }
      );

      // A real catalog removal legitimately deletes the row while leaving today's blob binding
      // dangling. #1083 F2 degrades within the instance default until the deferred FK redesign.
      expect((await repository.listModels(db)).some((model) => model.id === bound.id)).toBe(false);
      expect(await repository.getModuleServiceBinding(db, "module.news")).toEqual({
        kind: "model",
        modelId: bound.id
      });
      const route = await repository.resolveModelForService(db, "module.news", {
        capability: "json"
      });
      expect(route.reason).toBe("matched-active-model");
      expect(route.model?.provider_config_id).toBe(defaultCliProvider.id);
    });
  });

  it("clean-slate reconcile removes stale/manual concrete rows but preserves sentinel", async () => {
    await dataContext.withDataContext(adminCtx(), (db) =>
      service.ensureDefaultChatModel(db, "anthropic")
    );
    const provider = await dataContext.withDataContext(adminCtx(), async (db) =>
      (await repository.listProviders(db)).find((row) => row.provider_kind === "anthropic")
    );
    await dataContext.withDataContext(adminCtx(), async (db) => {
      await repository.createModel(db, {
        providerConfigId: provider!.id,
        providerModelId: "stale-static",
        displayName: "Stale static",
        capabilities: ["chat"],
        status: "disabled"
      });
      await repository.createModel(db, {
        providerConfigId: provider!.id,
        providerModelId: "manual-model",
        displayName: "Manual model",
        capabilities: ["json"]
      });
      await service.ensureDefaultChatModel(db, "anthropic");
    });

    const models = await dataContext.withDataContext(adminCtx(), (db) => repository.listModels(db));
    expect(models.map((row) => row.provider_model_id).sort()).toEqual([
      "claude-haiku-4-5-20251001",
      "claude-opus-4-8",
      "claude-sonnet-4-6",
      "default"
    ]);
    expect(models.find((row) => row.provider_model_id === "default")?.status).toBe("active");
  });

  it("keeps model deletion admin-only and always preserves the sentinel", async () => {
    await dataContext.withDataContext(adminCtx(), (db) =>
      service.ensureDefaultChatModel(db, "anthropic")
    );
    const provider = await dataContext.withDataContext(adminCtx(), async (db) =>
      (await repository.listProviders(db)).find((row) => row.provider_kind === "anthropic")
    );

    // #982/#869 security boundary: app runtime has DELETE, but FORCE RLS makes a non-admin delete
    // affect zero rows; repository filtering independently excludes the sentinel for admins too.
    await dataContext.withDataContext(
      { actorUserId: ids.userB, requestId: "request:non-admin-reconcile" },
      (db) => repository.deleteModelsForProviderExceptSentinel(db, provider!.id)
    );
    const afterNonAdmin = await dataContext.withDataContext(adminCtx(), (db) =>
      repository.listModels(db)
    );
    expect(afterNonAdmin).toHaveLength(4);

    await dataContext.withDataContext(adminCtx(), (db) =>
      repository.deleteModelsForProviderExceptSentinel(db, provider!.id)
    );
    const afterAdmin = await dataContext.withDataContext(adminCtx(), (db) =>
      repository.listModels(db)
    );
    expect(afterAdmin.map((row) => row.provider_model_id)).toEqual(["default"]);
  });

  it("clears the instance-default flag when the default provider is revoked (#2207)", async () => {
    const id = await dataContext.withDataContext(adminCtx(), async (db) => {
      const created = await repository.createProvider(db, {
        providerKind: "anthropic",
        displayName: "Claude (to be removed)",
        authMethod: "cli",
        encryptedCredential: cipher.encryptJson({ cli: true })
      });
      await repository.setInstanceDefaultProvider(db, created.id);
      await repository.revokeProvider(db, created.id, cipher.encryptJson({ revoked: true }));
      return created.id;
    });

    const providers = await dataContext.withDataContext(adminCtx(), (db) =>
      repository.listProviders(db)
    );
    const revoked = providers.find((p) => p.id === id);
    expect(revoked?.status).toBe("revoked");
    expect(revoked?.is_instance_default).toBe(false);
    expect(providers.some((p) => p.is_instance_default)).toBe(false);
  });

  it("still adopts the next sole provider when a revoked row carries a stale default flag (#2207)", async () => {
    // Installs revoked their default before the fix left the flag on the tombstone. Simulate that
    // pre-fix state directly, then log in: the new Claude row must become the default anyway.
    const staleId = await dataContext.withDataContext(adminCtx(), async (db) => {
      const created = await repository.createProvider(db, {
        providerKind: "anthropic",
        displayName: "Claude (stale default)",
        authMethod: "cli",
        encryptedCredential: cipher.encryptJson({ cli: true })
      });
      await db.db
        .updateTable("app.ai_provider_configs")
        .set({ status: "revoked", is_instance_default: true, revoked_at: new Date() })
        .where("id", "=", created.id)
        .execute();
      return created.id;
    });

    await dataContext.withDataContext(adminCtx(), (db) =>
      service.ensureDefaultChatModel(db, "anthropic")
    );

    const providers = await dataContext.withDataContext(adminCtx(), (db) =>
      repository.listProviders(db)
    );
    const active = providers.filter((p) => p.status === "active");
    expect(active).toHaveLength(1);
    expect(active[0]?.is_instance_default).toBe(true);
    expect(providers.find((p) => p.id === staleId)?.is_instance_default).toBe(false);
  });

  it("does not recreate a model the user disabled (never resurrect — decision 2)", async () => {
    await dataContext.withDataContext(adminCtx(), (db) =>
      service.ensureDefaultChatModel(db, "anthropic")
    );
    const model = await dataContext.withDataContext(adminCtx(), (db) =>
      repository.selectChatModelForUser(db)
    );
    await dataContext.withDataContext(adminCtx(), (db) =>
      repository.updateModel(db, model!.id, { status: "disabled" })
    );

    // Re-login: the disabled row still exists, so no new model is created.
    await dataContext.withDataContext(adminCtx(), (db) =>
      service.ensureDefaultChatModel(db, "anthropic")
    );

    const models = await dataContext.withDataContext(adminCtx(), (db) => repository.listModels(db));
    const defaults = models.filter((m) => m.provider_model_id === "default");
    expect(defaults).toHaveLength(1);
    expect(defaults[0]?.status).toBe("disabled");
  });

  it("reuses an existing non-revoked provider config instead of duplicating it", async () => {
    await dataContext.withDataContext(adminCtx(), (db) =>
      repository.createProvider(db, {
        providerKind: "anthropic",
        displayName: "Claude",
        authMethod: "cli",
        encryptedCredential: cipher.encryptJson({ cli: true })
      })
    );

    await dataContext.withDataContext(adminCtx(), (db) =>
      service.ensureDefaultChatModel(db, "anthropic")
    );

    const providers = await dataContext.withDataContext(adminCtx(), (db) =>
      repository.listProviders(db)
    );
    expect(providers.filter((p) => p.provider_kind === "anthropic")).toHaveLength(1);
  });

  it("creates a NEW active config when the only existing config is disabled (B1 — recoverable)", async () => {
    // Founder disabled the anthropic config in Admin; a later CLI login settles ready. Reusing the
    // disabled config would insert a model under it that selectChatModelForUser (active-only) can
    // never resolve → permanent dead chat. The fix creates a NEW active config instead.
    await dataContext.withDataContext(adminCtx(), (db) =>
      repository.createProvider(db, {
        providerKind: "anthropic",
        displayName: "Claude (disabled)",
        status: "disabled",
        authMethod: "cli",
        encryptedCredential: cipher.encryptJson({ cli: true })
      })
    );

    await dataContext.withDataContext(adminCtx(), (db) =>
      service.ensureDefaultChatModel(db, "anthropic")
    );

    const { providers, model } = await dataContext.withDataContext(adminCtx(), async (db) => ({
      providers: (await repository.listProviders(db)).filter(
        (p) => p.provider_kind === "anthropic"
      ),
      model: await repository.selectChatModelForUser(db)
    }));

    // A NEW active config exists alongside the untouched disabled one.
    expect(providers.filter((p) => p.status === "active")).toHaveLength(1);
    expect(providers.filter((p) => p.status === "disabled")).toHaveLength(1);
    // The registered model is selectable (resolves through the active config).
    expect(model?.provider_model_id).toBe("default");
    expect(model?.provider_status).toBe("active");
  });

  it("reactivates the clicked disabled config instead of duplicating it (#2205)", async () => {
    // Settings → AI: the founder clicks "Log in" on a Claude row they had disabled earlier. The
    // dialog sends that row's id; ready must flip THAT row back to active, keep its models, and
    // create no second Claude config.
    const disabledId = await dataContext.withDataContext(adminCtx(), async (db) => {
      const created = await repository.createProvider(db, {
        providerKind: "anthropic",
        displayName: "Claude (disabled)",
        status: "disabled",
        authMethod: "cli",
        encryptedCredential: cipher.encryptJson({ cli: true })
      });
      await repository.createModel(db, {
        providerConfigId: created.id,
        providerModelId: "default",
        displayName: "Claude (default model)",
        capabilities: ["chat"],
        status: "active",
        tier: "interactive"
      });
      return created.id;
    });

    await dataContext.withDataContext(adminCtx(), (db) =>
      service.ensureDefaultChatModel(db, "anthropic", { providerConfigId: disabledId })
    );

    const { providers, model, models } = await dataContext.withDataContext(
      adminCtx(),
      async (db) => ({
        providers: (await repository.listProviders(db)).filter(
          (p) => p.provider_kind === "anthropic"
        ),
        model: await repository.selectChatModelForUser(db),
        models: await repository.listModels(db)
      })
    );

    expect(providers).toHaveLength(1);
    expect(providers[0]?.id).toBe(disabledId);
    expect(providers[0]?.status).toBe("active");
    expect(providers[0]?.is_instance_default).toBe(true);
    expect(model?.provider_model_id).toBe("default");
    expect(models.filter((row) => row.provider_model_id === "default")).toHaveLength(1);
  });

  it("ignores a clicked id that names another kind and falls back to the kind-only path (#2205)", async () => {
    const codexId = await dataContext.withDataContext(adminCtx(), async (db) => {
      const created = await repository.createProvider(db, {
        providerKind: "openai-compatible",
        displayName: "Codex",
        status: "disabled",
        authMethod: "cli",
        encryptedCredential: cipher.encryptJson({ cli: true })
      });
      return created.id;
    });

    await dataContext.withDataContext(adminCtx(), (db) =>
      service.ensureDefaultChatModel(db, "anthropic", { providerConfigId: codexId })
    );

    const providers = await dataContext.withDataContext(adminCtx(), (db) =>
      repository.listProviders(db)
    );
    expect(providers.find((p) => p.id === codexId)?.status).toBe("disabled");
    expect(
      providers.filter((p) => p.provider_kind === "anthropic" && p.status === "active")
    ).toHaveLength(1);
  });

  it("passes the clicked row through persistLoginTerminal (#2205)", async () => {
    const seen: unknown[] = [];
    const seam = buildOnboardingLogin({
      enabled: true,
      getConnection: () => undefined,
      repository: new SettingsRepository(),
      autoRegister: {
        ensureDefaultChatModel: async (_db, kind, options) => {
          seen.push([kind, options]);
        }
      },
      logger: { warn: () => {} }
    })!;

    await dataContext.withDataContext(adminCtx(), (db) =>
      seam.stateStore.persistLoginTerminal(db, {
        provider: "anthropic",
        status: "ready",
        requestId: "r3",
        providerConfigId: "row-1"
      })
    );
    expect(seen).toEqual([["anthropic", { providerConfigId: "row-1" }]]);
  });

  it("no-ops for a provider without a catalog default", async () => {
    await dataContext.withDataContext(adminCtx(), (db) =>
      service.ensureDefaultChatModel(db, "custom")
    );
    const providers = await dataContext.withDataContext(adminCtx(), (db) =>
      repository.listProviders(db)
    );
    expect(providers.filter((p) => p.provider_kind === "custom")).toHaveLength(0);
  });

  it("auto-registers when persistLoginTerminal settles ready, and never throws into login", async () => {
    const seam = buildOnboardingLogin({
      enabled: true,
      getConnection: () => undefined, // login RPC not exercised; we drive stateStore directly
      repository: new SettingsRepository(),
      autoRegister: service,
      logger: { warn: () => {} }
    })!;

    const state = await dataContext.withDataContext(adminCtx(), (db) =>
      seam.stateStore.persistLoginTerminal(db, {
        provider: "anthropic",
        status: "ready",
        requestId: "r1"
      })
    );
    expect(state).toBe("ready");

    const model = await dataContext.withDataContext(adminCtx(), (db) =>
      repository.selectChatModelForUser(db)
    );
    expect(model?.provider_model_id).toBe("default");
  });

  it("best-effort: a throwing auto-register port does NOT fail the ready transition", async () => {
    const throwingSeam = buildOnboardingLogin({
      enabled: true,
      getConnection: () => undefined,
      repository: new SettingsRepository(),
      autoRegister: {
        ensureDefaultChatModel: async () => {
          throw new Error("boom");
        }
      },
      logger: { warn: () => {} }
    })!;

    const state = await dataContext.withDataContext(adminCtx(), (db) =>
      throwingSeam.stateStore.persistLoginTerminal(db, {
        provider: "anthropic",
        status: "ready",
        requestId: "r2"
      })
    );
    expect(state).toBe("ready");
  });

  function adminCtx(): AccessContext {
    return { actorUserId: ids.userA, requestId: "request:auto-register" };
  }
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

async function truncateAiTables(): Promise<void> {
  const client = new Client({ connectionString: connectionStrings.bootstrap });
  await client.connect();
  try {
    await client.query(
      `TRUNCATE app.ai_configured_models, app.ai_provider_configs, app.provider_install_state RESTART IDENTITY CASCADE`
    );
  } finally {
    await client.end();
  }
}
