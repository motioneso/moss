import type { DataContextRunner } from "@moss/db";
import { AiRepository, createAiSecretCipher } from "@moss/ai";

/**
 * #2907 (plan 3.5): seeds the two JSON-capable classifiers the shadow UAT needs, both pointed at
 * test-only origins.
 *
 * - The fixture classifier answers the gate's choice questions through
 *   `tests/uat/fixtures/classifier-fixture-server.ts`, so a shadow attempt records a real
 *   `would_handle` decision.
 * - The unreachable classifier points at a closed loopback port, so the gate declines with a
 *   classifier error and the default model still answers.
 *
 * Both are `openai-compatible` so the classifier call goes through the HTTP structured adapter and
 * is recorded by the model activity log (3.6a). They are never referenced by production config.
 * Absent a base URL this chunk is never called at all (opt-in in levels.ts).
 */
export async function seedClassifierAiProviderChunk(
  runner: DataContextRunner,
  actorUserId: string,
  classifierFixtureBaseUrl: string
): Promise<void> {
  const repo = new AiRepository();
  const cipher = createAiSecretCipher();

  await runner.withDataContext({ actorUserId }, async (scopedDb) => {
    const fixture = await repo.createProvider(scopedDb, {
      providerKind: "openai-compatible",
      displayName: "UAT Classifier Fixture Provider",
      encryptedCredential: cipher.encryptJson({ apiKey: "uat-fixture-not-a-real-key" }),
      baseUrl: classifierFixtureBaseUrl
    });
    await repo.createModel(scopedDb, {
      providerConfigId: fixture.id,
      providerModelId: "uat-classifier-fixture-model",
      displayName: "UAT Classifier Fixture Model",
      capabilities: ["json"]
    });

    const unreachable = await repo.createProvider(scopedDb, {
      providerKind: "openai-compatible",
      displayName: "UAT Classifier Unreachable Provider",
      encryptedCredential: cipher.encryptJson({ apiKey: "uat-fixture-not-a-real-key" }),
      baseUrl: "http://127.0.0.1:9"
    });
    await repo.createModel(scopedDb, {
      providerConfigId: unreachable.id,
      providerModelId: "uat-classifier-unreachable-model",
      displayName: "UAT Classifier Unreachable Model",
      capabilities: ["json"]
    });
  });
}
