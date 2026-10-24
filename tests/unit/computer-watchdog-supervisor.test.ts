import { ComputerRootLifetime } from "../../scripts/computer-watchdog/lifetime.js";
import { lifetimeConfiguration } from "./computer-lifetime-fixture.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter, once } from "node:events";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { PassThrough } from "node:stream";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  runComputerSupervisor,
  spawnComputerCollector,
  type CollectorJob,
  type SupervisorJournal
} from "../../scripts/computer-watchdog/supervisor.js";
import { computerMonotonicMs } from "../../scripts/computer-watchdog/linux.js";
import type { SupervisorDeployment } from "../../scripts/computer-watchdog/trust.js";

const runId = "10000000-0000-4000-8000-000000000001";
const runner = { pid: 101, processGroupId: 101, startTicks: "123" };
const watchdog = { pid: 202, processGroupId: 202, startTicks: "456" };
const collector = { pid: 303, processGroupId: 303, startTicks: "789" };
const healthy = (at = 0) => ({
  runId,
  measuredAtMs: at,
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
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
});

function harness(
  options: {
    holdExit?: boolean;
    holdStop?: boolean;
    holdClose?: boolean;
    failStop?: boolean;
    holdSample?: boolean;
    lifetime?: boolean;
    started?: () => void;
    holdInspect?: boolean;
    abort?: AbortController;
  } = {}
) {
  vi.useFakeTimers();
  let clock = 0;
  const sample = deferred<unknown>();
  const exit = deferred<void>();
  const stop = deferred<void>();
  const close = deferred<void>();
  const sampleWrite = deferred<void>();
  const inspection = deferred<void>();
  let inspections = 0;
  const heartbeats = new PassThrough();
  const signals = new EventEmitter();
  const job: CollectorJob = {
    pid: collector.pid,
    identity: Promise.resolve(collector),
    result: sample.promise,
    exited: exit.promise,
    collect: vi.fn(),
    kill: vi.fn(() => {
      if (!options.holdExit) exit.resolve();
    })
  };
  const journal: SupervisorJournal = {
    pending: false,
    inspect: vi.fn(() =>
      options.holdInspect && ++inspections === 2 ? inspection.promise : Promise.resolve()
    ),
    collector: vi.fn(async () => {}),
    sample: vi.fn(() => (options.holdSample ? sampleWrite.promise : Promise.resolve())),
    stop: vi.fn(() =>
      options.failStop
        ? Promise.reject(new Error("fsync"))
        : options.holdStop
          ? stop.promise
          : Promise.resolve()
    ),
    close: vi.fn(() => (options.holdClose ? close.promise : Promise.resolve()))
  };
  const startCollector = vi.fn(() => job);
  const verifyRunner = vi.fn(async () => {});
  const result = runComputerSupervisor({
    configuration: { runId, startedAtMs: 0, runner, watchdog },
    ...(options.lifetime
      ? {
          lifetime: {
            configuration: lifetimeConfiguration(),
            socketPath: "/unavailable-lifetime.sock"
          }
        }
      : {}),
    started: options.started,
    ...(options.abort ? { terminalHooks: { signal: options.abort.signal, terminal() {} } } : {}),
    heartbeats,
    signals,
    journal,
    startCollector,
    verifyRunner,
    now: () => clock
  });
  cleanups.push(async () => {
    signals.emit("SIGTERM");
    exit.resolve();
    stop.resolve();
    close.resolve();
    sampleWrite.resolve();
    inspection.resolve();
    heartbeats.destroy();
  });
  const advance = async (ms: number) => {
    if (ms === 0) await vi.advanceTimersByTimeAsync(0);
    while (ms > 0) {
      const step = Math.min(ms, 1000);
      clock += step;
      await vi.advanceTimersByTimeAsync(step);
      ms -= step;
    }
  };
  return {
    job,
    journal,
    result,
    sample,
    exit,
    stop,
    close,
    sampleWrite,
    inspection,
    signals,
    heartbeats,
    advance,
    startCollector,
    verifyRunner,
    jump(ms: number) {
      clock += ms;
    }
  };
}

