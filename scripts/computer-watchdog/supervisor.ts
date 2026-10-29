import { captureManagedProcesses } from "../computer-capture/run.js";
import type { HostStateStore } from "../computer-host/state.js";
import { join } from "node:path";
import { ComputerRootLifetime } from "./lifetime.js";
import type { ComputerLifetimeConfiguration } from "../../apps/api/src/computer/lifetime-protocol.js";
import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import {
  ComputerWatchdogPolicy,
  type WatchdogConfiguration,
  type WatchdogProcessIdentity,
  type WatchdogSample,
  type WatchdogStopReason
} from "./policy.js";
import { computerMonotonicMs, readComputerProcess } from "./linux.js";
import { ObservationJournal } from "./journal.js";
import { isRecord } from "../../apps/api/src/computer/host-contract.js";
import { processIdentity, supervisorError, type SupervisorDeployment } from "./trust.js";

export interface CollectorJob {
  readonly pid: number;
  readonly identity: Promise<WatchdogProcessIdentity>;
  readonly result: Promise<unknown>;
  readonly exited: Promise<void>;
  collect(identity: WatchdogProcessIdentity): void;
  kill(): void;
}
export interface SupervisorJournal {
  readonly pending: boolean;
  inspect(): Promise<void>;
  collector(identity: WatchdogProcessIdentity): Promise<void>;
  sample(sample: WatchdogSample): Promise<void>;
  stop(
    atMs: number,
    reason: WatchdogStopReason,
    collector: WatchdogProcessIdentity | null,
    collectorPid: number | null
  ): Promise<void>;
  close(): Promise<void>;
}
export interface SupervisorOutcome {
  readonly reason: WatchdogStopReason;
  readonly exitCode: number;
  readonly receiverFenced: boolean;
  readonly durableStop: boolean;
  readonly collectorExited: boolean;
  readonly collectorPid: number | null;
  readonly collectorIdentity: WatchdogProcessIdentity | null;
}

export interface SupervisorTerminalHooks {
  readonly signal: AbortSignal;
  /** Synchronous local latch only; cannot postpone fencing or observer finalization. */
  terminal(): void;
}

/** Fixed native child. No shell, executable override, inherited environment or extra descriptors. */
export function spawnComputerCollector(
  deployment: SupervisorDeployment,
  watchdog: WatchdogProcessIdentity
): CollectorJob {
  const child = spawn(
    deployment.nodePath,
    [deployment.artifactPath, "collect", deployment.configPath],
    {
      detached: true,
      env: {},
      stdio: ["pipe", "pipe", "ignore"]
    }
  );
  let resolveExit!: () => void;
  let rejectResult!: (error: Error) => void;
  let resolveResult!: (result: unknown) => void;
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  const result = new Promise<unknown>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  let bytes = 0;
  const chunks: Buffer[] = [];
  const fail = () => {
    rejectResult(supervisorError());
    child.kill("SIGKILL");
  };
  child.once("error", fail);
  child.stdin.on("error", fail);
  child.stdout.on("error", fail);
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 16384) {
      fail();
      return;
    }
    chunks.push(chunk);
  });
  child.once("exit", resolveExit);
  child.once("close", (code) => {
    resolveExit();
    try {
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (
        code !== 0 ||
        !isRecord(value) ||
        Object.keys(value).sort().join(",") !== "runId,sample" ||
        value.runId !== deployment.configuration.runId
      )
        throw supervisorError();
      resolveResult(value.sample);
    } catch {
      rejectResult(supervisorError());
    }
  });
  // The child waits for the parent's durable identity record before collecting or replying.
  const identity = child.pid
    ? processIdentity(child.pid)
    : Promise.reject<WatchdogProcessIdentity>(supervisorError());
  return {
    pid: child.pid ?? 0,
    identity,
    result,
    exited,
    collect(identity) {
      if (identity.pid !== child.pid || identity.processGroupId !== child.pid) {
        fail();
        return;
      }
      const message = JSON.stringify({
        runId: deployment.configuration.runId,
        configSha256: deployment.configSha256,
        watchdog
      });
      if (Buffer.byteLength(message) > 16384) {
        fail();
        return;
      }
      child.stdin.end(message);
    },
    kill() {
      child.stdin.destroy();
      child.stdout.destroy();
      child.kill("SIGKILL");
    }
  };
}

