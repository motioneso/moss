import { describe, expect, it } from "vitest";

import type {
  AiConfiguredModelSafeRow,
  AiProviderConfigSafeRow,
  AiSecretCipher,
  CreateAiProviderInput,
  DiscoverAndPersistModelsInput,
  DiscoverAndPersistModelsOutcome,
  UpdateAiProviderInput
} from "@moss/ai";
import type { DataContextDb } from "@moss/db";

import type { DevInstanceConfig } from "../../scripts/dev-instance/config.js";
import {
  DEV_API_KEY_PROVIDER_NAME,
  ensureApiKeyProvider,
  type EnsureApiKeyProviderDeps
} from "../../scripts/dev-instance/api-key-provider.js";

const KEY = "ada-dev-instance-key-0001";
const ADMIN = "00000000-0000-4000-8000-00000000ada1";
const scopedDb = {} as DataContextDb;
const SEALED = { sealed: "opaque" } as unknown as ReturnType<AiSecretCipher["encryptJson"]>;

function config(overrides: Partial<DevInstanceConfig> = {}): DevInstanceConfig {
  return {
    providerKind: "openai-compatible",
    providerAuth: "api_key",
    providerBaseUrl: "http://proxy.test",
    providerKeyFilePath: "/tmp/ada-key",
    credentialFilePath: "/tmp/unused.gpg",
    adminEmail: "ada@example.com",
    adminName: "Ada",
    adminPasswordFilePath: "/tmp/unused-password",
    cliHomeBase: "/tmp/unused-cli-home",
    cliRunnerSocketPath: "/tmp/unused.sock",
    ...overrides
  };
}

function providerRow(overrides: Partial<AiProviderConfigSafeRow> = {}): AiProviderConfigSafeRow {
  return {
    id: "provider-1",
    owner_user_id: ADMIN,
    provider_kind: "openai-compatible",
    display_name: DEV_API_KEY_PROVIDER_NAME,
    base_url: "http://proxy.test",
    status: "active",
    auth_method: "api_key",
    execution_mode: "non_interactive",
    acp_agent_id: null,
    has_credential: true,
    is_instance_default: false,
    purpose: "assistant",
    revoked_at: null,
    created_at: new Date(0),
    updated_at: new Date(0),
    ...overrides
  };
}

const LISTED_MODEL = "org/model:tag@v2";

function chatModel(providerConfigId: string): AiConfiguredModelSafeRow {
  return {
    id: "model-1",
    provider_config_id: providerConfigId,
    provider_model_id: LISTED_MODEL
  } as AiConfiguredModelSafeRow;
}

interface HarnessOptions {
  readonly existing?: readonly AiProviderConfigSafeRow[];
  readonly defaultId?: string | null;
  readonly discovery?: DiscoverAndPersistModelsOutcome;
  readonly selected?: AiConfiguredModelSafeRow | null;
  readonly keyFile?: string;
}

function harness(options: HarnessOptions = {}) {
  const created: CreateAiProviderInput[] = [];
  const updated: Array<{ id: string; input: UpdateAiProviderInput }> = [];
  const discovered: DiscoverAndPersistModelsInput[] = [];
  const promoted: string[] = [];
  const encrypted: Array<Record<string, unknown>> = [];

  const deps: EnsureApiKeyProviderDeps = {
    repository: {
      listProviders: async () => [...(options.existing ?? [])],
      createProvider: async (_db, input) => {
        created.push(input);
        return providerRow({ provider_kind: input.providerKind, base_url: input.baseUrl ?? null });
      },
      updateProvider: async (_db, id, input) => {
        updated.push({ id, input });
        return providerRow({ id, base_url: input.baseUrl ?? null });
      },
      resolveDefaultProviderId: async () => options.defaultId ?? null,
      setInstanceDefaultProvider: async (_db, id) => {
        promoted.push(id);
        return providerRow({ id, is_instance_default: true });
      },
      selectChatModelForUser: async () =>
        options.selected === undefined ? chatModel("provider-1") : options.selected
    },
    cipher: {
      encryptJson: (value) => {
        encrypted.push(value);
        return SEALED;
      }
    },
    discoverModels: async (_db, input) => {
      discovered.push(input);
      return options.discovery ?? { discoveredModelIds: [LISTED_MODEL] };
    },
    readKeyFile: async () => options.keyFile ?? `  ${KEY}\n`
  };

  return { deps, created, updated, discovered, promoted, encrypted };
}

