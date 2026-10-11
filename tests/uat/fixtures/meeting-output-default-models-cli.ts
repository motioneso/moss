import { AiRepository, createAiSecretCipher } from "@moss/ai";
import { UAT_ADMIN_ID } from "../seed/admin.js";
import { createAppRuntimeRunner, createMigrationOwnerDb } from "../seed/connections.js";
import { assertTargetIsEphemeral } from "../seed/guard.js";

// Real configuration rows only, through the owning repository and owner RLS context.
// Provider POST triggers discovery; this fixture deliberately performs no discovery,
// login, token reads or model requests. The provisioner destroys these disposable rows.
if (
  process.env.JARVIS_UAT_SEED_CONFIRM !== "1" ||
  !/^uat-[0-9]+_[0-9a-f]{8}$/.test(process.argv[2] ?? "")
)
  throw new Error("Meeting default fixture requires the isolated UAT stack");
const migrationDb = createMigrationOwnerDb();
try {
  await assertTargetIsEphemeral(migrationDb);
} finally {
  await migrationDb.destroy();
}
const runner = createAppRuntimeRunner();
try {
  const repository = new AiRepository();
  const cipher = createAiSecretCipher();
  const models = await runner.withDataContext({ actorUserId: UAT_ADMIN_ID }, async (db) => {
    const result: Record<string, { providerId: string; modelId: string }> = {};
    for (const [name, providerKind, acpAgentId] of [
      ["codex", "openai-compatible", "codex-acp"],
      ["claude", "anthropic", "claude-acp"]
    ] as const) {
      const provider = await repository.createProvider(db, {
        providerKind,
        acpAgentId,
        displayName: `UAT meeting ${name} availability only`,
        authMethod: "cli",
        encryptedCredential: cipher.encryptJson({ cli: true })
      });
      const model = await repository.createModel(db, {
        providerConfigId: provider.id,
        providerModelId: `uat-meeting-${name}-availability-only`,
        displayName: `UAT meeting ${name} availability only`,
        capabilities: ["chat", "summarization", "json"],
        status: "active"
      });
      result[name] = { providerId: provider.id, modelId: model.id };
    }
    return result;
  });
  console.log(JSON.stringify(models));
} finally {
  await runner.destroy();
}