/** Ports allow deterministic driver tests; executable composition supplies only fixed native machinery. */
export function runComputerSupervisor(input: {
  configuration: WatchdogConfiguration;
  heartbeats: Readable;
  journal: SupervisorJournal;
  startCollector(): CollectorJob;
  verifyRunner(): Promise<unknown>;
  now(): number;
  signals: NodeJS.EventEmitter;
  /** Output notification after the first complete durable healthy sample. Never health authority. */
  started?: () => void;
  lifetime?: { configuration: ComputerLifetimeConfiguration; socketPath: string };
  terminalHooks?: SupervisorTerminalHooks;
}): Promise<SupervisorOutcome> {
  const { configuration, journal, heartbeats } = input;
  const policy = new ComputerWatchdogPolicy(configuration);
  return new Promise((resolve) => {
    let lifetime: ComputerRootLifetime | undefined;
    let lifetimeStarted = false;
    let startupPending = input.started !== undefined;
    let current: CollectorJob | null = null;
    let identity: WatchdogProcessIdentity | null = null;
    let collectorExited = true;
    let active = false;
    let terminal = false;
    let persistenceFailed = false;
    let nextCollection = configuration.startedAtMs;
    let collectionAt = configuration.startedAtMs;
    let heartbeatBuffer = Buffer.alloc(0);
    let counter = 0;
    let checkingHeartbeat = false;

    const stop = () => {
      if (terminal) return;
      terminal = true;
      clearInterval(timer);
      heartbeats.off("data", heartbeat).off("end", operatorStop).off("error", operatorStop);
      heartbeats.pause();
      const decision =
        policy.decision.status === "stopped" ? policy.decision : policy.stop(input.now());
      if (decision.status !== "stopped") throw supervisorError();
      const reason = decision.reason;
      const finalizationExpires = input.now() + 5000;
      let durableStop = false;
      let receiverFenced = false;
      let lifetimeSettled = !lifetime;
      let descriptorsClosed = false;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        input.signals.off("SIGTERM", operatorStop).off("SIGINT", operatorStop);
        resolve(
          Object.freeze({
            reason,
            exitCode:
              input.now() < finalizationExpires &&
              durableStop &&
              collectorExited &&
              descriptorsClosed &&
              (!lifetime || receiverFenced) &&
              !persistenceFailed
                ? reason === "operator-stop"
                  ? 0
                  : 1
                : 2,
            receiverFenced,
            durableStop,
            collectorExited,
            collectorPid: current?.pid ?? null,
            collectorIdentity: identity
          })
        );
      };
      // This timer stays referenced. The CLI exits even when kernel I/O never settles.
      const deadline = setTimeout(finish, 5000);
      try {
        input.terminalHooks?.terminal();
      } catch {
        persistenceFailed = true;
      }
      // Initiate delivery independently of collector termination and journal I/O.
      void lifetime?.stop().then((fenced) => {
        receiverFenced = fenced;
        lifetimeSettled = true;
        if (durableStop && collectorExited && descriptorsClosed) finish();
      });
      current?.kill();
      const exit = current?.exited ?? Promise.resolve();
      void exit
        .then(
          () => {
            collectorExited = true;
          },
          () => {}
        )
        .then(() => {
          if (durableStop && descriptorsClosed && lifetimeSettled) finish();
        });
      void journal
        .stop(input.now(), reason, identity, current?.pid ?? null)
        .then(
          () => {
            durableStop = true;
          },
          () => {
            persistenceFailed = true;
          }
        )
        .then(() => journal.close())
        .then(
          () => {
            descriptorsClosed = true;
            if (collectorExited && lifetimeSettled) finish();
          },
          () => {
            persistenceFailed = true;
            if (collectorExited && lifetimeSettled) finish();
          }
        );
    };
    const failed = () => {
      if (terminal) return;
      policy.sample(input.now(), null);
      stop();
    };
    const operatorStop = () => {
      if (terminal) return;
      policy.stop(input.now());
      stop();
    };
    const healthyContinuation = (measuredAtMs: number) => {
      if (terminal) return false;
      if (input.terminalHooks?.signal.aborted) {
        operatorStop();
        return false;
      }
      const now = input.now();
      if (
        policy.tick(now).status !== "healthy" ||
        now - measuredAtMs >= 5000 ||
        (startupPending && now - configuration.startedAtMs >= 5000)
      ) {
        failed();
        return false;
      }
      return true;
    };
    const heartbeat = (chunk: Buffer) => {
      if (terminal) return;
      if (!Buffer.isBuffer(chunk) || chunk.length > 4096 || checkingHeartbeat) {
        operatorStop();
        return;
      }
      heartbeatBuffer = Buffer.concat([heartbeatBuffer, chunk]);
      let frames = 0;
      for (;;) {
        const end = heartbeatBuffer.indexOf(10);
        if (end < 0) {
          if (heartbeatBuffer.length > 512) operatorStop();
          return;
        }
        if (end > 512 || ++frames > 1) {
          operatorStop();
          return;
        }
        let record: unknown;
        try {
          record = JSON.parse(heartbeatBuffer.subarray(0, end).toString("utf8"));
        } catch {
          operatorStop();
          return;
        }
        heartbeatBuffer = heartbeatBuffer.subarray(end + 1);
        if (
          !isRecord(record) ||
          Object.keys(record).sort().join(",") !== "counter,runId" ||
          record.runId !== configuration.runId ||
          record.counter !== counter + 1
        ) {
          operatorStop();
          return;
        }
        if (policy.tick(input.now()).status === "stopped") {
          stop();
          return;
        }
        counter++;
        checkingHeartbeat = true;
        void input.verifyRunner().then(() => {
          checkingHeartbeat = false;
          if (!terminal && policy.heartbeat(input.now()).status === "stopped") stop();
        }, failed);
      }
    };
    const collect = () => {
      active = true;
      collectionAt = input.now();
      nextCollection = collectionAt + 5000;
      identity = null;
      collectorExited = false;
      try {
        current = input.startCollector();
      } catch {
        collectorExited = true;
        failed();
        return;
      }
      const job = current;
      // Attach both handlers before any async identity/persistence work can fail.
      const sample = job.result;
      void sample.catch(failed);
      void job.exited.then(() => {
        if (current === job) collectorExited = true;
      }, failed);
      void job.identity
        .then(async (observed) => {
          if (terminal) return;
          identity = Object.freeze({ ...observed });
          await journal.collector(identity);
          if (!terminal) job.collect(identity);
        })
        .catch(failed);
      void sample
        .then(async (value) => {
          if (terminal || current !== job) return;
          if (!identity) {
            failed();
            return;
          }
          if (policy.sample(input.now(), value).status === "stopped") {
            stop();
            return;
          }
          // The policy validated/snapshotted the closed JSON result. Persist before another sample.
          const measuredAtMs = (value as WatchdogSample).measuredAtMs;
          if (!healthyContinuation(measuredAtMs)) return;
          await journal.sample(value as WatchdogSample);
          if (!healthyContinuation(measuredAtMs)) return;
          await journal.inspect();
          if (!healthyContinuation(measuredAtMs)) return;
          if (!terminal && lifetime && !lifetimeStarted) {
            lifetimeStarted = true;
            lifetime.start();
          }
          if (!healthyContinuation(measuredAtMs)) return;
          if (startupPending) {
            // Latch before invoking: a throwing notification cannot be retried by a later sample.
            startupPending = false;
            input.started!();
          }
          if (!terminal) {
            active = false;
            current = null;
            identity = null;
            collectorExited = true;
          }
        })
        .catch(failed);
    };
    const tick = () => {
      if (terminal) return;
      if (policy.tick(input.now()).status === "stopped") {
        stop();
        return;
      }
      if (active && input.now() - collectionAt >= 5000) {
        failed();
        return;
      }
      if (input.now() >= nextCollection) {
        if (active || journal.pending) {
          failed();
          return;
        }
        active = true;
        collectionAt = input.now();
        void journal.inspect().then(() => {
          if (!terminal) collect();
        }, failed);
      }
    };
    if (input.lifetime)
      lifetime = new ComputerRootLifetime({
        ...input.lifetime,
        now: input.now,
        failed,
        healthy: () => !terminal && policy.tick(input.now()).status === "healthy"
      });
    heartbeats.on("data", heartbeat).once("end", operatorStop).once("error", operatorStop);
    input.signals.on("SIGTERM", operatorStop).on("SIGINT", operatorStop);
    input.terminalHooks?.signal.addEventListener("abort", operatorStop, { once: true });
    const timer = setInterval(tick, 1000);
    if (input.terminalHooks?.signal.aborted) operatorStop();
    else tick();
  });
}

