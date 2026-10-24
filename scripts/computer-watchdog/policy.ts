const GiB = 1024 ** 3;

export const COMPUTER_WATCHDOG_LIMITS = Object.freeze({
  runMs: 1_800_000,
  heartbeatMs: 90_000,
  sampleIntervalMs: 5_000,
  sampleExpiryMs: 10_000,
  memoryBytes: 8 * GiB,
  rootBytes: 8 * GiB,
  dataBytes: 30 * GiB,
  homeAndSocketBytes: 10 * GiB
});

export interface WatchdogProcessIdentity {
  readonly pid: number;
  readonly startTicks: string;
  readonly processGroupId: number;
}

export interface WatchdogProcessSample extends WatchdogProcessIdentity {
  readonly state: "running";
}

export interface WatchdogSample {
  readonly runId: string;
  readonly measuredAtMs: number;
  readonly runner: WatchdogProcessSample;
  readonly watchdog: WatchdogProcessSample;
  readonly availableMemoryBytes: number;
  readonly rootAvailableBytes: number;
  readonly dataAvailableBytes: number;
  readonly homeBytes: number;
  readonly socketBytes: number;
  readonly mossHealthy: boolean;
  readonly logsBounded: boolean;
  readonly stopRequested: boolean;
}

export interface WatchdogConfiguration {
  readonly runId: string;
  readonly startedAtMs: number;
  readonly runner: WatchdogProcessIdentity;
  readonly watchdog: WatchdogProcessIdentity;
}

export type WatchdogStopReason =
  | "clock-invalid"
  | "run-deadline"
  | "heartbeat-expired"
  | "sample-expired"
  | "measurement-failed"
  | "identity-changed"
  | "moss-unhealthy"
  | "logs-unbounded"
  | "resource-floor"
  | "home-limit"
  | "operator-stop";

export type WatchdogDecision =
  | Readonly<{ status: "waiting" | "healthy"; reason: null }>
  | Readonly<{ status: "stopped"; reason: WatchdogStopReason }>;

const identityKeys = ["pid", "startTicks", "processGroupId"];
const processKeys = [...identityKeys, "state"];
const sampleKeys = [
  "runId",
  "measuredAtMs",
  "runner",
  "watchdog",
  "availableMemoryBytes",
  "rootAvailableBytes",
  "dataAvailableBytes",
  "homeBytes",
  "socketBytes",
  "mossHealthy",
  "logsBounded",
  "stopRequested"
];

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

// Snapshot own data properties once. Accessors and extra/symbol keys are not measurements.
function fields(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== keys.length) return null;
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.hasOwn(descriptors, key) ? descriptors[key] : undefined;
    if (!descriptor || !Object.hasOwn(descriptor, "value")) return null;
    result[key] = descriptor.value as unknown;
  }
  return result;
}

function identity(value: unknown, keys = identityKeys): WatchdogProcessIdentity | null {
  const record = fields(value, keys);
  if (
    !record ||
    !nonnegativeInteger(record.pid) ||
    record.pid === 0 ||
    !nonnegativeInteger(record.processGroupId) ||
    record.processGroupId === 0 ||
    typeof record.startTicks !== "string" ||
    !/^[0-9]{1,20}$/.test(record.startTicks) ||
    /^0+$/.test(record.startTicks)
  ) {
    return null;
  }
  return Object.freeze({
    pid: record.pid,
    startTicks: record.startTicks,
    processGroupId: record.processGroupId
  });
}

function sameProcess(value: unknown, expected: WatchdogProcessIdentity): boolean {
  const record = fields(value, processKeys);
  return (
    record !== null &&
    record.pid === expected.pid &&
    record.startTicks === expected.startTicks &&
    record.processGroupId === expected.processGroupId &&
    record.state === "running"
  );
}

/** Pure supplied-metadata policy: no OS identity proof, scheduler, admission or cleanup. */
export class ComputerWatchdogPolicy {
  readonly #runId: string;
  readonly #startedAtMs: number;
  readonly #runner: WatchdogProcessIdentity;
  readonly #watchdog: WatchdogProcessIdentity;
  #lastNowMs: number;
  #heartbeatAtMs: number;
  #sampleAtMs: number | null = null;
  #decision: WatchdogDecision = Object.freeze({ status: "waiting", reason: null });

