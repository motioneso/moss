import { describe, expect, it } from "vitest";

import {
  BRAVE_API_KEY_CONFIG_KEY,
  CHAT_PERSISTENT_IDLE_REAP_MINUTES_CONFIG_KEY,
  CHAT_PERSISTENT_POOL_CAP_CONFIG_KEY,
  EMBED_MODEL_CONFIG_KEY,
  EMBED_PROVIDER_CONFIG_KEY,
  RUNTIME_CONFIG_REGISTRY,
  getRuntimeConfigEntry
} from "../../packages/settings/src/runtime-config-keys.js";
import {
  KNOWN_INSTANCE_SETTING_KEYS,
  SECRET_INSTANCE_SETTING_KEYS
} from "../../packages/settings/src/instance-settings-keys.js";

describe("runtime config registry", () => {
  it("registers embedding keys as non-secret instance settings", () => {
    expect(getRuntimeConfigEntry(EMBED_PROVIDER_CONFIG_KEY)).toMatchObject({
      key: "ai.embed_provider",
      type: "enum",
      defaultValue: "local",
      envVar: "JARVIS_EMBED_PROVIDER",
      // #1313: "stub" (test-only fake embeddings) is deliberately excluded from the settable
      // enum — a real instance must never be PATCHed onto it. See
      // packages/settings/src/runtime-config-keys.ts for the full rationale.
      enumValues: ["local"],
      moduleOwner: "memory"
    });
    expect(getRuntimeConfigEntry(EMBED_MODEL_CONFIG_KEY)).toMatchObject({
      key: "ai.embed_model",
      type: "string",
      defaultValue: "",
      envVar: "JARVIS_EMBED_MODEL",
      moduleOwner: "memory"
    });
    expect(KNOWN_INSTANCE_SETTING_KEYS.has(EMBED_PROVIDER_CONFIG_KEY)).toBe(true);
    expect(KNOWN_INSTANCE_SETTING_KEYS.has(EMBED_MODEL_CONFIG_KEY)).toBe(true);
    expect(SECRET_INSTANCE_SETTING_KEYS.has(EMBED_PROVIDER_CONFIG_KEY)).toBe(false);
    expect(SECRET_INSTANCE_SETTING_KEYS.has(EMBED_MODEL_CONFIG_KEY)).toBe(false);
    expect(getRuntimeConfigEntry(BRAVE_API_KEY_CONFIG_KEY)).toMatchObject({
      key: "ai.brave_api_key",
      type: "secret",
      secret: true,
      envVar: "JARVIS_BRAVE_API_KEY",
      moduleOwner: "ai"
    });
    expect(SECRET_INSTANCE_SETTING_KEYS.has(BRAVE_API_KEY_CONFIG_KEY)).toBe(true);
    expect(RUNTIME_CONFIG_REGISTRY).toHaveLength(5);
  });

  it("registers persistent-pool keys with minValue bounds (#1554)", () => {
    expect(getRuntimeConfigEntry(CHAT_PERSISTENT_POOL_CAP_CONFIG_KEY)).toMatchObject({
      key: "chat.persistent_pool_cap",
      type: "int",
      defaultValue: "4",
      envVar: "MOSS_CHAT_PERSISTENT_POOL_CAP",
      minValue: 1,
      moduleOwner: "chat"
    });
    expect(getRuntimeConfigEntry(CHAT_PERSISTENT_IDLE_REAP_MINUTES_CONFIG_KEY)).toMatchObject({
      key: "chat.persistent_idle_reap_minutes",
      type: "int",
      defaultValue: "30",
      envVar: "MOSS_CHAT_PERSISTENT_IDLE_REAP_MINUTES",
      minValue: 1,
      moduleOwner: "chat"
    });
    expect(KNOWN_INSTANCE_SETTING_KEYS.has(CHAT_PERSISTENT_POOL_CAP_CONFIG_KEY)).toBe(true);
    expect(KNOWN_INSTANCE_SETTING_KEYS.has(CHAT_PERSISTENT_IDLE_REAP_MINUTES_CONFIG_KEY)).toBe(
      true
    );
  });
});
