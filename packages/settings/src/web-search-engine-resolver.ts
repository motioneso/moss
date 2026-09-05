import { assertDataContextDb, type DataContextDb } from "@moss/db";

import { WEB_NATIVE_SEARCH_ENABLED_SETTING } from "./instance-settings-keys.js";
import type { SettingsRepository } from "./repository.js";
import { getWebSearchKeyConfig } from "./web-search-key.js";

export type WebSearchEngineResolutionReason =
  | "no-key-no-native-model"
  | "native-disabled"
  | "model-has-no-search";

export interface WebSearchActorChatModel {
  readonly id?: string;
  readonly providerModelId?: string;
  readonly capabilities: readonly string[];
}

export type WebSearchEngineResolution =
  | { readonly engine: "brave" }
  | { readonly engine: "model-native"; readonly model: WebSearchActorChatModel }
  | { readonly engine: "none"; readonly reason: WebSearchEngineResolutionReason };

/** Read whether built-in model web search is enabled (default: true). */
export async function readNativeSearchEnabled(scopedDb: DataContextDb): Promise<boolean> {
  assertDataContextDb(scopedDb);
  const row = await scopedDb.db
    .selectFrom("app.instance_settings")
    .select(["value"])
    .where("key", "=", WEB_NATIVE_SEARCH_ENABLED_SETTING)
    .executeTakeFirst();
  if (!row) return true;
  const val = (row.value as { value?: unknown } | null)?.value;
  return typeof val === "boolean" ? val : true;
}

/** Set whether built-in model web search is enabled. */
export async function setNativeSearchEnabled(
  scopedDb: DataContextDb,
  repository: SettingsRepository,
  input: { enabled: boolean; actorUserId: string; requestId: string }
): Promise<void> {
  assertDataContextDb(scopedDb);
  await repository.upsertInstanceSetting(scopedDb, {
    key: WEB_NATIVE_SEARCH_ENABLED_SETTING,
    value: { value: input.enabled },
    updatedByUserId: input.actorUserId,
    requestId: input.requestId,
    action: "instance_setting.native_search_enabled.set",
    metadata: { key: WEB_NATIVE_SEARCH_ENABLED_SETTING }
  });
}

/**
 * Resolves the active web search engine for an actor given their effective chat model.
 * Precedence:
 * 1. Brave key saved (instance key or env key) -> "brave"
 * 2. Native search switch is disabled -> "none", reason: "native-disabled"
 * 3. Native search switch is enabled:
 *    - Model has "web-search" capability -> "model-native", model
 *    - Model exists but lacks "web-search" capability -> "none", reason: "model-has-no-search"
 *    - Model is null or undefined -> "none", reason: "no-key-no-native-model"
 */
export async function resolveWebSearchEngine(
  scopedDb: DataContextDb,
  actorChatModel: WebSearchActorChatModel | null | undefined,
  env: NodeJS.ProcessEnv = process.env
): Promise<WebSearchEngineResolution> {
  assertDataContextDb(scopedDb);

  const braveStatus = await getWebSearchKeyConfig(scopedDb, env);
  if (braveStatus.configured) {
    return { engine: "brave" };
  }

  const nativeEnabled = await readNativeSearchEnabled(scopedDb);
  if (!nativeEnabled) {
    return { engine: "none", reason: "native-disabled" };
  }

  if (!actorChatModel) {
    return { engine: "none", reason: "no-key-no-native-model" };
  }

  if (actorChatModel.capabilities.includes("web-search")) {
    return { engine: "model-native", model: actorChatModel };
  }

  return { engine: "none", reason: "model-has-no-search" };
}
