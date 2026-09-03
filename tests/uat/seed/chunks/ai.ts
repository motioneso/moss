import type { DataContextRunner } from "@moss/db";
import { AiRepository, createAiSecretCipher } from "@moss/ai";

/**
 * #1025 spec §4.4: without an active provider+model bound to module.news, the
 * news settings UI 503s ("Topic checking is unavailable right now" —
 * packages/news/src/settings/index.tsx). A fake, non-functional provider is
 * enough for UAT — Playwright only asserts the settings surface stops 503ing,
 * it never calls the real upstream AI API.
 */
export async function seedAiProviderChunk(
  runner: DataContextRunner,
  actorUserId: string,
  options: { readonly bindNews: boolean } = { bindNews: true }
): Promise<void> {
  if (!options.bindNews) return; // #1110: no default provider at all ⇒ hasJsonModel()
  // genuinely false — see resolveModelForService's implicit-default-provider fallback
  // (packages/ai/src/repository.ts resolveDefaultProviderId): merely leaving module.news
  // unbound is NOT enough, the provider still wins as instance-default otherwise.
  const repo = new AiRepository();
  const cipher = createAiSecretCipher();

  await runner.withDataContext({ actorUserId }, async (scopedDb) => {
    const provider = await repo.createProvider(scopedDb, {
      providerKind: "custom",
      displayName: "UAT Fake Provider",
      encryptedCredential: cipher.encryptJson({ cli: true }) // #1025: never a real credential
    });
    const model = await repo.createModel(scopedDb, {
      providerConfigId: provider.id,
      providerModelId: "uat-fake-json-model",
      displayName: "UAT Fake JSON Model",
      capabilities: ["json"]
    });
    await repo.setServiceBinding(
      scopedDb,
      "module.news",
      { kind: "model", modelId: model.id },
      actorUserId
    );
  });
}

/**
 * #2175: three audit-log rows for the signed-in admin so the Settings > Activity live-path spec
 * (tests/uat/specs/2175-activity-outcomes.uat.spec.ts) can prove the two new outcome labels and
 * the recorded call duration render through the real UI. Written through the app-runtime role
 * under the admin's own data context, exactly as the gateway writes them, so RLS is exercised.
 * Opt-in only (SeedOptions.activityOutcomeFixture); default admin+data data is unchanged.
 */
export const UAT_ACTIVITY_OUTCOME_ROWS = {
  suppressed: { id: "aaaaaaaa-2175-4000-8000-000000000001", toolName: "uat.suppressedCall" },
  refused: { id: "aaaaaaaa-2175-4000-8000-000000000002", toolName: "uat.refusedCall" },
  success: {
    id: "aaaaaaaa-2175-4000-8000-000000000003",
    toolName: "uat.timedCall",
    durationMs: 1234
  }
} as const;

export async function seedActivityOutcomeFixture(
  runner: DataContextRunner,
  actorUserId: string
): Promise<void> {
  const repo = new AiRepository();
  const shared = {
    ownerUserId: actorUserId,
    toolModuleId: "uat",
    actionFamilyId: null,
    actionKind: "write",
    approvalMode: "auto",
    errorClass: null,
    requestId: null,
    chatSessionId: null,
    sourceSurface: "chat",
    inputSummary: null
  } as const;
  await runner.withDataContext({ actorUserId }, async (scopedDb) => {
    await repo.insertActionAuditLog(scopedDb, {
      ...shared,
      id: UAT_ACTIVITY_OUTCOME_ROWS.suppressed.id,
      toolName: UAT_ACTIVITY_OUTCOME_ROWS.suppressed.toolName,
      outcome: "suppressed",
      durationMs: 12
    });
    await repo.insertActionAuditLog(scopedDb, {
      ...shared,
      id: UAT_ACTIVITY_OUTCOME_ROWS.refused.id,
      toolName: UAT_ACTIVITY_OUTCOME_ROWS.refused.toolName,
      outcome: "refused",
      durationMs: 3
    });
    await repo.insertActionAuditLog(scopedDb, {
      ...shared,
      id: UAT_ACTIVITY_OUTCOME_ROWS.success.id,
      toolName: UAT_ACTIVITY_OUTCOME_ROWS.success.toolName,
      outcome: "success",
      durationMs: UAT_ACTIVITY_OUTCOME_ROWS.success.durationMs
    });
  });
}
