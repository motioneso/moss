import { createConstrainedCliStructuredAdapterFactory, selectEngineFactory } from "@moss/chat";
import {
  createConstrainedCliReadinessProbe,
  type BuiltInWorkerDependencies
} from "@moss/module-registry";

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
      probeConstrainedCli: createConstrainedCliReadinessProbe(() => runtime?.connection)
    },
    close: () => runtime?.connection?.close()
  };
}
