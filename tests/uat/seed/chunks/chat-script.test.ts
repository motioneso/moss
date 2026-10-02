import { describe, expect, it } from "vitest";
import { createAppRuntimeRunner, createMigrationOwnerDb } from "../connections.js";
import { seedSoloAdmin } from "../admin.js";
import { seedScriptedChatProviderChunk } from "./chat-script.js";
import { AiRepository } from "@moss/ai";
import { SettingsRepository } from "@moss/settings";

describe("seedScriptedChatProviderChunk", () => {
  it("seeds a scripted anthropic provider, chat-capable model, and pins the bounded-fallback engine", async () => {
    const migrationDb = createMigrationOwnerDb();
    const { userId } = await seedSoloAdmin(migrationDb);
    await migrationDb.destroy();

    const runner = createAppRuntimeRunner();
    await seedScriptedChatProviderChunk(runner, userId);

    const aiRepo = new AiRepository();
    const settingsRepo = new SettingsRepository();
    await runner.withDataContext({ actorUserId: userId }, async (scopedDb) => {
      const providers = await aiRepo.listProviders(scopedDb);
      const scriptedProviders = providers.filter(
        (p) => p.provider_kind === "anthropic" && p.execution_mode === "non_interactive"
      );
      expect(scriptedProviders).toHaveLength(1);
      expect(scriptedProviders[0]?.status).toBe("active");
      // #2906: live chat only hosts a cli provider, and only with an ACP agent id; an api_key
      // provider (or a cli provider with no identity) is rejected before any turn runs.
      expect(scriptedProviders[0]?.auth_method).toBe("cli");
      expect(scriptedProviders[0]?.acp_agent_id).toBe("claude-acp");

      const models = await aiRepo.listModels(scopedDb);
      const chatModels = models.filter((m) => m.capabilities.includes("chat"));
      expect(chatModels).toHaveLength(1);

      const settings = await settingsRepo.listInstanceSettings(scopedDb);
      const runtimeSetting = settings.find((s) => s.key === "chat.persistent_runtime.enabled");
      expect(runtimeSetting).toBeDefined();
      expect((runtimeSetting?.value as { value?: unknown } | undefined)?.value).toBe("false");
    });

    await runner.destroy();
  });
});
