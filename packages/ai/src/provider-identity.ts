import { getAcpProviderRowByAgentId } from "@moss/acp";
import type { AiProviderKind } from "@moss/shared";

/**
 * Compatibility mapping for CLI configs created before ACP agent identity was persisted.
 * `openai-compatible` API configs do not use this mapping; only legacy CLI rows were Codex.
 */
export const DEFAULT_CLI_AGENT_ID_BY_PROVIDER_KIND: Partial<Record<AiProviderKind, string>> = {
  anthropic: "claude-acp",
  "openai-compatible": "codex-acp",
  google: "antigravity-acp"
};

export function defaultCliAgentIdForProviderKind(providerKind: AiProviderKind): string | undefined {
  return DEFAULT_CLI_AGENT_ID_BY_PROVIDER_KIND[providerKind];
}

export function isAcpAgentCompatibleWithProviderKind(
  providerKind: AiProviderKind,
  agentId: string
): boolean {
  const row = getAcpProviderRowByAgentId(agentId);
  if (!row) return false;
  if (providerKind === "openai-compatible") return row.kind === "openai" || row.kind === "opencode";
  if (providerKind === "anthropic") return row.kind === "anthropic";
  if (providerKind === "google") return row.kind === "google";
  return false;
}
