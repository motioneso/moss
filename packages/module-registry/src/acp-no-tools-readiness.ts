import type { RpcConnection } from "@moss/chat";
import type { AiProviderKind } from "@moss/shared";
import { getAcpProviderRow, type AcpProviderKind } from "@moss/acp";
import type { ConstrainedCliReadiness } from "./meeting-output-runtime.js";

const KIND_BY_PROVIDER: Partial<Record<AiProviderKind, AcpProviderKind>> = {
  anthropic: "anthropic",
  "openai-compatible": "openai",
  google: "google"
};

type ProbeConnection = Pick<RpcConnection, "assertReady"> &
  Partial<Pick<RpcConnection, "probeProvider">>;

/**
 * Reachability with a typed reason. "model-unavailable" means no usable model for the
 * profile, "runner-offline" means the runner connection is not ready, and "not-signed-in"
 * means the runner reports the provider needs a login. A failed or slow sign-in lookup is
 * ignored so a flaky check never stops summaries on its own.
 */
export function createAcpNoToolsReadinessProbe(
  getConnection: () => ProbeConnection | undefined
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
    if (connection.probeProvider) {
      try {
        const result = await connection.probeProvider(
          { provider: providerKind as "anthropic" | "openai-compatible" | "google" },
          _actorUserId,
          { timeoutMs: 5_000, signal: _signal }
        );
        if (result.status === "needs_login") return "not-signed-in";
      } catch {
        // Unknown sign-in state does not stop the run; the run itself reports real failures.
      }
    }
    return "available";
  };
}
