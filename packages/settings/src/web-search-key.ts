import {
  JsonSecretCipher,
  resolveKeyring,
  resolveMossEnv,
  type DataContextDb,
  type EncryptedSecret,
  type Keyring
} from "@moss/db";

import { WEB_SEARCH_API_KEY_SETTING } from "./instance-settings-keys.js";
import type { SettingsRepository } from "./repository.js";
import { readNativeSearchEnabled } from "./web-search-engine-resolver.js";

/**
 * AES-256-GCM envelope for the instance-wide Brave Search API key. The plaintext key is
 * encrypted under the shared {@link JsonSecretCipher} (same family as connector/AI secrets)
 * and stored as the `value` jsonb of the `web.brave_search_api_key` instance setting — never
 * as plaintext. Decrypted at use, so a freshly-saved key takes effect without a restart.
 */
export type EncryptedWebSearchSecret = EncryptedSecret;

/** Field name inside the encrypted JSON payload. */
const API_KEY_FIELD = "apiKey";

/** {@link JsonSecretCipher} bound to the "web search secret" domain label. */
export class WebSearchSecretCipher extends JsonSecretCipher {
  constructor(keyring: Keyring) {
    super(keyring, "web search secret");
  }
}

/**
 * Build the web-search cipher. Reuses the AI secret keyring (`JARVIS_AI_SECRET_KEY`), already a
 * required deploy secret — no new key to provision. The domain label differs so envelopes are
 * self-describing, but the key material is shared with the AI cipher.
 */
export function createWebSearchSecretCipher(
  env: NodeJS.ProcessEnv = process.env
): WebSearchSecretCipher {
  return new WebSearchSecretCipher(
    resolveKeyring(
      "JARVIS_AI_SECRET_KEY",
      "JARVIS_AI_SECRET_KEY_ID",
      "JARVIS_AI_SECRET_KEYS",
      "jarv1s-development-ai-secret",
      env
    )
  );
}

/** Read the raw `value` wrapper for the web-search key setting, or null if unset. */
async function readWebSearchSettingValue(scopedDb: DataContextDb): Promise<unknown> {
  const row = await scopedDb.db
    .selectFrom("app.instance_settings")
    .select(["value"])
    .where("key", "=", WEB_SEARCH_API_KEY_SETTING)
    .executeTakeFirst();
  if (!row) return null;
  return (row.value as { value?: unknown } | null)?.value ?? null;
}

/**
 * Decrypt the stored instance Brave key. Returns null when no row is set. Throws if a row is
 * present but its envelope is malformed or undecryptable (a keyring/rotation problem the caller
 * decides how to surface) — the provider resolver swallows it and falls back to the env key.
 */
export async function readBraveSearchApiKey(
  scopedDb: DataContextDb,
  cipher: WebSearchSecretCipher
): Promise<string | null> {
  const stored = await readWebSearchSettingValue(scopedDb);
  if (stored == null) return null;
  const envelope = cipher.parseEnvelope(stored);
  const decrypted = cipher.decryptJson(envelope);
  const apiKey = decrypted[API_KEY_FIELD];
  return typeof apiKey === "string" && apiKey.length > 0 ? apiKey : null;
}

/** Whether an encrypted instance key row exists (no decryption — presence only, for GET). */
export async function hasInstanceWebSearchKey(scopedDb: DataContextDb): Promise<boolean> {
  return (await readWebSearchSettingValue(scopedDb)) != null;
}

export interface WebSearchKeyConfig {
  readonly configured: boolean;
  readonly source: "instance" | "env" | null;
  readonly nativeSearchEnabled: boolean;
}

/**
 * Report config status for the admin GET without ever returning the key/ciphertext. Instance
 * row presence wins (the value is encrypted); else the env var; else unconfigured.
 */
export async function getWebSearchKeyConfig(
  scopedDb: DataContextDb,
  env: NodeJS.ProcessEnv = process.env
): Promise<WebSearchKeyConfig> {
  const nativeSearchEnabled = await readNativeSearchEnabled(scopedDb);
  if (await hasInstanceWebSearchKey(scopedDb)) {
    return { configured: true, source: "instance", nativeSearchEnabled };
  }
  if ((resolveMossEnv(env, "JARVIS_BRAVE_SEARCH_API_KEY") ?? "").length > 0) {
    return { configured: true, source: "env", nativeSearchEnabled };
  }
  return { configured: false, source: null, nativeSearchEnabled };
}

/** Encrypt and upsert the instance Brave key. The plaintext never reaches audit metadata. */
export async function setBraveSearchApiKey(
  scopedDb: DataContextDb,
  repository: SettingsRepository,
  cipher: WebSearchSecretCipher,
  input: { apiKey: string; actorUserId: string; requestId: string }
): Promise<void> {
  const envelope = cipher.encryptJson({ [API_KEY_FIELD]: input.apiKey });
  await repository.upsertInstanceSetting(scopedDb, {
    key: WEB_SEARCH_API_KEY_SETTING,
    value: { value: envelope },
    updatedByUserId: input.actorUserId,
    requestId: input.requestId,
    action: "instance_setting.web_search_key.set",
    metadata: { key: WEB_SEARCH_API_KEY_SETTING }
  });
}

/** Delete the instance Brave key (revoke). Returns true if a row was removed. */
export async function clearBraveSearchApiKey(
  scopedDb: DataContextDb,
  repository: SettingsRepository,
  input: { actorUserId: string; requestId: string }
): Promise<boolean> {
  return repository.deleteInstanceSetting(scopedDb, {
    key: WEB_SEARCH_API_KEY_SETTING,
    actorUserId: input.actorUserId,
    requestId: input.requestId,
    action: "instance_setting.web_search_key.delete"
  });
}