describe("independent Computer supervisor driver, disclosed journal/process ports", () => {
  it("persists first terminal reason once and ignores late samples, heartbeat and repeated signals", async () => {
    const f = harness();
    await f.advance(0);
    expect(f.job.collect).toHaveBeenCalledWith(collector);
    f.signals.emit("SIGTERM");
    f.signals.emit("SIGINT");
    f.sample.resolve(healthy());
    f.heartbeats.write(`${JSON.stringify({ runId, counter: 1 })}\n`);
    await f.advance(0);
    expect(await f.result).toMatchObject({
      reason: "operator-stop",
      exitCode: 0,
      durableStop: true,
      collectorExited: true,
      collectorIdentity: collector
    });
    expect(f.journal.stop).toHaveBeenCalledTimes(1);
    expect(f.journal.sample).not.toHaveBeenCalled();
    expect(f.startCollector).toHaveBeenCalledTimes(1);
  });
  it("ticks and initiates durable stop without waiting for a hung collector's exit", async () => {
    const f = harness({ holdExit: true });
    await f.advance(0);
    await f.advance(5000);
    expect(f.job.kill).toHaveBeenCalledTimes(1);
    expect(f.journal.stop).toHaveBeenCalledWith(
      5000,
      "measurement-failed",
      collector,
      collector.pid
    );
    await f.advance(4999);
    let completed = false;
    void f.result.then(() => {
      completed = true;
    });
    await f.advance(0);
    expect(completed).toBe(false);
    await f.advance(1);
    expect(await f.result).toMatchObject({
      exitCode: 2,
      durableStop: true,
      collectorExited: false,
      collectorIdentity: collector
    });
  });
  it.each(["holdStop", "holdClose"] as const)(
    "bounds %s independently and never reports successful finalization",
    async (option) => {
      const f = harness({ [option]: true });
      await f.advance(0);
      f.signals.emit("SIGTERM");
      await f.advance(5000);
      expect(await f.result).toMatchObject({
        exitCode: 2,
        collectorExited: true,
        durableStop: option === "holdClose"
      });
      expect(f.journal.stop).toHaveBeenCalledTimes(1);
    }
  );
  it("does not report success when finalization settles at the absolute deadline before its timer", async () => {
    const f = harness({ holdStop: true });
    await f.advance(0);
    f.signals.emit("SIGTERM");
    f.jump(5000);
    f.stop.resolve();
    await f.advance(0);
    expect(await f.result).toMatchObject({ exitCode: 2, durableStop: true, collectorExited: true });
  });
  it("reports failed fsync despite acknowledged child exit", async () => {
    const f = harness({ failStop: true });
    await f.advance(0);
    f.signals.emit("SIGTERM");
    await f.advance(0);
    expect(await f.result).toMatchObject({ exitCode: 2, durableStop: false });
  });
  it("persists raw owned PID when identity acquisition and exit acknowledgement are unavailable", async () => {
    const f = harness({ holdExit: true });
    const identity = deferred<typeof collector>();
    Object.defineProperty(f.job, "identity", { value: identity.promise });
    await f.advance(0);
    f.signals.emit("SIGTERM");
    await f.advance(5000);
    expect(f.journal.stop).toHaveBeenCalledWith(0, "operator-stop", null, collector.pid);
    expect(await f.result).toMatchObject({
      exitCode: 2,
      durableStop: true,
      collectorExited: false,
      collectorPid: collector.pid,
      collectorIdentity: null
    });
    identity.resolve(collector);
    await f.advance(0);
    expect(f.job.collect).not.toHaveBeenCalled();
  });
  it("does not freshen old sample timestamps", async () => {
    const f = harness();
    await f.advance(0);
    f.jump(5000);
    f.sample.resolve(healthy(0));
    await f.advance(0);
    expect(await f.result).toMatchObject({ reason: "measurement-failed", exitCode: 1 });
  });
  it("never publishes a lifetime until its first healthy sample is durable", async () => {
    // Driver ordering observation only; separate-process suites exercise the real IPC publisher.
    const start = vi.spyOn(ComputerRootLifetime.prototype, "start").mockImplementation(() => {});
    const f = harness({ holdSample: true, lifetime: true });
    await f.advance(0);
    f.sample.resolve(healthy());
    await f.advance(0);
    expect(start).not.toHaveBeenCalled();
    f.sampleWrite.resolve();
    await f.advance(0);
    expect(start).toHaveBeenCalledTimes(1);
    f.signals.emit("SIGTERM");
    await f.advance(0);
    expect(await f.result).toMatchObject({ exitCode: 2, receiverFenced: false });
  });
  it("sample persistence completing at age equality cannot publish a lifetime", async () => {
    const start = vi.spyOn(ComputerRootLifetime.prototype, "start");
    const f = harness({ holdSample: true, lifetime: true });
    await f.advance(0);
    f.sample.resolve(healthy());
    await f.advance(0);
    f.jump(5000);
    f.sampleWrite.resolve();
    await f.advance(0);
    expect(start).not.toHaveBeenCalled();
    expect(await f.result).toMatchObject({ exitCode: 2, receiverFenced: false });
  });
  it("bounds sample persistence without suspending ticks", async () => {
    const f = harness({ holdSample: true });
    await f.advance(0);
    f.sample.resolve(healthy());
    await f.advance(0);
    await f.advance(5000);
    expect(f.journal.stop).toHaveBeenCalledTimes(1);
    await f.advance(0);
    expect(await f.result).toMatchObject({ reason: "measurement-failed" });
    f.sampleWrite.resolve();
    await f.advance(0);
    expect(f.startCollector).toHaveBeenCalledTimes(1);
  });
  it.each([
    "bad\n",
    `${"x".repeat(513)}`,
    `${JSON.stringify({ runId, counter: 2 })}\n`,
    `${JSON.stringify({ runId: "other", counter: 1 })}\n`
  ])("rejects malformed, oversized, skipped or foreign heartbeat", async (frame) => {
    const f = harness();
    await f.advance(0);
    f.heartbeats.write(frame);
    await f.advance(0);
    expect(await f.result).toMatchObject({ reason: "operator-stop" });
    expect(f.verifyRunner).not.toHaveBeenCalled();
  });
  it("reobserves the runner before heartbeat and refuses death/EOF", async () => {
    const f = harness();
    await f.advance(0);
    f.verifyRunner.mockRejectedValueOnce(new Error("dead"));
    f.heartbeats.write(`${JSON.stringify({ runId, counter: 1 })}\n`);
    await f.advance(0);
    expect(await f.result).toMatchObject({ reason: "measurement-failed" });
  });
  it("refuses expiry before accepting a heartbeat or sample", async () => {
    const f = harness();
    await f.advance(0);
    // A delayed event-loop turn must check policy expiry before accepting any update.
    f.jump(90000);
    await f.advance(1000);
    f.heartbeats.write(`${JSON.stringify({ runId, counter: 1 })}\n`);
    f.sample.resolve(healthy(90000));
    await f.advance(5000);
    expect(await f.result).toMatchObject({ reason: "heartbeat-expired" });
    expect(f.journal.sample).not.toHaveBeenCalled();
  });
});

