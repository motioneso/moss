import type { AiConfiguredModelDto } from "@moss/shared";

export type ModelChoice = {
  readonly modelId: string | null;
  readonly model: AiConfiguredModelDto;
  readonly label: string;
  readonly providerLabel: string;
  readonly relation: "same-provider" | "cross-provider";
  readonly selected: boolean;
};

export interface ProviderGroup {
  readonly providerId: string;
  readonly label: string;
  readonly choices: readonly ModelChoice[];
  readonly selectedChoice: ModelChoice | null;
}

/** Search box appears once the picker holds more models than this. */
export const MODEL_SEARCH_THRESHOLD = 8;

/** Starrable choices are real models; the instance-default row (null id) is a routing choice. */
export function starrableChoices(choices: readonly ModelChoice[]): ModelChoice[] {
  return choices.filter((choice) => choice.modelId !== null);
}

/** Groups starrable choices by provider config, in the order providers first appear. */
export function groupChoicesByProvider(choices: readonly ModelChoice[]): ProviderGroup[] {
  const groups = new Map<string, { label: string; choices: ModelChoice[] }>();
  for (const choice of starrableChoices(choices)) {
    const key = choice.model.providerConfigId ?? `name:${choice.providerLabel}`;
    const group = groups.get(key);
    if (group) group.choices.push(choice);
    else groups.set(key, { label: choice.providerLabel, choices: [choice] });
  }
  return [...groups.entries()].map(([providerId, group]) => ({
    providerId,
    label: group.label,
    choices: group.choices,
    selectedChoice: group.choices.find((choice) => choice.selected) ?? null
  }));
}

/** Starred choices in star order; ids for models no longer offered are skipped. */
export function favoriteChoices(
  choices: readonly ModelChoice[],
  favoriteIds: readonly string[]
): ModelChoice[] {
  const byId = new Map(starrableChoices(choices).map((choice) => [choice.modelId, choice]));
  return favoriteIds.flatMap((id) => {
    const choice = byId.get(id);
    return choice ? [choice] : [];
  });
}

/**
 * Adds or removes one model id and drops ids for models no longer offered, so stale stars are
 * cleaned up on the next write.
 */
export function toggleFavoriteIds(
  favoriteIds: readonly string[],
  modelId: string,
  offeredIds: readonly string[]
): string[] {
  const offered = new Set(offeredIds);
  const kept = favoriteIds.filter((id) => id !== modelId && offered.has(id));
  return favoriteIds.includes(modelId) ? kept : [...kept, modelId];
}

/** Case-insensitive match on model name, provider model id, and provider name. */
export function filterChoices(choices: readonly ModelChoice[], query: string): ModelChoice[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [...choices];
  return starrableChoices(choices).filter((choice) =>
    `${choice.label} ${choice.model.providerModelId} ${choice.providerLabel}`
      .toLowerCase()
      .includes(needle)
  );
}