export async function superviseDeployment(
  deployment: SupervisorDeployment,
  startedAtMs: number,
  watchdog: WatchdogProcessIdentity,
  started: () => void,
  terminalHooks?: SupervisorTerminalHooks,
  store?: HostStateStore
): Promise<SupervisorOutcome> {
  const configuration = {
    runId: deployment.configuration.runId,
    startedAtMs,
    runner: deployment.configuration.runner,
    watchdog
  };
  let interrupted = false;
  const stop = () => {
    interrupted = true;
  };
  process.on("SIGTERM", stop).on("SIGINT", stop);
  try {
    const journal = await ObservationJournal.create(
      deployment.configuration.monitor,
      configuration
    );
    if (deployment.configuration.capture) {
      await captureManagedProcesses(
        deployment,
        store,
        watchdog,
        startedAtMs,
        journal,
        () => interrupted || terminalHooks?.signal.aborted === true
      );
    }
    const assertStartup = () => {
      if (
        interrupted ||
        terminalHooks?.signal.aborted ||
        computerMonotonicMs() - startedAtMs >= 5000
      )
        throw supervisorError();
    };
    // Journal/capture work precedes an awaited continuation. Preserve the original bootstrap bound.
    assertStartup();
    const result = runComputerSupervisor({
      configuration,
      ...(deployment.configuration.lifetime
        ? {
            lifetime: {
              configuration: deployment.configuration.lifetime,
              socketPath: join(deployment.configuration.host.gatewayDir, "lifetime.sock")
            }
          }
        : {}),
      heartbeats: process.stdin,
      journal,
      startCollector: () => spawnComputerCollector(deployment, watchdog),
      verifyRunner: () => readComputerProcess(configuration.runner),
      now: computerMonotonicMs,
      signals: process,
      started,
      terminalHooks
    });
    return result;
  } finally {
    // Driver installed its handlers synchronously above: no asynchronous signal-handoff gap.
    process.off("SIGTERM", stop).off("SIGINT", stop);
  }
}
