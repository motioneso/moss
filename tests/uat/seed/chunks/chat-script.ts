import type { DataContextRunner } from "@moss/db";
import { AiRepository, createAiSecretCipher } from "@moss/ai";
import { SettingsRepository } from "@moss/settings";

export async function seedScriptedChatProviderChunk(
  runner: DataContextRunner,
  actorUserId: string
): Promise<void> {
  const repo = new AiRepository();
  const cipher = createAiSecretCipher();

  await runner.withDataContext({ actorUserId }, async (scopedDb) => {
    const provider = await repo.createProvider(scopedDb, {
      providerKind: "anthropic",
      displayName: "UAT Scripted Provider",
      executionMode: "non_interactive",
      encryptedCredential: cipher.encryptJson({ cli: true })
    });
    await repo.createModel(scopedDb, {
      providerConfigId: provider.id,
      providerModelId: "uat-scripted-chat-model",
      displayName: "UAT Scripted Chat Model",
      capabilities: ["chat"]
    });
    await new SettingsRepository().upsertInstanceSetting(scopedDb, {
      key: "chat.persistent_runtime.enabled",
      value: { value: "false" },
      updatedByUserId: actorUserId,
      requestId: "uat-seed-chat-script"
    });
  });
}
