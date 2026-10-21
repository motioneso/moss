import type {
  AiRepository,
  AiSecretCipher,
  DiscoverAndPersistModelsInput,
  DiscoverAndPersistModelsOutcome
} from "@moss/ai";
import type { DataContextDb } from "@moss/db";

import type { DevInstanceConfig } from "./config.js";

/** Display name of the one API-key row the dev instance owns. Re-runs find it by this name. */
export const DEV_API_KEY_PROVIDER_NAME = "Dev instance API key";

const NO_CHAT_MODEL_MESSAGE =
  `"${DEV_API_KEY_PROVIDER_NAME}" listed no chat model Moss can use. Pick one for it in ` +
  "Admin > AI providers, or check the provider's model list.";

export interface EnsureApiKeyProviderDeps {
  readonly repository: Pick<
    AiRepository,
    | "listProviders"
    | "createProvider"
    | "updateProvider"
    | "resolveDefaultProviderId"
    | "setInstanceDefaultProvider"
    | "selectChatModelForUser"
  >;
  readonly cipher: Pick<AiSecretCipher, "encryptJson">;
  readonly discoverModels: (
    scopedDb: DataContextDb,
    input: DiscoverAndPersistModelsInput
  ) => Promise<DiscoverAndPersistModelsOutcome>;
  readonly readKeyFile: (path: string) => Promise<string>;
}

export interface ApiKeyProviderOutcome {
  readonly changed: boolean;
  readonly providerId: string;
  readonly chatModelId: string;
}

/**
 * Creates or updates the dev instance's API-key row, lists its models and makes it the instance
 * default. Errors carry the discovery reason only: the provider's own message can echo the key.
 */
export async function ensureApiKeyProvider(
  scopedDb: DataContextDb,
  adminUserId: string,
  config: DevInstanceConfig,
  deps: EnsureApiKeyProviderDeps
): Promise<ApiKeyProviderOutcome> {
  if (config.providerAuth !== "api_key" || config.providerKeyFilePath === null) {
    throw new Error("ensureApiKeyProvider needs an api_key dev-instance config");
  }

  const apiKey = (await deps.readKeyFile(config.providerKeyFilePath)).trim();
  if (apiKey.length === 0) {
    throw new Error(`The API key file ${config.providerKeyFilePath} is empty`);
  }
  const encryptedCredential = deps.cipher.encryptJson({ apiKey });

  const previousDefaultId = await deps.repository.resolveDefaultProviderId(scopedDb);
  const existing = (await deps.repository.listProviders(scopedDb)).find(
    (row) =>
      row.display_name === DEV_API_KEY_PROVIDER_NAME &&
      row.auth_method === "api_key" &&
      row.provider_kind === config.providerKind &&
      row.revoked_at === null
  );
  const provider = existing
    ? await deps.repository.updateProvider(scopedDb, existing.id, {
        baseUrl: config.providerBaseUrl,
        status: "active",
        encryptedCredential
      })
    : await deps.repository.createProvider(scopedDb, {
        providerKind: config.providerKind,
        displayName: DEV_API_KEY_PROVIDER_NAME,
        baseUrl: config.providerBaseUrl,
        authMethod: "api_key",
        encryptedCredential
      });
  if (!provider) {
    throw new Error(`Could not update the "${DEV_API_KEY_PROVIDER_NAME}" provider row`);
  }

  const discovery = await deps.discoverModels(scopedDb, {
    actorUserId: adminUserId,
    providerId: provider.id,
    providerKind: provider.provider_kind,
    acpAgentId: null,
    authMethod: "api_key",
    baseUrl: provider.base_url,
    credential: { apiKey }
  });
  if (discovery.reason !== undefined) {
    throw new Error(
      `Listing models for "${DEV_API_KEY_PROVIDER_NAME}" failed (${discovery.reason}). ` +
        "Check MOSS_DEV_INSTANCE_PROVIDER_BASE_URL and the key file."
    );
  }
  // Older model rows survive discovery, so only this run's list counts.
  const listed = discovery.discoveredModelIds ?? [];
  if (listed.length === 0) throw new Error(NO_CHAT_MODEL_MESSAGE);

  const promoted = await deps.repository.setInstanceDefaultProvider(scopedDb, provider.id);
  if (!promoted) {
    throw new Error(`Could not make "${DEV_API_KEY_PROVIDER_NAME}" the default provider`);
  }

  const model = await deps.repository.selectChatModelForUser(scopedDb);
  if (
    !model ||
    model.provider_config_id !== provider.id ||
    !listed.includes(model.provider_model_id)
  ) {
    throw new Error(NO_CHAT_MODEL_MESSAGE);
  }

  return {
    changed: existing === undefined || previousDefaultId !== provider.id,
    providerId: provider.id,
    chatModelId: model.id
  };
}
