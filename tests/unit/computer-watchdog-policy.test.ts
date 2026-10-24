import { describe, expect, it } from "vitest";
import {
  COMPUTER_WATCHDOG_LIMITS as limits,
  ComputerWatchdogPolicy,
  type WatchdogConfiguration,
  type WatchdogSample,
  type WatchdogStopReason
} from "../../scripts/computer-watchdog/policy.js";

const runId = "543f550b-45fe-42e1-ae63-8541af410a34";
const startedAtMs = 1_000;
const GiB = 1024 ** 3;

function configuration(): WatchdogConfiguration {
  return {
    runId,
    startedAtMs,
    runner: { pid: 10, startTicks: "1234", processGroupId: 10 },
    watchdog: { pid: 20, startTicks: "1235", processGroupId: 20 }
  };
}

function sample(measuredAtMs = startedAtMs): WatchdogSample {
  const config = configuration();
  return {
    runId,
    measuredAtMs,
    runner: { ...config.runner, state: "running" },
    watchdog: { ...config.watchdog, state: "running" },
    availableMemoryBytes: 8 * GiB,
    rootAvailableBytes: 8 * GiB,
    dataAvailableBytes: 30 * GiB,
    homeBytes: 10 * GiB - 2,
    socketBytes: 1,
    mossHealthy: true,
    logsBounded: true,
    stopRequested: false
  };
}

function stopped(reason: WatchdogStopReason) {
  return { status: "stopped", reason };
}

function keepFresh(policy: ComputerWatchdogPolicy, untilElapsedMs: number, heartbeat = true) {
  for (let elapsed = 0; elapsed <= untilElapsedMs; elapsed += 5_000) {
    const now = startedAtMs + elapsed;
    if (heartbeat) expect(policy.heartbeat(now).status).not.toBe("stopped");
    expect(policy.sample(now, sample(now))).toEqual({ status: "healthy", reason: null });
  }
}

