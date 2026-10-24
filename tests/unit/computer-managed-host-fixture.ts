import { PassThrough } from "node:stream";
import {
  runComputerSupervisor,
  type SupervisorTerminalHooks
} from "../../scripts/computer-watchdog/supervisor.js";
import type { ComputerLifetimeConfiguration } from "../../apps/api/src/computer/lifetime-protocol.js";

export const managedNow = () => Number(process.hrtime.bigint() / 1000000n);

/** Actual supervisor/lifetime; explicitly synthetic measurements, journal and collector port. */
export function managedSupervisorFixture(input: {
  lifetime: ComputerLifetimeConfiguration;
  socketPath: string;
  signals: NodeJS.EventEmitter;
  hooks: SupervisorTerminalHooks;
  heartbeats?: PassThrough;
  holdRoot?: boolean;
}) {
  const runner = { pid: 101, processGroupId: 101, startTicks: "123" };
  const watchdog = { pid: 202, processGroupId: 202, startTicks: "456" };
  const collector = { pid: 303, processGroupId: 303, startTicks: "789" };
  return runComputerSupervisor({
    configuration: {
      runId: input.lifetime.binding.runId,
      startedAtMs: managedNow(),
      runner,
      watchdog
    },
    lifetime: { configuration: input.lifetime, socketPath: input.socketPath },
    signals: input.signals,
    terminalHooks: input.hooks,
    heartbeats: input.heartbeats ?? new PassThrough(),
    now: managedNow,
    verifyRunner: async () => {},
    journal: {
      pending: false,
      inspect: async () => {},
      collector: async () => {},
      sample: async () => {},
      stop: () => (input.holdRoot ? new Promise<void>(() => {}) : Promise.resolve()),
      close: async () => {}
    },
    startCollector: () => ({
      pid: collector.pid,
      identity: Promise.resolve(collector),
      exited: Promise.resolve(),
      collect() {},
      kill() {},
      result: Promise.resolve({
        runId: input.lifetime.binding.runId,
        measuredAtMs: managedNow(),
        runner: { ...runner, state: "running" },
        watchdog: { ...watchdog, state: "running" },
        availableMemoryBytes: 16 * 1024 ** 3,
        rootAvailableBytes: 40 * 1024 ** 3,
        dataAvailableBytes: 40 * 1024 ** 3,
        homeBytes: 4096,
        socketBytes: 4096,
        mossHealthy: true,
        logsBounded: true,
        stopRequested: false
      })
    })
  });
}
