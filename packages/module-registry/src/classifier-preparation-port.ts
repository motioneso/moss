import { AiRepository, createAiSecretCipher, generateStructured } from "@moss/ai";
import type { GenerateStructuredDeps } from "@moss/ai";
import type { ClassifierPreparationPort } from "@moss/integrations";
import { isSortingProviderKind, MODULE_WORKER_SERVICE_KEY } from "@moss/shared";

/**
 * Composition root for the 2b.3 preparation port (#2894). It selects the owner's current default
 * chat model through the same selection chat uses, and runs the structured adapter on that explicit
 * model. It never routes by service binding, never falls back to the classifier or another model,
 * and never edits the provider adapters — it only calls `generateStructured`.
 */
export function createClassifierPreparationPort(deps: {
  readonly createCliStructuredAdapter?: GenerateStructuredDeps["createCliStructuredAdapter"];
}): ClassifierPreparationPort {
  const repository = new AiRepository();
  const cipher = createAiSecretCipher();

  return {
    async selectDefaultChatModel(scopedDb) {
      const model = await repository.selectChatModelForUser(scopedDb);
      if (!model) return null;
      return {
        model: {
          id: model.id,
          providerConfigId: model.provider_config_id,
          providerKind: model.provider_kind,
          providerModelId: model.provider_model_id
        },
        // A provider kind the structured path cannot execute (e.g. choice-only System One) must
        // show a setup failure, so the pure module is told up front. No silent switch.
        structured: isSortingProviderKind(model.provider_kind),
        // Shown as who sorted a tool. The integrations module validates them before storing.
        displayNames: { model: model.display_name, provider: model.provider_display_name }
      };
    },

    async runStructuredDraft(scopedDb, input) {
      const result = await generateStructured(
        scopedDb,
        {
          service: input.service ?? MODULE_WORKER_SERVICE_KEY,
          schema: input.schema,
          ...(input.replySchema ? { replySchema: input.replySchema } : {}),
          prompt: input.prompt,
          explicitModel: {
            id: input.model.id,
            provider_config_id: input.model.providerConfigId,
            provider_kind: input.model.providerKind,
            provider_model_id: input.model.providerModelId
          },
          maxOutputTokens: input.maxOutputTokens,
          // One provider attempt, no repair retry: a setup charge is never repeated automatically.
          singleAttempt: true,
          servedByLabel: "main",
          ...(input.signal ? { signal: input.signal } : {})
        },
        {
          repository,
          cipher,
          ...(deps.createCliStructuredAdapter
            ? { createCliStructuredAdapter: deps.createCliStructuredAdapter }
            : {})
        }
      );
      if (result.ok) return { ok: true, object: result.object, usage: result.usage };
      return { ok: false, error: result.error };
    }
  };
}