describe("Computer watchdog decision policy (supplied metadata only)", () => {
  it("waits for the first complete sample, accepts exact floors and uses fixed frozen limits", () => {
    const policy = new ComputerWatchdogPolicy(configuration());
    expect(policy.decision).toEqual({ status: "waiting", reason: null });
    expect(policy.heartbeat(startedAtMs)).toEqual(policy.decision);
    expect(policy.tick(startedAtMs + 4_999)).toEqual(policy.decision);
    expect(policy.sample(startedAtMs + 4_999, sample())).toEqual({
      status: "healthy",
      reason: null
    });
    expect(limits).toEqual({
      runMs: 1_800_000,
      heartbeatMs: 90_000,
      sampleIntervalMs: 5_000,
      sampleExpiryMs: 10_000,
      memoryBytes: 8 * GiB,
      rootBytes: 8 * GiB,
      dataBytes: 30 * GiB,
      homeAndSocketBytes: 10 * GiB
    });
    expect(Object.isFrozen(limits)).toBe(true);
  });

  it.each([
    { runId: "bad" },
    { startedAtMs: -1 },
    { startedAtMs: NaN },
    { startedAtMs: Infinity },
    { startedAtMs: 1.5 },
    { startedAtMs: Number.MAX_SAFE_INTEGER + 1 },
    { runner: { ...configuration().runner, pid: 0 } },
    { runner: { ...configuration().runner, processGroupId: -1 } },
    { runner: { ...configuration().runner, startTicks: "0" } },
    { runner: { ...configuration().runner, startTicks: "1e10" } },
    { runner: { ...configuration().runner, startTicks: "1".repeat(21) } },
    { watchdog: { ...configuration().watchdog, pid: 10 } },
    { watchdog: { ...configuration().watchdog, processGroupId: 10 } }
  ])("rejects invalid configuration %j with a fixed error", (patch) => {
    expect(() => new ComputerWatchdogPolicy({ ...configuration(), ...patch })).toThrow(
      "Invalid Computer watchdog configuration"
    );
  });

  it.each(["availableMemoryBytes", "rootAvailableBytes", "dataAvailableBytes"] as const)(
    "stops below the %s floor",
    (field) => {
      const value = sample();
      const policy = new ComputerWatchdogPolicy(configuration());
      expect(policy.sample(startedAtMs, { ...value, [field]: value[field] - 1 })).toEqual(
        stopped("resource-floor")
      );
    }
  );

  it.each([
    { homeBytes: 10 * GiB - 1, socketBytes: 1 },
    { homeBytes: 0, socketBytes: 10 * GiB },
    { homeBytes: Number.MAX_SAFE_INTEGER, socketBytes: Number.MAX_SAFE_INTEGER }
  ])("stops at or above combined home/socket limit %j", (patch) => {
    const policy = new ComputerWatchdogPolicy(configuration());
    expect(policy.sample(startedAtMs, { ...sample(), ...patch })).toEqual(stopped("home-limit"));
  });

  it.each([
    { patch: { mossHealthy: false }, reason: "moss-unhealthy" },
    { patch: { logsBounded: false }, reason: "logs-unbounded" },
    { patch: { stopRequested: true }, reason: "operator-stop" }
  ] as const)("stops on $reason", ({ patch, reason }) => {
    const policy = new ComputerWatchdogPolicy(configuration());
    expect(policy.sample(startedAtMs, { ...sample(), ...patch })).toEqual(stopped(reason));
  });

  it.each([
    { runId: "543f550b-45fe-42e1-ae63-8541af410a35" },
    { runId: undefined },
    ...(["runner", "watchdog"] as const).flatMap((field) =>
      [
        { pid: 999 },
        { startTicks: "999" },
        { processGroupId: 999 },
        { state: "zombie" },
        { state: "dead" },
        { state: undefined },
        { extra: true }
      ].map((patch) => ({ [field]: { ...sample()[field], ...patch } }))
    ),
    { runner: null },
    { watchdog: {} }
  ])("stops on a changed, missing or nonrunning process/run identity %j", (patch) => {
    const policy = new ComputerWatchdogPolicy(configuration());
    expect(policy.sample(startedAtMs, { ...sample(), ...patch })).toEqual(
      stopped("identity-changed")
    );
  });

  it.each([
    null,
    [],
    undefined,
    "failed",
    {},
    { ...sample(), extra: true },
    { ...sample(), [Symbol("extra")]: true },
    ...(["mossHealthy", "logsBounded", "stopRequested"] as const).map((field) => ({
      ...sample(),
      [field]: "true"
    })),
    ...(
      [
        "availableMemoryBytes",
        "rootAvailableBytes",
        "dataAvailableBytes",
        "homeBytes",
        "socketBytes",
        "measuredAtMs"
      ] as const
    ).flatMap((field) =>
      [undefined, null, NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, "8589934592"].map(
        (value) => ({ ...sample(), [field]: value })
      )
    )
  ])("fails closed on invalid or incomplete measurements %#", (value) => {
    const policy = new ComputerWatchdogPolicy(configuration());
    expect(policy.sample(startedAtMs, value)).toEqual(stopped("measurement-failed"));
  });

  it("rejects accessors without invoking them and catches failed object inspection", () => {
    const value = Object.defineProperty(sample(), "availableMemoryBytes", {
      get() {
        throw new Error("must not be read");
      }
    });
    const policy = new ComputerWatchdogPolicy(configuration());
    expect(policy.sample(startedAtMs, value)).toEqual(stopped("measurement-failed"));
    const proxy = new Proxy(sample(), {
      ownKeys() {
        throw new Error("collection failed");
      }
    });
    expect(new ComputerWatchdogPolicy(configuration()).sample(startedAtMs, proxy)).toEqual(
      stopped("measurement-failed")
    );
  });

  it("rejects changing constructor accessors without invoking them", () => {
    let reads = 0;
    const config = Object.defineProperty(configuration(), "startedAtMs", {
      get() {
        return reads++ === 0 ? startedAtMs : NaN;
      }
    });
    expect(() => new ComputerWatchdogPolicy(config)).toThrow(
      "Invalid Computer watchdog configuration"
    );
    expect(reads).toBe(0);
  });

  it.each(["sample", "runner", "watchdog"] as const)(
    "preserves a terminal stop reentered during %s inspection",
    (location) => {
      const policy = new ComputerWatchdogPolicy(configuration());
      const value = sample();
      const handler = {
        ownKeys(target: object) {
          policy.stop(startedAtMs);
          return Reflect.ownKeys(target);
        }
      };
      const reentrant =
        location === "sample"
          ? new Proxy(value, handler)
          : { ...value, [location]: new Proxy(value[location], handler) };
      expect(policy.sample(startedAtMs, reentrant)).toEqual(stopped("operator-stop"));
      expect(policy.decision).toEqual(stopped("operator-stop"));
    }
  );

  it("preserves newer clock and measurement state established by reentrant inspection", () => {
    for (const advanceClock of [false, true]) {
      const policy = new ComputerWatchdogPolicy(configuration());
      const value = new Proxy(sample(), {
        ownKeys(target) {
          policy.sample(startedAtMs + (advanceClock ? 1 : 0), sample());
          return Reflect.ownKeys(target);
        }
      });
      expect(policy.sample(startedAtMs, value)).toEqual(
        stopped(advanceClock ? "clock-invalid" : "measurement-failed")
      );
    }
  });

  it.each([
    { received: startedAtMs, measured: startedAtMs - 1 },
    { received: startedAtMs, measured: startedAtMs + 1 },
    { received: startedAtMs + 5_000, measured: startedAtMs }
  ])("rejects stale/future/pre-start measurement time %j", ({ received, measured }) => {
    expect(new ComputerWatchdogPolicy(configuration()).sample(received, sample(measured))).toEqual(
      stopped("measurement-failed")
    );
  });

  it("rejects duplicate and regressing measurement times", () => {
    for (const measured of [startedAtMs, startedAtMs - 1]) {
      const policy = new ComputerWatchdogPolicy(configuration());
      policy.sample(startedAtMs, sample());
      expect(policy.sample(startedAtMs + 1, sample(measured))).toEqual(
        stopped("measurement-failed")
      );
    }
  });

  it.each([NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, startedAtMs - 1])(
    "rejects invalid/backward clock %s before new activity",
    (now) => {
      const policy = new ComputerWatchdogPolicy(configuration());
      expect(policy.sample(now, sample())).toEqual(stopped("clock-invalid"));
    }
  );

  it("allows equal method times but rejects time moving backward after a valid tick", () => {
    const policy = new ComputerWatchdogPolicy(configuration());
    policy.tick(startedAtMs + 1);
    expect(policy.heartbeat(startedAtMs + 1).status).toBe("waiting");
    expect(policy.stop(startedAtMs)).toEqual(stopped("clock-invalid"));
  });

  it("expires the first sample and incomplete collection at the exact gap boundary", () => {
    const waiting = new ComputerWatchdogPolicy(configuration());
    expect(waiting.tick(startedAtMs + 9_999).status).toBe("waiting");
    expect(waiting.tick(startedAtMs + 10_000)).toEqual(stopped("sample-expired"));
    const policy = new ComputerWatchdogPolicy(configuration());
    policy.sample(startedAtMs, sample());
    expect(policy.tick(startedAtMs + 9_999).status).toBe("healthy");
    expect(policy.tick(startedAtMs + 10_000)).toEqual(stopped("sample-expired"));
  });

  it("uses measurement time rather than receipt time for subsequent sample expiry", () => {
    const policy = new ComputerWatchdogPolicy(configuration());
    policy.sample(startedAtMs + 4_999, sample());
    expect(policy.tick(startedAtMs + 10_000)).toEqual(stopped("sample-expired"));
  });

  it("checks expiration before accepting late samples or heartbeats", () => {
    const policy = new ComputerWatchdogPolicy(configuration());
    policy.sample(startedAtMs, sample());
    expect(policy.sample(startedAtMs + 10_000, sample(startedAtMs + 10_000))).toEqual(
      stopped("sample-expired")
    );
    const heartbeat = new ComputerWatchdogPolicy(configuration());
    keepFresh(heartbeat, 85_000, false);
    expect(heartbeat.heartbeat(startedAtMs + 90_000)).toEqual(stopped("heartbeat-expired"));
  });

  it("samples do not refresh the independent heartbeat", () => {
    const policy = new ComputerWatchdogPolicy(configuration());
    keepFresh(policy, 85_000, false);
    expect(policy.tick(startedAtMs + 89_999).status).toBe("healthy");
    expect(policy.sample(startedAtMs + 90_000, sample(startedAtMs + 90_000))).toEqual(
      stopped("heartbeat-expired")
    );
  });

  it("an explicit heartbeat extends only its own deadline", () => {
    const policy = new ComputerWatchdogPolicy(configuration());
    keepFresh(policy, 85_000, false);
    policy.heartbeat(startedAtMs + 85_000);
    for (let elapsed = 90_000; elapsed <= 170_000; elapsed += 5_000) {
      const now = startedAtMs + elapsed;
      expect(policy.sample(now, sample(now)).status).toBe("healthy");
    }
    expect(policy.tick(startedAtMs + 175_000)).toEqual(stopped("heartbeat-expired"));
  });

  it("retains the 1800-second deadline despite fresh heartbeat and samples", () => {
    const policy = new ComputerWatchdogPolicy(configuration());
    keepFresh(policy, 1_795_000);
    expect(policy.tick(startedAtMs + 1_799_999).status).toBe("healthy");
    expect(policy.sample(startedAtMs + 1_800_000, sample(startedAtMs + 1_800_000))).toEqual(
      stopped("run-deadline")
    );
  });

  it("retains the first terminal reason across all later activity", () => {
    const policy = new ComputerWatchdogPolicy(configuration());
    const decision = policy.sample(startedAtMs, { ...sample(), mossHealthy: false });
    expect(decision).toEqual(stopped("moss-unhealthy"));
    expect(policy.sample(startedAtMs + 1, sample(startedAtMs + 1))).toBe(decision);
    expect(policy.heartbeat(startedAtMs + 1)).toBe(decision);
    expect(policy.stop(startedAtMs + 1)).toBe(decision);
    expect(policy.tick(NaN)).toBe(decision);
  });

  it("supports explicit stop and never revives a waiting or healthy stopped policy", () => {
    for (const healthy of [false, true]) {
      const policy = new ComputerWatchdogPolicy(configuration());
      if (healthy) policy.sample(startedAtMs, sample());
      expect(policy.stop(startedAtMs)).toEqual(stopped("operator-stop"));
      expect(policy.sample(startedAtMs + 1, sample(startedAtMs + 1))).toEqual(
        stopped("operator-stop")
      );
    }
  });

  it("copies constructor identity and exposes only frozen decisions, retaining no sample objects", () => {
    const config = configuration();
    const policy = new ComputerWatchdogPolicy(config);
    Object.assign(config.runner, { pid: 999 });
    Object.assign(config.watchdog, { startTicks: "999" });
    Object.assign(config, { runId: "changed", startedAtMs: 0 });
    const value = sample();
    const decision = policy.sample(startedAtMs, value);
    expect(Object.isFrozen(decision)).toBe(true);
    expect(() => Object.assign(decision, { status: "waiting" })).toThrow(TypeError);
    Object.assign(value, { measuredAtMs: 99_999, mossHealthy: false });
    Object.assign(value.runner, { pid: 999 });
    expect(policy.sample(startedAtMs + 1, sample(startedAtMs + 1)).status).toBe("healthy");
  });
});
