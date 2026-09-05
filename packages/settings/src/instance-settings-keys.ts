import { RUNTIME_CONFIG_REGISTRY } from "./runtime-config-keys.js";

export interface InstanceSettingKeyEntry {
  readonly key: string;
  /**
   * Secret keys are excluded from the generic list (`GET /api/admin/settings`) and the
   * generic upsert (`PATCH /api/admin/settings/:key`) routes — they are written and read
   * ONLY through dedicated encrypted routes that store an AES-256-GCM envelope. The generic
   * upsert rejects them (400) so a plaintext value can never be written through that path.
   */
  readonly secret?: boolean;
}

export const INSTANCE_SETTINGS_REGISTRY: readonly InstanceSettingKeyEntry[] = [
  { key: "registration.enabled" },
  { key: "registration.requires_approval" },
  { key: "chat.multiplexer" },
  { key: "onboarding.state" },
  { key: "ai.chat_model_override.enabled" },
  // #1557 Phase 1 rollout flag: boolean-string, default absent = off. Selects the persistent
  // provider-chat-runtime adapter (warm child, `engine-selection.ts`) over the one-shot
  // bounded-fallback engine for anthropic sessions. Read pre-auth at boot the same way as
  // `chat.multiplexer` (`module-registry/src/chat-multiplexer.ts`).
  { key: "chat.persistent_runtime.enabled" },
  ...RUNTIME_CONFIG_REGISTRY.map((entry) => ({ key: entry.key, secret: entry.secret })),
  // Brave Search API key — written/read only via the dedicated encrypted web-search routes,
  // which store an AES-256-GCM EncryptedSecret envelope in `value` (never the plaintext key,
  // consistent with the 0059 RLS note that no plaintext secret lands in instance_settings).
  { key: "web.brave_search_api_key", secret: true },
  // Built-in web search instance switch: boolean, default true ("Use your model's built-in web search").
  { key: "web.native_search_enabled" }
] as const;

export const KNOWN_INSTANCE_SETTING_KEYS: ReadonlySet<string> = new Set(
  INSTANCE_SETTINGS_REGISTRY.map((e) => e.key)
);

/** Registry lookup for secret-key guards on the generic settings routes. */
export const SECRET_INSTANCE_SETTING_KEYS: ReadonlySet<string> = new Set(
  INSTANCE_SETTINGS_REGISTRY.filter((e) => e.secret).map((e) => e.key)
);

/** The single registry key under which the encrypted Brave Search API key is stored. */
export const WEB_SEARCH_API_KEY_SETTING = "web.brave_search_api_key";

/** Instance setting key toggling whether models with built-in search may search natively. */
export const WEB_NATIVE_SEARCH_ENABLED_SETTING = "web.native_search_enabled";
