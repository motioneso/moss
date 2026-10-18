import { AiRepository, createAiSecretCipher } from "@moss/ai";
import type { DataContextRunner } from "@moss/db";

import { API_KEY_CHAT_SEED_ENV, type ApiKeyChatSeed } from "../types.js";

export const UAT_API_KEY_CHAT_PROVIDER_NAME = "UAT API-key chat provider";

/** Reads the four seed variables. All empty means off. Errors never echo a value. */
export function parseApiKeyChatSeed(env: NodeJS.ProcessEnv): ApiKeyChatSeed | undefined {
  const kind = env[API_KEY_CHAT_SEED_ENV.kind] ?? "";
  const baseUrl = env[API_KEY_CHAT_SEED_ENV.baseUrl] ?? "";
  const model = env[API_KEY_CHAT_SEED_ENV.model] ?? "";
  const apiKey = env[API_KEY_CHAT_SEED_ENV.key] ?? "";
  const values = [kind, baseUrl, model, apiKey];

  if (values.every((entry) => entry === "")) return undefined;
  if (values.some((entry) => entry === "")) {
    throw new Error(
      `${Object.values(API_KEY_CHAT_SEED_ENV).join(", ")} must be set together or not at all`
    );
  }
  if (kind !== "anthropic" && kind !== "openai-compatible") {
    throw new Error(`${API_KEY_CHAT_SEED_ENV.kind} must be anthropic or openai-compatible`);
  }
  return { providerKind: kind, baseUrl, model, apiKey };
}

/**
 * #3410: one API-key provider, its chat model, and the instance default pointing at it. Opt-in
 * only (uatLevel `withApiKeyChatProvider`); never part of the default chunk ladder.
 */
export async function seedApiKeyChatProviderChunk(
  runner: DataContextRunner,
  actorUserId: string,
  seed: ApiKeyChatSeed
): Promise<void> {
  const repo = new AiRepository();
  const cipher = createAiSecretCipher();

  await runner.withDataContext({ actorUserId }, async (scopedDb) => {
    const provider = await repo.createProvider(scopedDb, {
      providerKind: seed.providerKind,
      displayName: UAT_API_KEY_CHAT_PROVIDER_NAME,
      baseUrl: seed.baseUrl,
      authMethod: "api_key",
      encryptedCredential: cipher.encryptJson({ apiKey: seed.apiKey })
    });
    await repo.createModel(scopedDb, {
      providerConfigId: provider.id,
      providerModelId: seed.model,
      displayName: seed.model,
      capabilities: ["chat", "tool-use"],
      tier: "interactive"
    });
    await repo.setInstanceDefaultProvider(scopedDb, provider.id);
  });
}
