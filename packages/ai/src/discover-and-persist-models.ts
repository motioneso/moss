import type { DataContextDb } from "@moss/db";
import type { AiAuthMethod, AiProviderKind } from "@moss/shared";

import type { ModelDiscoveryReason, ModelDiscoveryService } from "./model-discovery.js";
import type { AiRepository } from "./repository.js";

/** #2208: what the refresh route reports back — why nothing changed, when that is the case. */
export interface DiscoverAndPersistModelsOutcome {
  readonly reason?: ModelDiscoveryReason;
  readonly message?: string;
}

export interface DiscoverAndPersistModelsInput {
  readonly actorUserId: string;
  readonly providerId: string;
  readonly providerKind: AiProviderKind;
  readonly authMethod: AiAuthMethod;
  readonly baseUrl: string | null;
  readonly credential: unknown;
}

/**
 * #982/#869 D2/D6: one discovery path for create, update, login-ready, and list self-heal.
 * CLI providers whose vendor answered (#2208: the runner's live list, `reason` absent) are
 * reconciled by natural key: DISCOVERED rows absent from the new list are removed, unchanged rows
 * keep their ids, `manual` rows (added by hand) and the #367 sentinel survive. A failed, unsupported, or unavailable CLI list changes
 * NOTHING (no deletes on a bad call). API-key providers keep insert-only behavior because their
 * live `/models` response must not erase admin choices.
 */
export async function discoverAndPersistModels(
  scopedDb: DataContextDb,
  input: DiscoverAndPersistModelsInput,
  deps: { readonly repository: AiRepository; readonly modelDiscovery: ModelDiscoveryService }
): Promise<DiscoverAndPersistModelsOutcome> {
  const discovered = await deps.modelDiscovery.discoverModels(
    `${input.actorUserId}:${input.providerId}`,
    {
      providerKind: input.providerKind,
      authMethod: input.authMethod,
      baseUrl: input.baseUrl,
      credential: input.credential
    }
  );
  // #2208: only a list the vendor actually returned may replace rows. `reason` set ⇒ the runner
  // could not list (not logged in / unsupported / error / no runner) ⇒ touch nothing.
  if (discovered.reason !== undefined) {
    return {
      reason: discovered.reason,
      ...(discovered.message !== undefined ? { message: discovered.message } : {})
    };
  }
  const replaceCliModels = input.authMethod === "cli";
  const models = discovered.models.map((model) => ({ ...model, status: "active" as const }));

  if (replaceCliModels) {
    await deps.repository.deleteModelsForProviderExceptSentinel(
      scopedDb,
      input.providerId,
      models.map((model) => model.providerModelId)
    );
  }

  await deps.repository.upsertDiscoveredModels(scopedDb, input.providerId, models);
  return {};
}
