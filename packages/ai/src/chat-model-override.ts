export const CHAT_MODEL_OVERRIDE_PREFERENCE_KEY = "chat.modelOverride";
export const CHAT_MODEL_OVERRIDE_SETTING_KEY = "ai.chat_model_override.enabled";
export const CHAT_MODEL_FAVORITES_PREFERENCE_KEY = "chat.favoriteModels";

/** Keeps the first occurrence of each non-empty string id, up to `max` ids. */
export function normalizeChatModelFavorites(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0 || ids.includes(item)) continue;
    ids.push(item);
    if (ids.length >= max) break;
  }
  return ids;
}

export interface ChatModelOverrideCandidate {
  readonly id: string;
  readonly providerStatus: "active" | "error" | "disabled" | "revoked";
  readonly capabilities: readonly string[];
  readonly status: "active" | "disabled";
  readonly allowUserOverride: boolean;
}

export interface ResolveChatModelOverrideInput<T extends ChatModelOverrideCandidate> {
  readonly defaultModel: T | null | undefined;
  readonly requestedModelId: string | null | undefined;
  readonly overrideEnabled: boolean;
  readonly models: readonly T[];
}

export interface ResolveChatModelOverrideResult<T extends ChatModelOverrideCandidate> {
  readonly selectedModel: T | null;
  readonly effectiveOverrideModelId: string | null;
  /** All models shown in the UI (includes the instance default even if not user-overridable). */
  readonly allowedModels: readonly T[];
  /** Models the user may actually select as an override (allowUserOverride=true only). */
  readonly selectableOverrideModels: readonly T[];
}

export function resolveChatModelOverride<T extends ChatModelOverrideCandidate>(
  input: ResolveChatModelOverrideInput<T>
): ResolveChatModelOverrideResult<T> {
  const candidates = input.models.filter(isActiveChatModel);
  const defaultModel =
    input.defaultModel && isActiveChatModel(input.defaultModel) ? input.defaultModel : null;
  const allowed = candidates.filter((model) => model.allowUserOverride);
  const allowedModels =
    defaultModel && !allowed.some((model) => model.id === defaultModel.id)
      ? [defaultModel, ...allowed]
      : allowed;
  const override = input.overrideEnabled
    ? allowed.find((model) => model.id === input.requestedModelId)
    : undefined;
  const selectedModel = override ?? defaultModel;

  return {
    selectedModel,
    effectiveOverrideModelId: override?.id ?? null,
    allowedModels,
    selectableOverrideModels: allowed
  };
}

function isActiveChatModel(model: ChatModelOverrideCandidate): boolean {
  return (
    model.status === "active" &&
    model.providerStatus === "active" &&
    model.capabilities.includes("chat")
  );
}
