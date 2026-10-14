import {
  AiRepository,
  HttpApiAdapter,
  createAiSecretCipher,
  parseAiApiKeyCredential,
  type ProviderKind,
  type StructuredProviderAdapter
} from "@moss/ai";
import { readScopedActorUserId, type DataContextDb, type DataContextRunner } from "@moss/db";
import {
  MemoryRepository,
  MemoryRetriever,
  createEmbeddingProvider,
  getEmbeddingProviderConfig
} from "@moss/memory";
import { HttpError } from "@moss/module-sdk";
import { PreferencesRepository } from "@moss/structured-state";
import type { QuietHoursPort } from "@moss/notifications";
import { renderPersonaText } from "@moss/shared";
import {
  RuntimeConfigResolver,
  notificationsQuietHoursValue,
  readQuietHoursAuthority,
  type PersonaPreviewInput
} from "@moss/settings";
import { UsefulnessFeedbackRepository } from "@moss/usefulness-feedback";

export async function createRuntimeEmbeddingProvider(scopedDb: DataContextDb) {
  // #2956: built per call, so the scoped actor is this call's owner.
  const scopedOwner = await readScopedActorUserId(scopedDb);
  return createEmbeddingProvider(
    await getEmbeddingProviderConfig(new RuntimeConfigResolver(scopedDb)),
    process.env,
    undefined,
    { source: "memory", ...(scopedOwner ? { ownerUserId: scopedOwner } : {}) }
  );
}

export const runtimeMemoryRetriever = {
  async retrieve(scopedDb: DataContextDb, query: string, limit?: number, sourceKind?: string) {
    const provider = await createRuntimeEmbeddingProvider(scopedDb);
    return new MemoryRetriever(provider, new MemoryRepository()).retrieve(
      scopedDb,
      query,
      limit,
      sourceKind
    );
  },
  async retrieveRecent(scopedDb: DataContextDb, limit?: number, sourceKind?: string) {
    const provider = await createRuntimeEmbeddingProvider(scopedDb);
    return new MemoryRetriever(provider, new MemoryRepository()).retrieveRecent(
      scopedDb,
      limit,
      sourceKind
    );
  }
};

const _quietHoursPreferencesRepo = new PreferencesRepository();
export const quietHoursPortImpl: QuietHoursPort = {
  // The one quiet-hours schedule: Profile, or the alert schedule it carries forward.
  getSettings: async (scopedDb) =>
    notificationsQuietHoursValue((await readQuietHoursAuthority(scopedDb)).authority),
  getLocaleTimezone: async (scopedDb) => {
    const locale = await _quietHoursPreferencesRepo.get(scopedDb, "locale");
    if (!locale || typeof locale !== "object" || Array.isArray(locale)) return null;
    const tz = (locale as Record<string, unknown>).timezone;
    return typeof tz === "string" && tz.length > 0 ? tz : null;
  }
};

export const usefulnessFeedbackRepository = new UsefulnessFeedbackRepository();

const PERSONA_PREVIEW_SAMPLE_TURN =
  "Give me a two-sentence morning check-in for a day with one important task and one slipped commitment.";
const PERSONA_PREVIEW_MAX_OUTPUT_TOKENS = 180;

export function createDefaultPersonaPreview(
  dataContext: DataContextRunner,
  deps: {
    readonly createCliStructuredAdapter?: (kind: ProviderKind) => StructuredProviderAdapter;
    readonly logger?: { warn(fields: Record<string, unknown>, message: string): void };
  } = {}
): (input: PersonaPreviewInput) => Promise<string> {
  const aiRepository = new AiRepository();
  const cipher = createAiSecretCipher();

  return async (input) =>
    dataContext.withDataContext(
      { actorUserId: input.actorUserId, requestId: "settings:persona-preview" },
      async (scopedDb) => {
        const model = await aiRepository.selectChatModelForUser(scopedDb);
        if (!model) {
          throw new HttpError(503, "No active chat-capable model is configured");
        }

        const provider = await aiRepository.selectProviderWithCredential(
          scopedDb,
          model.provider_config_id
        );
        if (!provider) {
          throw new HttpError(503, "The selected chat model provider is unavailable");
        }
        const personaBlock = renderPersonaText({
          assistantName: input.assistantName,
          personaText: input.personaText,
          userName: input.userName
        });
        const messages = [
          {
            role: "user" as const,
            content: `${personaBlock}\n\n${PERSONA_PREVIEW_SAMPLE_TURN}`
          }
        ];
        const modelInput = {
          provider_kind: model.provider_kind as ProviderKind,
          provider_model_id: model.provider_model_id
        };
        const schema = {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false
        };

        if (provider.auth_method === "cli") {
          if (!provider.acp_agent_id) {
            throw new HttpError(
              503,
              "The selected CLI provider has no ACP agent; add a supported provider in Admin > AI providers"
            );
          }
          const createAdapter = deps.createCliStructuredAdapter;
          if (!createAdapter) {
            throw new HttpError(
              503,
              "CLI preview transport is unavailable; start the CLI runner or multiplexer"
            );
          }
          try {
            return readPersonaPreviewResult(
              await createAdapter(modelInput.provider_kind).generateStructured({
                model: modelInput,
                messages,
                schema,
                maxOutputTokens: PERSONA_PREVIEW_MAX_OUTPUT_TOKENS,
                acpAgentId: provider.acp_agent_id,
                actorUserId: input.actorUserId,
                actionCode: "module.build"
              })
            );
          } catch (error) {
            if (error instanceof HttpError) throw error;
            deps.logger?.warn(
              {
                errorName: error instanceof Error ? error.name : typeof error,
                acpAgentId: provider.acp_agent_id
              },
              "persona preview ACP generation failed"
            );
            throw new HttpError(
              503,
              "CLI preview failed; check the selected CLI login and transport"
            );
          }
        }

        if (!provider.encrypted_credential) {
          throw new HttpError(503, "The selected chat model requires its API credential");
        }
        let apiKey: string;
        try {
          const credential = parseAiApiKeyCredential(
            cipher.decryptJson(provider.encrypted_credential)
          );
          if (!credential) throw new Error("missing api key");
          apiKey = credential.apiKey;
        } catch {
          throw new HttpError(503, "The selected chat model requires its API credential");
        }
        const adapter = new HttpApiAdapter(modelInput.provider_kind, apiKey, {
          baseUrl: provider.base_url ?? undefined
        });
        try {
          return (
            await adapter.generateChat({
              model: modelInput,
              messages,
              maxOutputTokens: PERSONA_PREVIEW_MAX_OUTPUT_TOKENS,
              actionCode: "module.build",
              ownerUserId: input.actorUserId
            })
          ).text;
        } catch {
          throw new HttpError(
            503,
            "The selected chat provider could not generate a preview response"
          );
        }
      }
    );
}

export function readPersonaPreviewResult(result: {
  readonly rawObject?: unknown;
  readonly rawText?: string;
}): string {
  const value =
    result.rawObject ??
    (() => {
      try {
        return JSON.parse(result.rawText ?? "");
      } catch {
        return null;
      }
    })();
  if (
    value &&
    typeof value === "object" &&
    typeof (value as { text?: unknown }).text === "string"
  ) {
    return (value as { text: string }).text;
  }
  throw new Error("Preview transport returned no text");
}
