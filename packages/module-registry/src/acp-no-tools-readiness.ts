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
 * Reachability with a typed reason. "model-unavailable" means no usable model for the
 * profile and "runner-offline" means the runner connection is not ready. The runner's
 * sign-in check is not consulted. On a live copy it answered "needs login" while chat worked,
 * so using it blocked summaries that would have run.
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
    if (!connection) return "runner-offline";
    try {
      connection.assertReady();
    } catch {
      return "runner-offline";
    }
    return "available";
  };
}
