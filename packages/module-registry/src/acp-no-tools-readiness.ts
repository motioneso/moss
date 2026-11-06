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
  Partial<Pick<RpcConnection, "ensureConnected">>;

const CONNECT_WAIT_MS = 5_000;

/** Connects an idle runner connection, waiting at most CONNECT_WAIT_MS. Never throws. */
async function connectBriefly(connection: ProbeConnection, signal?: AbortSignal): Promise<void> {
  if (!connection.ensureConnected) return;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      connection.ensureConnected(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, CONNECT_WAIT_MS);
        signal?.addEventListener("abort", () => resolve(), { once: true });
      })
    ]);
  } catch {
    // The readiness check below reports the connection as offline.
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reachability with a typed reason. "model-unavailable" means no usable model for the
 * profile and "runner-offline" means the runner connection could not be made ready. The
 * worker opens its connection on first use, so an idle one is connected here before it is
 * judged. Sign-in state is not checked, because the check can reject a working session.
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
    await connectBriefly(connection, _signal);
    try {
      connection.assertReady();
    } catch {
      return "runner-offline";
    }
    return "available";
  };
}