  constructor(configuration: WatchdogConfiguration) {
    let runner: WatchdogProcessIdentity | null;
    let watchdog: WatchdogProcessIdentity | null;
    try {
      runner = identity(configuration.runner);
      watchdog = identity(configuration.watchdog);
      if (
        typeof configuration.runId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          configuration.runId
        ) ||
        !nonnegativeInteger(configuration.startedAtMs) ||
        !runner ||
        !watchdog ||
        runner.pid === watchdog.pid ||
        runner.processGroupId === watchdog.processGroupId
      ) {
        throw new Error("Invalid Computer watchdog configuration");
      }
      this.#runId = configuration.runId;
      this.#startedAtMs = configuration.startedAtMs;
      this.#runner = runner;
      this.#watchdog = watchdog;
    } catch {
      throw new Error("Invalid Computer watchdog configuration");
    }
    this.#lastNowMs = this.#startedAtMs;
    this.#heartbeatAtMs = this.#startedAtMs;
  }

  get decision(): WatchdogDecision {
    return this.#decision;
  }

  tick(nowMs: number): WatchdogDecision {
    if (this.#decision.status === "stopped") return this.#decision;
    if (!nonnegativeInteger(nowMs) || nowMs < this.#lastNowMs) return this.#halt("clock-invalid");
    this.#lastNowMs = nowMs;
    if (nowMs - this.#startedAtMs >= COMPUTER_WATCHDOG_LIMITS.runMs)
      return this.#halt("run-deadline");
    if (nowMs - this.#heartbeatAtMs >= COMPUTER_WATCHDOG_LIMITS.heartbeatMs) {
      return this.#halt("heartbeat-expired");
    }
    if (
      nowMs - (this.#sampleAtMs ?? this.#startedAtMs) >=
      COMPUTER_WATCHDOG_LIMITS.sampleExpiryMs
    ) {
      return this.#halt("sample-expired");
    }
    return this.#decision;
  }

  heartbeat(nowMs: number): WatchdogDecision {
    if (this.tick(nowMs).status === "stopped") return this.#decision;
    this.#heartbeatAtMs = nowMs;
    return this.#decision;
  }

  stop(nowMs: number): WatchdogDecision {
    if (this.tick(nowMs).status === "stopped") return this.#decision;
    return this.#halt("operator-stop");
  }

  sample(nowMs: number, value: unknown): WatchdogDecision {
    if (this.tick(nowMs).status === "stopped") return this.#decision;
    try {
      const record = fields(value, sampleKeys);
      if (
        !record ||
        !nonnegativeInteger(record.measuredAtMs) ||
        record.measuredAtMs < this.#startedAtMs ||
        record.measuredAtMs > nowMs ||
        (this.#sampleAtMs !== null && record.measuredAtMs <= this.#sampleAtMs) ||
        nowMs - record.measuredAtMs >= COMPUTER_WATCHDOG_LIMITS.sampleIntervalMs ||
        !nonnegativeInteger(record.availableMemoryBytes) ||
        !nonnegativeInteger(record.rootAvailableBytes) ||
        !nonnegativeInteger(record.dataAvailableBytes) ||
        !nonnegativeInteger(record.homeBytes) ||
        !nonnegativeInteger(record.socketBytes) ||
        typeof record.mossHealthy !== "boolean" ||
        typeof record.logsBounded !== "boolean" ||
        typeof record.stopRequested !== "boolean"
      ) {
        return this.#halt("measurement-failed");
      }
      if (
        record.runId !== this.#runId ||
        !sameProcess(record.runner, this.#runner) ||
        !sameProcess(record.watchdog, this.#watchdog)
      ) {
        return this.#halt("identity-changed");
      }
      if (record.stopRequested) return this.#halt("operator-stop");
      if (!record.mossHealthy) return this.#halt("moss-unhealthy");
      if (!record.logsBounded) return this.#halt("logs-unbounded");
      if (
        record.availableMemoryBytes < COMPUTER_WATCHDOG_LIMITS.memoryBytes ||
        record.rootAvailableBytes < COMPUTER_WATCHDOG_LIMITS.rootBytes ||
        record.dataAvailableBytes < COMPUTER_WATCHDOG_LIMITS.dataBytes
      ) {
        return this.#halt("resource-floor");
      }
      if (record.homeBytes >= COMPUTER_WATCHDOG_LIMITS.homeAndSocketBytes - record.socketBytes) {
        return this.#halt("home-limit");
      }
      this.#sampleAtMs = record.measuredAtMs;
      this.#decision = Object.freeze({ status: "healthy", reason: null });
      return this.#decision;
    } catch {
      return this.#halt("measurement-failed");
    }
  }

  #halt(reason: WatchdogStopReason): WatchdogDecision {
    if (this.#decision.status !== "stopped") {
      this.#decision = Object.freeze({ status: "stopped", reason });
    }
    return this.#decision;
  }
}
