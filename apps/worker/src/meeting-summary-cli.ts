import { createConstrainedCliStructuredAdapterFactory, selectEngineFactory } from "@moss/chat";
import type { BuiltInWorkerDependencies } from "@moss/module-registry";

/** One worker-owned connection; no in-process or alternative-model fallback. */
export function createWorkerMeetingSummaryCli(env: NodeJS.ProcessEnv = process.env): {
  readonly dependencies: Pick<
    BuiltInWorkerDependencies,
    "createConstrainedCliStructuredAdapter" | "probeConstrainedCli"
  >;
  close(): void;
} {
  // Only select the RPC branch. An unconfigured host keeps API-key summaries available.
  const runtime = env.JARVIS_CLI_RUNNER_SOCKET?.trim() ? selectEngineFactory({ env }) : undefined;
  return {
    dependencies: {
      createConstrainedCliStructuredAdapter: runtime
        ? createConstrainedCliStructuredAdapterFactory(runtime.factory)
        : undefined,
      probeConstrainedCli: async (actorUserId, signal) => {
        if (!runtime?.connection) return "model-unavailable";
        const result = await runtime.connection.probeProvider(
          { provider: "anthropic", constrainedStructured: true },
          actorUserId,
          { timeoutMs: 5_000, signal }
        );
        if (result.constrainedUnavailableReason === "per_user_isolation_required")
          return "subscription-isolation-unavailable";
        return result.status === "ready" ? "available" : "model-unavailable";
      }
    },
    close: () => runtime?.connection?.close()
  };
}