describe("first complete durable healthy bootstrap; disclosed driver ports", () => {
  it("acknowledges exactly once only after sample persistence and owned inspection", async () => {
    const started = vi.fn();
    const f = harness({ started, holdSample: true, holdInspect: true });
    await f.advance(0);
    expect(started).not.toHaveBeenCalled();
    f.sample.resolve(healthy());
    await f.advance(0);
    expect(f.journal.sample).toHaveBeenCalledTimes(1);
    expect(started).not.toHaveBeenCalled();
    f.sampleWrite.resolve();
    await f.advance(0);
    expect(f.journal.inspect).toHaveBeenCalledTimes(2);
    expect(started).not.toHaveBeenCalled();
    f.inspection.resolve();
    await f.advance(0);
    expect(started).toHaveBeenCalledTimes(1);
    Object.defineProperty(f.job, "result", { value: Promise.resolve(healthy(5000)) });
    await f.advance(5000);
    expect(f.journal.sample).toHaveBeenCalledTimes(2);
    expect(started).toHaveBeenCalledTimes(1);
    expect(f.journal.stop).not.toHaveBeenCalled();
  });
  it.each(["sample", "inspection"])(
    "refuses bootstrap equality after held %s even with fresh measurement",
    async (stage) => {
      const started = vi.fn();
      const f = harness({
        started,
        holdSample: stage === "sample",
        holdInspect: stage === "inspection"
      });
      await f.advance(0);
      f.jump(4000);
      f.sample.resolve(healthy(4000));
      await f.advance(0);
      f.jump(1000);
      f.sampleWrite.resolve();
      f.inspection.resolve();
      await f.advance(0);
      expect(started).not.toHaveBeenCalled();
      expect(await f.result).toMatchObject({ reason: "measurement-failed" });
    }
  );
  it("refuses bootstrap equality before sample persistence", async () => {
    const started = vi.fn();
    const f = harness({ started });
    await f.advance(0);
    f.jump(5000);
    f.sample.resolve(healthy(5000));
    await f.advance(0);
    expect(f.journal.sample).not.toHaveBeenCalled();
    expect(started).not.toHaveBeenCalled();
    expect(await f.result).toMatchObject({ reason: "measurement-failed" });
  });
  it.each(["sample", "inspection"])(
    "refuses stale sample at age equality after %s",
    async (stage) => {
      const started = vi.fn();
      const f = harness({
        started,
        holdSample: stage === "sample",
        holdInspect: stage === "inspection"
      });
      await f.advance(0);
      f.sample.resolve(healthy());
      await f.advance(0);
      f.jump(5000);
      f.sampleWrite.resolve();
      f.inspection.resolve();
      await f.advance(0);
      expect(started).not.toHaveBeenCalled();
      expect(await f.result).toMatchObject({ reason: "measurement-failed" });
    }
  );
  it.each(["signal", "abort"])(
    "%s during pending inspection cannot acknowledge on late completion",
    async (mode) => {
      const started = vi.fn();
      const abort = new AbortController();
      const f = harness({ started, holdInspect: true, abort });
      await f.advance(0);
      f.sample.resolve(healthy());
      await f.advance(0);
      if (mode === "abort") abort.abort();
      else {
        f.signals.emit("SIGTERM");
        f.signals.emit("SIGINT");
      }
      f.inspection.resolve();
      await f.advance(0);
      expect(started).not.toHaveBeenCalled();
      expect(await f.result).toMatchObject({ reason: "operator-stop" });
    }
  );
  it.each(["deadline", "signal"])(
    "rechecks %s after lifetime startup before notification",
    async (mode) => {
      const started = vi.fn();
      const start = vi.spyOn(ComputerRootLifetime.prototype, "start").mockImplementation(() => {
        if (mode === "deadline") f.jump(5000);
        else f.signals.emit("SIGTERM");
      });
      const f = harness({ started, lifetime: true });
      await f.advance(0);
      f.sample.resolve(healthy());
      await f.advance(0);
      expect(start).toHaveBeenCalledTimes(1);
      expect(started).not.toHaveBeenCalled();
      expect(await f.result).toHaveProperty("exitCode", 2);
    }
  );
  it("held native identity cannot acknowledge initial driver installation", async () => {
    const started = vi.fn();
    const f = harness({ started });
    const identity = deferred<typeof collector>();
    Object.defineProperty(f.job, "identity", { value: identity.promise });
    await f.advance(0);
    expect(f.job.collect).not.toHaveBeenCalled();
    expect(started).not.toHaveBeenCalled();
    f.signals.emit("SIGTERM");
    identity.resolve(collector);
    f.sample.resolve(healthy());
    await f.advance(0);
    expect(started).not.toHaveBeenCalled();
    expect(f.journal.sample).not.toHaveBeenCalled();
    expect(await f.result).toHaveProperty("reason", "operator-stop");
  });
  it("throwing notification is terminal and cannot be retried", async () => {
    const started = vi.fn(() => {
      throw new Error("notification failed");
    });
    const f = harness({ started });
    await f.advance(0);
    f.sample.resolve(healthy());
    await f.advance(0);
    expect(await f.result).toMatchObject({ reason: "measurement-failed" });
    await f.advance(10000);
    expect(started).toHaveBeenCalledTimes(1);
    expect(f.startCollector).toHaveBeenCalledTimes(1);
  });
  it.each(["sample", "inspect"] as const)("failed %s cannot acknowledge", async (method) => {
    const started = vi.fn();
    const f = harness({ started });
    await f.advance(0);
    vi.mocked(f.journal[method]).mockRejectedValueOnce(new Error("disk failure"));
    f.sample.resolve(healthy());
    await f.advance(0);
    expect(started).not.toHaveBeenCalled();
    expect(await f.result).toMatchObject({ reason: "measurement-failed" });
  });
  it.each([null, { ...healthy(), mossHealthy: false }])(
    "malformed or unhealthy result cannot acknowledge",
    async (value) => {
      const started = vi.fn();
      const f = harness({ started });
      await f.advance(0);
      f.sample.resolve(value);
      await f.advance(0);
      expect(started).not.toHaveBeenCalled();
      expect(f.journal.sample).not.toHaveBeenCalled();
      expect(await f.result).toHaveProperty("exitCode", 1);
    }
  );
});