describe("ensureApiKeyProvider (#3410)", () => {
  it("creates the row with the trimmed key sealed, discovers models and makes it default", async () => {
    const h = harness();

    const outcome = await ensureApiKeyProvider(scopedDb, ADMIN, config(), h.deps);

    expect(outcome).toEqual({ changed: true, providerId: "provider-1", chatModelId: "model-1" });
    expect(h.created).toEqual([
      {
        providerKind: "openai-compatible",
        displayName: DEV_API_KEY_PROVIDER_NAME,
        baseUrl: "http://proxy.test",
        authMethod: "api_key",
        encryptedCredential: SEALED
      }
    ]);
    expect(h.encrypted).toEqual([{ apiKey: KEY }]);
    expect(h.discovered).toEqual([
      {
        actorUserId: ADMIN,
        providerId: "provider-1",
        providerKind: "openai-compatible",
        acpAgentId: null,
        authMethod: "api_key",
        baseUrl: "http://proxy.test",
        credential: { apiKey: KEY }
      }
    ]);
    expect(h.promoted).toEqual(["provider-1"]);
  });

  it("updates the existing row on a re-run instead of adding a second one", async () => {
    const h = harness({ existing: [providerRow()], defaultId: "provider-1" });

    const outcome = await ensureApiKeyProvider(scopedDb, ADMIN, config(), h.deps);

    expect(h.created).toEqual([]);
    expect(h.updated).toEqual([
      {
        id: "provider-1",
        input: { baseUrl: "http://proxy.test", status: "active", encryptedCredential: SEALED }
      }
    ]);
    expect(outcome.changed).toBe(false);
  });

  it("ignores a same-named row that is revoked or of another kind", async () => {
    const h = harness({
      existing: [
        providerRow({ id: "old-revoked", revoked_at: new Date(0) }),
        providerRow({ id: "other-kind", provider_kind: "anthropic" })
      ]
    });

    await ensureApiKeyProvider(scopedDb, ADMIN, config(), h.deps);

    expect(h.updated).toEqual([]);
    expect(h.created).toHaveLength(1);
  });

  it("refuses an empty key file before any write", async () => {
    const h = harness({ keyFile: " \n" });

    await expect(ensureApiKeyProvider(scopedDb, ADMIN, config(), h.deps)).rejects.toThrow(
      /is empty/
    );
    expect(h.created).toEqual([]);
    expect(h.updated).toEqual([]);
  });

  it("names the discovery failure without echoing the provider's message", async () => {
    const h = harness({
      discovery: { reason: "rejected_key", message: `401 for key ${KEY}` }
    });

    const error = await ensureApiKeyProvider(scopedDb, ADMIN, config(), h.deps).catch(
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("rejected_key");
    expect((error as Error).message).not.toContain(KEY);
    expect(h.promoted).toEqual([]);
  });

  it("refuses when the chat model belongs to another provider", async () => {
    const h = harness({ selected: chatModel("some-other-provider") });

    await expect(ensureApiKeyProvider(scopedDb, ADMIN, config(), h.deps)).rejects.toThrow(
      /listed no chat model/
    );
  });

  it("refuses when there is no chat model at all", async () => {
    const h = harness({ selected: null });

    await expect(ensureApiKeyProvider(scopedDb, ADMIN, config(), h.deps)).rejects.toThrow(
      /listed no chat model/
    );
  });

  it("refuses a stale model the provider no longer lists", async () => {
    const h = harness({ discovery: { discoveredModelIds: ["org/other-model"] } });

    await expect(ensureApiKeyProvider(scopedDb, ADMIN, config(), h.deps)).rejects.toThrow(
      /listed no chat model/
    );
  });

  it("refuses an empty model list before making the row default", async () => {
    const h = harness({ discovery: { discoveredModelIds: [] } });

    await expect(ensureApiKeyProvider(scopedDb, ADMIN, config(), h.deps)).rejects.toThrow(
      /listed no chat model/
    );
    expect(h.promoted).toEqual([]);
  });

  it("refuses a cli config", async () => {
    const h = harness();

    await expect(
      ensureApiKeyProvider(
        scopedDb,
        ADMIN,
        config({ providerAuth: "cli", providerBaseUrl: null, providerKeyFilePath: null }),
        h.deps
      )
    ).rejects.toThrow(/needs an api_key dev-instance config/);
  });
});
