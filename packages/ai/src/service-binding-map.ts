import {
  AI_MODEL_CAPABILITIES,
  isModuleServiceKey,
  type AiModelCapability,
  type AiModelTier,
  type AiServiceBinding,
  type AiServiceBindingMapDto,
  type ModuleServiceBindingMap
} from "@moss/shared";

// #870 Slice 1: tolerant parser for the `ai.service_bindings` blob in `app.instance_settings`.
// Mirrors `capability-route-map.ts` — we never trust the stored JSON shape (an older release, a
// hand-edited row, or a partial write could leave garbage), so every entry is shape-checked and
// unknown/malformed entries are dropped rather than throwing. A dropped entry just falls back to the
// resolver's unbound behavior (default-provider auto / needs-config), never a crash.

const RECOGNIZED_CAPABILITIES = new Set<AiModelCapability>(AI_MODEL_CAPABILITIES);
const RECOGNIZED_TIERS = new Set<AiModelTier>(["reasoning", "interactive", "economy"]);

/** Parse a single binding value; returns null if the shape is unrecognized. */
export function parseServiceBinding(value: unknown): AiServiceBinding | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;

  if (record.kind === "mode") {
    return RECOGNIZED_TIERS.has(record.tier as AiModelTier)
      ? { kind: "mode", tier: record.tier as AiModelTier }
      : null;
  }
  if (record.kind === "model") {
    return typeof record.modelId === "string" && record.modelId.length > 0
      ? { kind: "model", modelId: record.modelId }
      : null;
  }
  return null;
}

export function parseServiceBindingMap(value: unknown): AiServiceBindingMapDto {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  const bindings: AiServiceBindingMapDto = {};
  for (const [capability, raw] of Object.entries(value)) {
    if (!RECOGNIZED_CAPABILITIES.has(capability as AiModelCapability)) continue;
    const binding = parseServiceBinding(raw);
    if (binding) bindings[capability as AiModelCapability] = binding;
  }
  return bindings;
}

// #915 D6: module.* keys live in the SAME `ai.service_bindings` blob but parseServiceBindingMap
// above intentionally drops them (its capability filter is load-bearing for the user-facing map).
// This parallel parser keeps exactly the validated `module.*` keys instead — same tolerance rules:
// malformed entries are dropped, never thrown.
export function parseModuleServiceBindingMap(value: unknown): ModuleServiceBindingMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  const bindings: ModuleServiceBindingMap = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!isModuleServiceKey(key)) continue;
    const binding = parseServiceBinding(raw);
    if (binding) bindings[key] = binding;
  }
  return bindings;
}