describe("fixed native collector process transport, executable fixtures only", () => {
  it("keeps real OS TERM handlers active while terminal persistence is pending", async () => {
    const root = await mkdtemp(join(tmpdir(), "computer-signals-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const file = join(root, "signals.mts");
    const source = pathToFileURL(
      join(process.cwd(), "scripts/computer-watchdog/supervisor.ts")
    ).href;
    await writeFile(
      file,
      `import {runComputerSupervisor} from ${JSON.stringify(source)};
      import {PassThrough} from 'node:stream';
      let release; const held=new Promise(resolve=>release=resolve);
      process.stdin.once('data',()=>release());
      const now=()=>Number(process.hrtime.bigint()/1000000n);
      const pending=runComputerSupervisor({configuration:${JSON.stringify({ runId, runner, watchdog })},
        now,signals:process,heartbeats:new PassThrough(),verifyRunner:async()=>{},
        journal:{pending:false,inspect:async()=>{},collector:async()=>{},sample:async()=>{},close:async()=>{},stop:async()=>{console.log('stopping');await held}},
        startCollector:()=>({pid:303,identity:Promise.resolve(${JSON.stringify(collector)}),result:new Promise(()=>{}),exited:Promise.resolve(),collect(){},kill(){}})});
      console.log('ready');pending.then(result=>{console.log(JSON.stringify(result));process.exit(result.exitCode)});`.replace(
        `configuration:${JSON.stringify({ runId, runner, watchdog })}`,
        `configuration:{...${JSON.stringify({ runId, runner, watchdog })},startedAtMs:now()}`
      )
    );
    const child = spawn(process.execPath, ["--import", "tsx", file], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: process.cwd()
    });
    cleanups.push(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const done = once(child, "exit");
        child.kill("SIGKILL");
        await done;
      }
    });
    const lines = new Set<string>();
    const messages = new EventEmitter();
    let buffer = "";
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n");
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        lines.add(line);
        messages.emit(line);
      }
    });
    const line = async (name: string) => {
      if (!lines.has(name)) await once(messages, name);
    };
    await line("ready");
    child.kill("SIGTERM");
    await line("stopping");
    child.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(child.signalCode).toBeNull();
    const exited = once(child, "exit");
    child.stdin.end("release");
    expect(await exited).toEqual([0, null]);
    expect(stderr).toBe("");
  });
  async function native(code: string) {
    const root = await mkdtemp(join(tmpdir(), "computer-child-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const artifactPath = join(root, "fixture.cjs");
    await writeFile(artifactPath, code);
    // Only the fixed transport fields are used. This is not a trusted deployment/config fixture.
    const deployment = {
      nodePath: process.execPath,
      artifactPath,
      configPath: "fixture",
      configSha256: "a".repeat(64),
      configuration: { runId }
    } as SupervisorDeployment;
    const job = spawnComputerCollector(deployment, watchdog);
    void job.result.catch(() => {});
    cleanups.push(async () => {
      job.kill();
      await job.exited;
    });
    return job;
  }
  it("records a real detached child identity and accepts exactly one correlated closed result", async () => {
    const job = await native(
      `process.stdin.resume();process.stdin.on('end',()=>process.stdout.end(JSON.stringify({runId:${JSON.stringify(runId)},sample:{proof:1}})));`
    );
    const identity = await job.identity;
    expect(identity.processGroupId).toBe(job.pid);
    job.collect(identity);
    expect(await job.result).toEqual({ proof: 1 });
    await job.exited;
  });
  it.each([
    "process.stdout.end('bad')",
    "process.stdout.end('x'.repeat(16385))",
    "process.stdout.end(JSON.stringify({runId:'wrong',sample:{}}))"
  ])("rejects truncated, oversized or uncorrelated child output", async (code) => {
    const job = await native(`process.stdin.resume();process.stdin.on('end',()=>{${code}});`);
    job.collect(await job.identity);
    await expect(job.result).rejects.toThrow("Computer supervisor unavailable");
    await job.exited;
  });
  it("the real supervisor timer stops a collector blocked synchronously in another process", async () => {
    const job = await native("process.stdin.resume();process.stdin.on('end',()=>{while(true){}});");
    const beats = new PassThrough();
    const signals = new EventEmitter();
    const journal: SupervisorJournal = {
      pending: false,
      inspect: async () => {},
      collector: vi.fn(async () => {}),
      sample: async () => {},
      stop: vi.fn(async () => {}),
      close: async () => {}
    };
    const at = computerMonotonicMs();
    const result = await runComputerSupervisor({
      configuration: { runId, runner, watchdog, startedAtMs: at },
      heartbeats: beats,
      signals,
      journal,
      startCollector: () => job,
      verifyRunner: async () => {},
      now: computerMonotonicMs
    });
    beats.destroy();
    expect(result).toMatchObject({
      reason: "measurement-failed",
      durableStop: true,
      collectorExited: true,
      exitCode: 1
    });
    expect(computerMonotonicMs() - at).toBeLessThan(8000);
    expect(journal.collector).toHaveBeenCalledWith(await job.identity);
    expect(journal.stop).toHaveBeenCalledTimes(1);
  });
});
