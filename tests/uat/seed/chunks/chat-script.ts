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
    // #2906: live chat refuses an api_key provider, and a cli provider with no ACP agent id.
    // Seed a CLI provider with the Anthropic ACP identity so the live route accepts it: without
    // this, every scripted-chat spec is refused before a turn starts. Note this only unblocks the
    // route — a scripted turn still does not complete, because the ACP adapter
    // (@agentclientprotocol/claude-agent-acp) expects a protocol the scripted fixture no longer
    // emits. Scripted-chat specs that assert a reply remain tracked under #2906.
    const provider = await repo.createProvider(scopedDb, {
      providerKind: "anthropic",
      displayName: "UAT Scripted Provider",
      executionMode: "non_interactive",
      authMethod: "cli",
      acpAgentId: "claude-acp",
      encryptedCredential: cipher.encryptJson({ cli: true })
    });
    await repo.createModel(scopedDb, {
      providerConfigId: provider.id,
      providerModelId: "uat-scripted-chat-model",
      displayName: "UAT Scripted Chat Model",
      capabilities: ["chat"]
    });
    await repo.setInstanceDefaultProvider(scopedDb, provider.id);
    await new SettingsRepository().upsertInstanceSetting(scopedDb, {
      key: "chat.persistent_runtime.enabled",
      value: { value: "false" },
      updatedByUserId: actorUserId,
      requestId: "uat-seed-chat-script"
    });
  });
}
