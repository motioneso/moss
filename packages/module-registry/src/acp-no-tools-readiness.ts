import type { RpcConnection } from "@moss/chat";
import type { AiProviderKind } from "@moss/shared";
import { getAcpProviderRow, type AcpProviderKind } from "@moss/acp";
import type { ConstrainedCliReadiness } from "./meeting-output-runtime.js";

const KIND_BY_PROVIDER: Partial<Record<AiProviderKind, AcpProviderKind>> = {
  anthropic: "anthropic",
  "openai-compatible": "openai",
  google: "google"
};

/**
 * Cheap reachability only: the runner connection must be ready, and the
 * provider row must serve the no-tools profile. No model call runs here.
 */
export function createAcpNoToolsReadinessProbe(
  getConnection: () => Pick<RpcConnection, "assertReady"> | undefined
): (
  actorUserId: string,
  signal?: AbortSignal,
  providerKind?: AiProviderKind
) => Promise<ConstrainedCliReadiness> {
  return async (_actorUserId, _signal, providerKind = "anthropic") => {
    const kind = KIND_BY_PROVIDER[providerKind];
    if (!kind) return "model-unavailable";
    if (!getAcpProviderRow(kind).noToolsReady) return "model-unavailable";
    const connection = getConnection();
    if (!connection) return "model-unavailable";
    try {
      connection.assertReady();
    } catch {
      return "model-unavailable";
    }
    return "available";
  };
}
