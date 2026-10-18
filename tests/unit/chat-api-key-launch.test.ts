import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AiRepository,
  createAiSecretCipher,
  type AiConfiguredModelSafeRow,
  type AiProviderWithSealedCredential
} from "@moss/ai";
import { DataContextRunner } from "@moss/db";

import {
  chatAcpModel,
  openChatCredential,
  providerLaunchRevision
} from "../../packages/chat/src/live/api-key-launch.js";
import { DataContextChatPersistence } from "../../packages/chat/src/live/persistence.js";
import { ChatRepository } from "../../packages/chat/src/repository.js";
import { makeRecordingDb } from "./helpers/recording-db.js";

const KEY = "test-key-never-echo-0003";
const cipher = createAiSecretCipher();

function sealed(overrides: Partial<AiProviderWithSealedCredential> = {}) {
  return {
    provider_kind: "openai-compatible",
    auth_method: "api_key",
    status: "active",
    revoked_at: null,
    has_credential: true,
    base_url: "http://proxy.test",
    encrypted_credential: cipher.encryptJson({ apiKey: ` ${KEY} ` }),
    ...overrides
  } as AiProviderWithSealedCredential;
}

const apiKeyRow = {
  provider_kind: "openai-compatible",
  provider_auth_method: "api_key",
  provider_acp_agent_id: null,
  provider_model_id: "org/model:tag@v2"
} as const;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("chatAcpModel", () => {
  it("prefixes an API-key OpenAI-compatible model with the Moss provider id", () => {
    expect(chatAcpModel(apiKeyRow, "muse-spark-1.3-free")).toBe("moss/org/model:tag@v2");
  });

  it("leaves Anthropic API-key rows to the row model", () => {
    expect(chatAcpModel({ ...apiKeyRow, provider_kind: "anthropic" }, undefined)).toBeUndefined();
  });

  it("keeps the saved choice for CLI OpenCode rows only", () => {
    const cliOpencode = {
      ...apiKeyRow,
      provider_auth_method: "cli",
      provider_acp_agent_id: "opencode"
    } as const;
    expect(chatAcpModel(cliOpencode, "muse-spark-1.3-free")).toBe("muse-spark-1.3-free");
    expect(chatAcpModel(cliOpencode, undefined)).toBeUndefined();
    expect(
      chatAcpModel({ ...cliOpencode, provider_acp_agent_id: "codex-acp" }, "default")
    ).toBeUndefined();
  });
});

describe("openChatCredential", () => {
  it("returns the trimmed key, the row's address and the row's launch revision", () => {
    const row = sealed();
    expect(openChatCredential(row, cipher)).toEqual({
      apiKey: KEY,
      baseUrl: "http://proxy.test",
      revision: providerLaunchRevision(row)
    });
  });

  it.each([
    ["no row", undefined],
    ["a CLI row", sealed({ auth_method: "cli" })],
    ["a disabled row", sealed({ status: "disabled" })],
    ["a revoked row", sealed({ revoked_at: new Date("2026-10-01") })],
    ["no stored key", sealed({ has_credential: false })],
    ["an empty key", sealed({ encrypted_credential: cipher.encryptJson({ apiKey: "  " }) })]
  ])("returns null for %s", (_label, row) => {
    expect(openChatCredential(row, cipher)).toBeNull();
  });

  it("returns null, and throws nothing, when the key cannot be decrypted", () => {
    const broken = {
      decryptJson: () => {
        throw new Error(`bad tag near ${KEY}`);
      }
    };
    expect(openChatCredential(sealed(), broken)).toBeNull();
    expect(openChatCredential(sealed(), undefined)).toBeNull();
  });
});

