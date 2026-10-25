import { writeSync } from "node:fs";
import { isRecord } from "../../apps/api/src/computer/host-contract.js";
import { computerMonotonicMs, readComputerProcess } from "./linux.js";
import { observeComputer } from "./observe.js";
import { superviseDeployment } from "./supervisor.js";
import { manageDeployment } from "./managed-host.js";
import {
  loadPrelaunchDeployment,
  loadSupervisorDeployment,
  processIdentity,
  supervisorError
} from "./trust.js";

const STARTUP_LIMIT_MS = 5000;
const HOLD_LIMIT_MS = 1800 * 1000;
const HOLD_POLL_MS = 1000;
const SUPERVISOR_MODES = ["observe", "fence", "manage", "collect"];

/** Everything the dispatcher touches outside its own logic, so tests can replace it. */
export interface WatchdogDeps {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly exit: (code: number) => void;
  readonly setTimer: (callback: () => void, ms: number) => unknown;
  readonly clearTimer: (timer: unknown) => void;
  readonly selfPid: () => number;
  readonly parentPid: () => number;
  /** Writes one byte on descriptor 3. */
  readonly writeAck: () => Promise<void>;
}

export const defaultDeps: WatchdogDeps = {
  now: computerMonotonicMs,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  exit: (code) => process.exit(code),
  setTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: (timer) => clearTimeout(timer as NodeJS.Timeout),
  selfPid: () => process.pid,
  parentPid: () => process.ppid,
  writeAck: async () => {
    writeSync(3, Buffer.from([1]));
  }
};

/** Runs one watchdog invocation and returns the exit code. Any failure returns 2. */
export async function runWatchdog(
  argv: readonly string[],
  deps: WatchdogDeps = defaultDeps
): Promise<number> {
  const startedAtMs = deps.now();
  // Bootstrap cannot wait indefinitely for untrusted/missing configuration or a stuck mount.
  const startupDeadline = deps.setTimer(() => deps.exit(2), STARTUP_LIMIT_MS);
  const acknowledgeStartup = (): void => {
    if (deps.now() - startedAtMs >= STARTUP_LIMIT_MS) throw supervisorError();
    deps.clearTimer(startupDeadline);
  };
  try {
    return await dispatch(argv, deps, startedAtMs, acknowledgeStartup);
  } catch {
    return 2;
  } finally {
    deps.clearTimer(startupDeadline);
  }
}

async function dispatch(
  argv: readonly string[],
  deps: WatchdogDeps,
  startedAtMs: number,
  acknowledgeStartup: () => void
): Promise<number> {
  const [mode, configPath, ...rest] = argv.slice(2);
  const entry = argv[1];
  if (
    !["hold", "prelaunch", ...SUPERVISOR_MODES].includes(mode ?? "") ||
    !configPath ||
    rest.length ||
    !entry
  )
    throw supervisorError();
  if (mode === "hold" || mode === "prelaunch") {
    // Prelaunch configurations carry no runner. Supervisor configurations are refused by key set.
    await loadPrelaunchDeployment(configPath, entry, mode);
    if (mode === "prelaunch") throw supervisorError();
    return hold(deps, startedAtMs, acknowledgeStartup);
  }
  // Prelaunch configurations are refused here by key set (no runner).
  const deployment = await loadSupervisorDeployment(configPath, entry, mode === "collect");
  if (
    ((mode === "fence" || mode === "manage") && !deployment.configuration.lifetime) ||
    (mode === "observe" && deployment.configuration.lifetime) ||
    (["observe", "fence"].includes(mode!) && deployment.configuration.capture)
  )
    throw supervisorError();
  if (mode === "collect") {
    let bytes = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > 16384) throw supervisorError();
      chunks.push(buffer);
    }
    const record: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (
      !isRecord(record) ||
      Object.keys(record).sort().join(",") !== "configSha256,runId,watchdog" ||
      record.runId !== deployment.configuration.runId ||
      record.configSha256 !== deployment.configSha256 ||
      !isRecord(record.watchdog)
    )
      throw supervisorError();
    const watchdog = await readComputerProcess(
      record.watchdog as unknown as Parameters<typeof readComputerProcess>[0]
    );
    const sample = await observeComputer(deployment, {
      pid: watchdog.pid,
      startTicks: watchdog.startTicks,
      processGroupId: watchdog.processGroupId
    });
    const output = JSON.stringify({ runId: deployment.configuration.runId, sample });
    if (Buffer.byteLength(output) > 16384) throw supervisorError();
    await new Promise<void>((resolve, reject) =>
      process.stdout.write(output, (error) => (error ? reject(supervisorError()) : resolve()))
    );
    return 0;
  }
  const watchdog = await processIdentity(process.pid);
  if (
    watchdog.pid === deployment.configuration.runner.pid ||
    watchdog.processGroupId === deployment.configuration.runner.processGroupId
  )
    throw supervisorError();
  // Bootstrap stays armed through the driver's first complete durable healthy sample.
  if (mode === "manage")
    return manageDeployment(deployment, startedAtMs, watchdog, acknowledgeStartup);
  const result = superviseDeployment(deployment, startedAtMs, watchdog, acknowledgeStartup);
  // Driver ticks and all bootstrap work retain the original startup timestamp.
  const outcome = await result;
  return outcome.exitCode;
}

/** Idles until the parent changes or the run limit passes. Load happens once and is not repeated. */
async function hold(
  deps: WatchdogDeps,
  startedAtMs: number,
  acknowledgeStartup: () => void
): Promise<number> {
  const self = await processIdentity(deps.selfPid());
  const parentPid = deps.parentPid();
  const parent = await processIdentity(parentPid);
  if (self.pid === parent.pid || self.processGroupId === parent.processGroupId)
    throw supervisorError();
  acknowledgeStartup();
  await deps.writeAck();
  for (;;) {
    if (deps.parentPid() !== parentPid) return 0;
    if (deps.now() - startedAtMs >= HOLD_LIMIT_MS) return 0;
    await deps.sleep(HOLD_POLL_MS);
  }
}
