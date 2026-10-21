import { describe, expect, it } from "vitest";
import { AiRepository, createAiSecretCipher, parseAiApiKeyCredential } from "@moss/ai";
import type { DataContextDb, DataContextRunner } from "@moss/db";

import { createAppRuntimeRunner, createMigrationOwnerDb } from "../connections.js";
import { seedSoloAdmin } from "../admin.js";
import { seedAiProviderChunk } from "./ai.js";
import { seedApiKeyChatProviderChunk, UAT_API_KEY_CHAT_PROVIDER_NAME } from "./api-key-chat.js";

// The seed suite shares one un-reset database across files, and provider rows cannot be deleted
// (no DELETE policy under forced RLS). A chat-capable row left behind breaks later tests that
// expect no chat model, or exactly one, so this test seeds inside one transaction and rolls back.
class RollbackSentinel extends Error {}

function runnerOn(scopedDb: DataContextDb): DataContextRunner {
  const withDataContext: DataContextRunner["withDataContext"] = (_context, work) => work(scopedDb);
  return { withDataContext } as unknown as DataContextRunner;
}

describe("seedApiKeyChatProviderChunk (#3410)", () => {
  it("seeds an API-key provider whose model chat selects, after the default AI chunk", async () => {
    const migrationDb = createMigrationOwnerDb();
    const { userId } = await seedSoloAdmin(migrationDb);
    await migrationDb.destroy();

    const runner = createAppRuntimeRunner();
    try {
      const run = runner.withDataContext({ actorUserId: userId }, async (scopedDb) => {
        const txRunner = runnerOn(scopedDb);
        await seedAiProviderChunk(txRunner, userId, { bindNews: true });
        await seedApiKeyChatProviderChunk(txRunner, userId, {
          providerKind: "openai-compatible",
          baseUrl: "http://proxy.test",
          model: "ada-model",
          apiKey: "ada-uat-key-0001"
        });

        const repo = new AiRepository();
        const providers = await repo.listProviders(scopedDb);
        const seeded = providers.filter(
          (row) => row.display_name === UAT_API_KEY_CHAT_PROVIDER_NAME
        );
        expect(seeded).toHaveLength(1);
        expect(seeded[0]?.auth_method).toBe("api_key");
        expect(seeded[0]?.base_url).toBe("http://proxy.test");
        expect(seeded[0]?.is_instance_default).toBe(true);

        // listProviders never selects the credential column, so read the stored value itself.
        const sealed = await repo.selectProviderWithCredential(scopedDb, seeded[0]?.id ?? "");
        if (!sealed) throw new Error("seeded provider row has no stored credential");
        expect(JSON.stringify(sealed.encrypted_credential)).not.toContain("ada-uat-key-0001");
        const opened = parseAiApiKeyCredential(
          createAiSecretCipher().decryptJson(sealed.encrypted_credential)
        );
        expect(opened?.apiKey).toBe("ada-uat-key-0001");

        const chatModel = await repo.selectChatModelForUser(scopedDb);
        expect(chatModel?.provider_config_id).toBe(seeded[0]?.id);
        expect(chatModel?.provider_model_id).toBe("ada-model");

        throw new RollbackSentinel();
      });
      await expect(run).rejects.toBeInstanceOf(RollbackSentinel);
    } finally {
      await runner.destroy();
    }
  });
});