describe("providerLaunchRevision", () => {
  const row = sealed();

  it("is a key-free hash that is stable for the same stored row", () => {
    const revision = providerLaunchRevision(row);
    expect(revision).toMatch(/^[0-9a-f]{64}$/);
    expect(revision).not.toContain(KEY);
    expect(providerLaunchRevision({ ...row })).toBe(revision);
  });

  it("changes when the same row gets a new key", () => {
    const rotated = sealed({
      encrypted_credential: cipher.encryptJson({ apiKey: "test-key-never-echo-0004" })
    });
    expect(providerLaunchRevision(rotated)).not.toBe(providerLaunchRevision(row));
  });

  it("changes when the same row gets a new address", () => {
    const moved = { ...row, base_url: "http://proxy.test/other" };
    expect(providerLaunchRevision(moved)).not.toBe(providerLaunchRevision(row));
  });
});

describe("DataContextChatPersistence API-key launch", () => {
  function fixture(cipherFactory?: () => ReturnType<typeof createAiSecretCipher>) {
    const { scoped } = makeRecordingDb();
    const dataContext = Object.create(DataContextRunner.prototype) as DataContextRunner;
    vi.spyOn(dataContext, "withDataContext").mockImplementation((_access, work) => work(scoped));
    const ai = Object.create(AiRepository.prototype) as AiRepository;
    const persistence = new DataContextChatPersistence({
      dataContext,
      chatRepository: new ChatRepository(),
      aiRepository: ai,
      ...(cipherFactory ? { resolveAiSecretCipher: cipherFactory } : {})
    });
    return { persistence, ai };
  }

  it("decrypts the selected row's key inside the user's data context", async () => {
    const { persistence, ai } = fixture(() => cipher);
    const select = vi.spyOn(ai, "selectProviderWithCredential").mockResolvedValue(sealed());
    await expect(persistence.resolveChatCredential("user-1", "provider-1")).resolves.toEqual({
      apiKey: KEY,
      baseUrl: "http://proxy.test",
      revision: expect.stringMatching(/^[0-9a-f]{64}$/)
    });
    expect(select).toHaveBeenCalledWith(expect.anything(), "provider-1");
  });

  it("returns null when the server cannot build a cipher", async () => {
    const { persistence, ai } = fixture(() => {
      throw new Error("JARVIS_AI_SECRET_KEY is required");
    });
    const select = vi.spyOn(ai, "selectProviderWithCredential").mockResolvedValue(sealed());
    await expect(persistence.resolveChatCredential("user-1", "provider-1")).resolves.toBeNull();
    expect(select).not.toHaveBeenCalled();
  });

  it("gives an API-key OpenAI-compatible row the Moss OpenCode model value and a revision", async () => {
    const { persistence, ai } = fixture(() => cipher);
    const row = sealed();
    vi.spyOn(ai, "selectChatModelForUser").mockResolvedValue({
      ...apiKeyRow,
      provider_config_id: "provider-1"
    } as unknown as AiConfiguredModelSafeRow);
    const select = vi.spyOn(ai, "selectProviderWithCredential").mockResolvedValue(row);
    await expect(persistence.resolveActiveProvider("user-1")).resolves.toMatchObject({
      provider: "openai-compatible",
      model: "org/model:tag@v2",
      authMethod: "api_key",
      acpModel: "moss/org/model:tag@v2",
      providerConfigRevision: providerLaunchRevision(row)
    });
    expect(select).toHaveBeenCalledWith(expect.anything(), "provider-1");
  });

  it("gives a CLI row no revision and reads no sealed credential", async () => {
    const { persistence, ai } = fixture(() => cipher);
    vi.spyOn(ai, "selectChatModelForUser").mockResolvedValue({
      ...apiKeyRow,
      provider_auth_method: "cli",
      provider_acp_agent_id: "opencode",
      provider_config_id: "provider-2"
    } as unknown as AiConfiguredModelSafeRow);
    const select = vi.spyOn(ai, "selectProviderWithCredential");
    const active = await persistence.resolveActiveProvider("user-1");
    expect(active).not.toHaveProperty("providerConfigRevision");
    expect(select).not.toHaveBeenCalled();
  });
});
