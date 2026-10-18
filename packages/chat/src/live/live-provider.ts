import type { AiConfiguredModelSafeRow, ProviderKind } from "@moss/ai";

import { UnsupportedApiKeyChatProviderError, UnsupportedLegacyCliProviderError } from "./errors.js";

/** Provider-kinds the live CLI runtime can drive (the narrow ProviderKind set). */
const LIVE_PROVIDER_KINDS: readonly ProviderKind[] = ["anthropic", "openai-compatible", "google"];

/**
 * Map the router's broad AiProviderKind onto the narrow live ProviderKind the CLI
 * engines support. ollama/custom have no live CLI engine in Phase 1 → throw a
 * clear error rather than silently dispatching an unsupported provider.
 */
export function toLiveProvider(model: AiConfiguredModelSafeRow): ProviderKind {
  const kind = model.provider_kind;
  if ((LIVE_PROVIDER_KINDS as readonly string[]).includes(kind)) {
    return kind as ProviderKind;
  }
  if (model.provider_auth_method === "api_key") throw new UnsupportedApiKeyChatProviderError();
  if (model.provider_auth_method === "cli" && !model.provider_acp_agent_id) {
    throw new UnsupportedLegacyCliProviderError();
  }
  throw new Error(
    `Active chat model uses provider kind "${kind}", which has no live CLI engine in Phase 1.`
  );
}
