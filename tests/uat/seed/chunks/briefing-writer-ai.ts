import type { DataContextRunner } from "@moss/db";
import { AiRepository, createAiSecretCipher } from "@moss/ai";

/**
 * [task:p8-briefing-writer-unreachable]: seeds a real, working `openai-compatible` provider for
 * briefing synthesis, pointed at briefing-writer-fixture-server.ts's POST /v1/chat/completions
 * route (baseUrl), so synthesis runs for real over HTTP with zero external cost or token
 * requirement — and returns the same fixed prose on every run.
 *
 * Mirrors seedJobSearchAiProviderChunk's (./job-search-ai.ts) exact shape — same
 * fake-credential pattern (encryptedCredential is never a real secret, `providerKind`/
 * `capabilities` are the only fields that matter to the caller) — with two deliberate
 * differences. The model carries `summarization` at the `economy` tier (never `json`), which is
 * what synthesizeWithConfiguredModel (packages/briefings/src/compose-shared.ts) selects on.
 * And there is deliberately NO service binding: synthesis resolves the writer through automatic
 * capability routing, not a binding — and a binding write here is exactly how a second fixture
 * could steal another module's model. The news binding (module.news, set by seedAiProviderChunk
 * in ./ai.ts) names its model by id and is never touched: this chunk performs two inserts and
 * zero updates, so news resolution cannot move.
 *
 * Opt-in only (see tests/uat/provisioner.ts's UatProvisionOptions.withBriefingWriterFixture and
 * tests/uat/seed/levels.ts's SeedOptions.briefingWriterAiProviderBaseUrl): absent a baseUrl,
 * this is never called at all. It is deliberately NOT one of levels.ts's ADMIN_DATA_CHUNKS —
 * creating an AI provider/model row is data-plane only (no external_modules row), but nothing
 * writer-shaped joins the default ladder.
 */
export async function seedBriefingWriterAiProviderChunk(
  runner: DataContextRunner,
  actorUserId: string,
  baseUrl: string
): Promise<void> {
  const repo = new AiRepository();
  const cipher = createAiSecretCipher();

  await runner.withDataContext({ actorUserId }, async (scopedDb) => {
    const provider = await repo.createProvider(scopedDb, {
      providerKind: "openai-compatible",
      displayName: "UAT Briefing Writer Fixture Provider",
      encryptedCredential: cipher.encryptJson({ apiKey: "uat-fixture-not-a-real-key" }),
      baseUrl
    });
    await repo.createModel(scopedDb, {
      providerConfigId: provider.id,
      providerModelId: "uat-briefing-writer-fixture-model",
      displayName: "UAT Briefing Writer Fixture Model",
      capabilities: ["summarization"],
      tier: "economy"
    });
  });
}
