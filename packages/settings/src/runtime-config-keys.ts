import { CHAT_CLASSIFIER_GATE_MODE_CONFIG_KEY } from "@moss/shared";

export { CHAT_CLASSIFIER_GATE_MODE_CONFIG_KEY };

export type RuntimeConfigType = "string" | "enum" | "int" | "secret";

export interface RuntimeConfigKeyEntry {
  readonly key: string;
  readonly label: string;
  readonly type: RuntimeConfigType;
  readonly description: string;
  readonly defaultValue: string;
  readonly envVar: string;
  readonly enumValues?: readonly string[];
  readonly secret?: boolean;
  readonly moduleOwner: string;
  readonly minValue?: number;
  readonly maxValue?: number;
}

export const EMBED_PROVIDER_CONFIG_KEY = "ai.embed_provider";
export const EMBED_MODEL_CONFIG_KEY = "ai.embed_model";
export const BRAVE_API_KEY_CONFIG_KEY = "ai.brave_api_key";
export const CHAT_PERSISTENT_POOL_CAP_CONFIG_KEY = "chat.persistent_pool_cap";
export const CHAT_PERSISTENT_IDLE_REAP_MINUTES_CONFIG_KEY = "chat.persistent_idle_reap_minutes";

export const RUNTIME_CONFIG_REGISTRY: readonly RuntimeConfigKeyEntry[] = [
  {
    key: EMBED_PROVIDER_CONFIG_KEY,
    label: "Embedding provider",
    type: "enum",
    // #1313: "stub" (a SHA-256-stretched fake vector, test-only — see
    // packages/memory/src/embedding-provider.ts) is deliberately NOT listed here. This list
    // feeds both the admin/self-operation PATCH write-validation
    // (runtime-config-routes.ts's validateRuntimeValue) and the description shown to
    // operators — a real instance must never be steered onto the fake provider, which makes
    // semantic search silently return noise while the instance looks healthy. Test/CI/UAT
    // harnesses still reach the stub provider through an explicit escape hatch
    // (NODE_ENV=test or JARVIS_ALLOW_STUB_EMBEDDINGS=1), enforced in
    // packages/memory/src/embedding-provider-config.ts, never through this enum.
    description: "Where notes/knowledge embeddings are generated. 'local' = on-device model.",
    defaultValue: "local",
    envVar: "JARVIS_EMBED_PROVIDER",
    enumValues: ["local"],
    moduleOwner: "memory"
  },
  {
    key: EMBED_MODEL_CONFIG_KEY,
    label: "Embedding model",
    type: "string",
    description: "Model id for the local embedding provider. Leave blank for the provider default.",
    defaultValue: "",
    envVar: "JARVIS_EMBED_MODEL",
    moduleOwner: "memory"
  },
  {
    key: BRAVE_API_KEY_CONFIG_KEY,
    label: "Brave Search API key",
    type: "secret",
    description: "API key for Brave Search. Leave blank to disable web search.",
    defaultValue: "",
    envVar: "JARVIS_BRAVE_API_KEY",
    secret: true,
    moduleOwner: "ai"
  },
  {
    key: CHAT_PERSISTENT_POOL_CAP_CONFIG_KEY,
    label: "Persistent chat pool cap",
    type: "int",
    description: "Max warm persistent-provider child processes held at once.",
    defaultValue: "4",
    envVar: "MOSS_CHAT_PERSISTENT_POOL_CAP",
    minValue: 1,
    moduleOwner: "chat"
  },
  {
    key: CHAT_PERSISTENT_IDLE_REAP_MINUTES_CONFIG_KEY,
    label: "Persistent chat idle reap minutes",
    type: "int",
    description: "Minutes an idle persistent child may sit before being reaped.",
    defaultValue: "30",
    envVar: "MOSS_CHAT_PERSISTENT_IDLE_REAP_MINUTES",
    minValue: 1,
    moduleOwner: "chat"
  },
  // Classifier gate, task 1.2 (#2881, Ben's ruling 1, 2026-10-01). One ADMIN-WIDE switch for the
  // whole instance, sitting beside the Classifier (sorting) binding under Settings > Assistant & AI.
  // "off" is the default and the missing-value default. "on" may only be stored when an approved
  // tool release record exists; that check lives in runtime-config-routes.ts, not here (this
  // registry only validates the enum). Scope is intentionally instance-wide, not per user.
  {
    key: CHAT_CLASSIFIER_GATE_MODE_CONFIG_KEY,
    label: "Classifier gate",
    type: "enum",
    description:
      "Whether Moss may route eligible chat messages to the classifier model instead of the main " +
      "model. Off sends nothing to the classifier. Shadow records what the gate would do without " +
      "acting. On lets the gate act; turning it on requires an approved tool release, and every " +
      "user's eligible messages then reach the classifier provider.",
    defaultValue: "off",
    envVar: "MOSS_CHAT_CLASSIFIER_GATE_MODE",
    enumValues: ["off", "shadow", "on"],
    moduleOwner: "chat"
  }
] as const;

const RUNTIME_CONFIG_BY_KEY = new Map(RUNTIME_CONFIG_REGISTRY.map((entry) => [entry.key, entry]));

export function getRuntimeConfigEntry(key: string): RuntimeConfigKeyEntry | undefined {
  return RUNTIME_CONFIG_BY_KEY.get(key);
}
