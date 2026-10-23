import type { RpcConnection } from "@moss/chat";
import type { AiProviderKind } from "@moss/shared";
import type { ConstrainedCliReadiness } from "./meeting-output-runtime.js";

/** Shared API/worker probe; resolve the connection at call time for API adoption. */
export function createConstrainedCliReadinessProbe(
  getConnection: () => Pick<RpcConnection, "probeProvider"> | undefined
): (
  actorUserId: string,
  signal?: AbortSignal,
  providerKind?: AiProviderKind
) => Promise<ConstrainedCliReadiness> {
  return async (actorUserId, signal, providerKind = "anthropic") => {
    const connection = getConnection();
    if (!connection) return "model-unavailable";
    if (
      providerKind !== "anthropic" &&
      providerKind !== "openai-compatible" &&
      providerKind !== "google"
    )
      return "model-unavailable";
    const result = await connection.probeProvider(
      { provider: providerKind, constrainedStructured: true },
      actorUserId,
      { timeoutMs: 5_000, signal }
    );
    if (result.constrainedUnavailableReason === "per_user_isolation_required")
      return "subscription-isolation-unavailable";
    return result.status === "ready" ? "available" : "model-unavailable";
  };
}
