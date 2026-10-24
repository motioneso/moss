import { ComputerDocker } from "../computer-host/docker.js";
import { HostStateStore } from "../computer-host/state.js";
import { ComputerTerminalHost } from "../computer-host/terminal.js";
import { serveComputerHost } from "../computer-host/service.js";
import { assertFencedComputerState } from "./observe.js";
import { computerMonotonicMs } from "./linux.js";
import {
  superviseDeployment,
  type SupervisorOutcome,
  type SupervisorTerminalHooks
} from "./supervisor.js";
import { supervisorError, type SupervisorDeployment } from "./trust.js";
import type { WatchdogProcessIdentity } from "./policy.js";

/** Native composition driver. Test ports disclose collection/trust fixtures, never launch admission. */
export async function runManagedComputerHost(input: {
  store: HostStateStore;
  supervise(hooks: SupervisorTerminalHooks): Promise<SupervisorOutcome>;
  now(): number;
  signals: NodeJS.EventEmitter;
  fatal(): never;
}): Promise<number> {
  const abort = new AbortController();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const terminal = new ComputerTerminalHost(input.store, new ComputerDocker(input.store.config), {
    now: input.now,
    stopRoot: () => abort.abort(),
    terminal: (expiresAt) => {
      deadline = setTimeout(input.fatal, Math.max(0, expiresAt - input.now()));
    }
  });
  // Keep real signal handlers after the root driver's5s finalization through later cleanup/drain.
  const stop = () => terminal.stop();
  input.signals.on("SIGTERM", stop).on("SIGINT", stop);
  const root = input.supervise({ signal: abort.signal, terminal: () => terminal.latch() });
  void root
    .then(
      (outcome) => {
        // Never extend incomplete root finalization while lifecycle fsync or service drain is held.
        if (outcome.exitCode === 2) input.fatal();
        return terminal.finish(outcome);
      },
      () => input.fatal()
    )
    .catch(() => input.fatal());
  const service = await serveComputerHost(input.store, terminal);
  try {
    await terminal.completed;
    await service.close({ drain: true });
    await input.store.close();
    return (await root).exitCode;
  } finally {
    clearTimeout(deadline);
    input.signals.off("SIGTERM", stop).off("SIGINT", stop);
    // Failures retain the lock and evidence; the executable exits, it does not resume service.
  }
}

export async function manageDeployment(
  deployment: SupervisorDeployment,
  startedAtMs: number,
  watchdog: WatchdogProcessIdentity,
  started: () => void
): Promise<number> {
  if (!deployment.configuration.lifetime) throw supervisorError();
  const store = await HostStateStore.openExisting(deployment.configuration.host);
  await assertFencedComputerState(deployment, store.state);
  return runManagedComputerHost({
    store,
    now: computerMonotonicMs,
    signals: process,
    fatal: () => process.exit(2),
    supervise: (hooks) => superviseDeployment(deployment, startedAtMs, watchdog, started, hooks)
  });
}
