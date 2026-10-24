import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { EventEmitter, once } from "node:events";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ComputerTerminalHost } from "../../scripts/computer-host/terminal.js";
import { ComputerDocker } from "../../scripts/computer-host/docker.js";
import { HostStateStore } from "../../scripts/computer-host/state.js";
import { runManagedComputerHost } from "../../scripts/computer-watchdog/managed-host.js";
import type { SupervisorOutcome } from "../../scripts/computer-watchdog/supervisor.js";
import { lifetimePath } from "../../apps/api/src/computer/lifetime-protocol.js";
import { hostJsonRequest } from "../../apps/api/src/computer/host-http.js";
import { binding, hostFixture, OWNER, FOREIGN } from "./computer-host-fixture.js";
import { lifetimeConfiguration } from "./computer-lifetime-fixture.js";
import { processFixture } from "./computer-process-fixture.js";
import { managedNow, managedSupervisorFixture } from "./computer-managed-host-fixture.js";

vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof fs>()) }));
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
});
const request = (
  operation: "enable" | "disable" | "recreate" | "status",
  expectedGeneration = 1,
  actorUserId = OWNER
) => ({ actorUserId, operation, expectedGeneration });
const outcome: SupervisorOutcome = {
  reason: "operator-stop",
  exitCode: 0,
  receiverFenced: true,
  durableStop: true,
  collectorExited: true,
  collectorPid: null,
  collectorIdentity: null
};
const mutations = (f: Awaited<ReturnType<typeof hostFixture>>) =>
  f.calls.filter((c) => c.method !== "GET");

async function seeded() {
  const f = await hostFixture({ admitted: true });
  cleanups.push(() => f.close());
  expect((await f.client.request(binding(), "enable", 0)).state).toBe("running");
  const resources = structuredClone(f.store.state.resources);
  const lifetime = lifetimeConfiguration();
  Object.assign(lifetime.binding, {
    instanceId: f.config.instanceId,
    requestGeneration: f.store.state.generation,
    gatewayId: resources.find((x) => x.role === "gateway")!.id,
    gatewayGeneration: resources.find((x) => x.role === "gateway")!.generation,
    desktopId: resources.find((x) => x.role === "desktop")!.id,
    desktopGeneration: resources.find((x) => x.role === "desktop")!.generation
  });
  await f.releaseControl();
  f.calls.length = 0;
  return { f, resources, lifetime };
}
async function storeFor(f: Awaited<ReturnType<typeof hostFixture>>) {
  const store = await HostStateStore.openExisting(f.config);
  cleanups.push(async () => {
    if (await fs.lstat(join(f.config.stateDir, "daemon.lock")).catch(() => null))
      await store.close();
  });
  return store;
}
async function terminalFixture() {
  const { f, resources } = await seeded();
  const store = await storeFor(f);
  let clock = 0;
  const stopRoot = vi.fn();
  const terminal = new ComputerTerminalHost(store, new ComputerDocker(f.config), {
    stopRoot,
    terminal() {},
    now: () => clock
  });
  return {
    f,
    resources,
    store,
    terminal,
    stopRoot,
    setClock: (n: number) => {
      clock = n;
    }
  };
}
async function managed() {
  const { f, resources, lifetime } = await seeded();
  const store = await storeFor(f);
  const g = await processFixture(false, { autoLifetime: false, lifetime });
  cleanups.push(() => g.close());
  const signals = new EventEmitter();
  const heartbeats = new PassThrough();
  const result = runManagedComputerHost({
    store,
    now: managedNow,
    signals,
    fatal: () => {
      throw new Error("unexpected fatal");
    },
    supervise: (hooks) =>
      managedSupervisorFixture({
        lifetime,
        socketPath: lifetimePath(g.config.socketPath),
        signals,
        hooks,
        heartbeats
      })
  });
  void result.catch(() => {});
  const socketPath = join(f.config.controlDir, "host.sock");
  await expect.poll(async () => !!(await fs.lstat(socketPath).catch(() => null))).toBe(true);
  // A status request does not prove receiving activation; exercise actual viewer admission.
  const open = async () => g.open();
  let opened: Awaited<ReturnType<typeof open>> | undefined;
  await expect
    .poll(
      async () => {
        try {
          opened = await open();
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 3000 }
    )
    .toBe(true);
  const raw = (body: unknown) =>
    hostJsonRequest({
      socketPath,
      path: "/operation",
      method: "POST",
      body,
      limit: 1024,
      timeoutMs: 10_000
    });
  return { f, resources, store, g, result, signals, heartbeats, opened: opened!, raw };
}

describe("managed terminal host: native Unix/actual root+receiver, disclosed Docker/health fixtures", () => {
  it("owner and CAS denial, enable immutability precede terminal authority", async () => {
    const x = await terminalFixture();
    x.stopRoot.mockImplementation(() => {
      void x.terminal.finish(outcome);
    });
    const before = await fs.readFile(join(x.f.config.stateDir, "state.json"));
    expect(await x.terminal.request(request("enable", 1, FOREIGN))).toMatchObject({
      reason: "owner-denied"
    });
    expect(await x.terminal.request(request("disable", 1, FOREIGN))).toMatchObject({
      reason: "owner-denied"
    });
    expect(await x.terminal.request(request("disable", 0))).toMatchObject({
      reason: "stale-generation"
    });
    expect(await x.terminal.request(request("enable", 0))).toMatchObject({
      reason: "stale-generation"
    });
    expect(await x.terminal.request(request("enable"))).toMatchObject({
      reason: "prerequisite-unavailable"
    });
    expect(await fs.readFile(join(x.f.config.stateDir, "state.json"))).toEqual(before);
    expect(x.store.stopRequested).toBe(false);
    expect(x.stopRoot).not.toHaveBeenCalled();
    expect(x.f.calls).toEqual([]);
  });

  it.each(["receiverFenced", "durableStop", "collectorExited", "exitCode", "missing"])(
    "refuses cleanup without actual %s acknowledgement",
    async (key) => {
      const x = await terminalFixture();
      const bad = key === "missing" ? null : { ...outcome, [key]: key === "exitCode" ? 2 : false };
      x.terminal.stop();
      expect(x.store.stopRequested).toBe(true);
      await x.terminal.finish(bad);
      await expect(x.terminal.completed).rejects.toThrow();
      expect(mutations(x.f)).toEqual([]);
      expect(x.store.state.resources).toEqual(x.resources);
      expect(await fs.lstat(join(x.f.config.stateDir, "stop.json"))).toBeDefined();
    }
  );

  it("lifecycle equality expires before any actual Docker mutation", async () => {
    const x = await terminalFixture();
    x.terminal.stop();
    x.setClock(120_000);
    await x.terminal.finish(outcome);
    await expect(x.terminal.completed).rejects.toThrow();
    expect(mutations(x.f)).toEqual([]);
  });

  it("expiry during cleanup inspection prevents the actual stop POST", async () => {
    const x = await terminalFixture();
    const inspect = ComputerDocker.prototype.inspect;
    let reads = 0;
    vi.spyOn(ComputerDocker.prototype, "inspect").mockImplementation(async function (
      this: ComputerDocker,
      resource
    ) {
      const result = await inspect.call(this, resource);
      // Two inventory reads precede remove's own asynchronous identity inspection.
      if (++reads === 3) x.setClock(120_000);
      return result;
    });
    x.terminal.stop();
    await x.terminal.finish(outcome);
    await expect(x.terminal.completed).rejects.toThrow();
    expect(reads).toBeGreaterThanOrEqual(3);
    expect(mutations(x.f)).toEqual([]);
    expect(x.store.state.resources).toEqual(x.resources);
  });

  it.each(["roots", "file"])(
    "expiry during state %s I/O refuses CAS publication",
    async (boundary) => {
      const x = await terminalFixture();
      const before = await fs.readFile(join(x.f.config.stateDir, "state.json"));
      x.terminal.stop();
      if (boundary === "roots") {
        let publishing = false;
        const save = x.store.save.bind(x.store);
        vi.spyOn(x.store, "save").mockImplementation(async (...args) => {
          publishing = true;
          return save(...args);
        });
        const original = x.store.assertRoots.bind(x.store);
        vi.spyOn(x.store, "assertRoots").mockImplementation(async () => {
          await original();
          if (publishing) x.setClock(120_000);
        });
      } else {
        const original = fs.open;
        vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
          const file = await original(...args);
          if (String(args[0]).includes(".state-")) {
            const sync = file.sync.bind(file);
            vi.spyOn(file, "sync").mockImplementation(async () => {
              await sync();
              x.setClock(120_000);
            });
          }
          return file;
        });
      }
      await x.terminal.finish(outcome);
      await expect(x.terminal.completed).rejects.toThrow();
      expect(await fs.readFile(join(x.f.config.stateDir, "state.json"))).toEqual(before);
      expect(x.store.state.generation).toBe(1);
      expect(mutations(x.f)).toEqual([]);
    }
  );

  it("same-byte stop marker replacement during state fsync refuses publication", async () => {
    const x = await terminalFixture();
    const before = await fs.readFile(join(x.f.config.stateDir, "state.json"));
    const original = fs.open;
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const file = await original(...args);
      if (String(args[0]).includes(".state-")) {
        const sync = file.sync.bind(file);
        vi.spyOn(file, "sync").mockImplementation(async () => {
          await sync();
          const marker = join(x.f.config.stateDir, "stop.json");
          await fs.writeFile(marker + ".replacement", await fs.readFile(marker), { mode: 0o600 });
          await fs.rename(marker + ".replacement", marker);
        });
      }
      return file;
    });
    x.terminal.stop();
    await x.terminal.finish(outcome);
    await expect(x.terminal.completed).rejects.toThrow();
    expect(await fs.readFile(join(x.f.config.stateDir, "state.json"))).toEqual(before);
    expect(mutations(x.f)).toEqual([]);
  });

  it("normal disable fences actual active receiver before gateway-first cleanup and drains its response", async () => {
    const x = await managed();
    await x.opened.viewer.takeOver();
    const controller = await x.g.rfb(x.opened.viewer, true);
    controller.keyEvent(65, true);
    await expect.poll(() => x.g.events).toContainEqual(["key", 65, true]);
    const inspect = vi.spyOn(ComputerDocker.prototype, "remove");
    expect(await x.raw(request("disable"))).toMatchObject({
      state: "disabled",
      reason: "none",
      generation: 2
    });
    expect(await x.result).toBe(0);
    await expect.poll(() => x.g.events).toContainEqual(["key", 65, false]);
    expect(x.store.state.resources).toEqual(x.resources);
    expect(x.store.state.enabled).toBe(false);
    const order = mutations(x.f)
      .filter((c) => c.path.includes("/stop"))
      .map((c) => c.path);
    expect(order).toEqual(x.resources.map((r) => `/containers/${r.id}/stop?t=10`));
    expect(await fs.lstat(join(x.f.config.stateDir, "daemon.lock")).catch(() => null)).toBeNull();
    await expect(x.g.open()).rejects.toThrow();
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it("recreate stops and refuses restart; EOF independently initiates terminal cleanup", async () => {
    const x = await managed();
    expect(await x.raw(request("recreate"))).toMatchObject({
      reason: "prerequisite-unavailable",
      enabled: false
    });
    expect(await x.result).toBe(0);
    expect(
      mutations(x.f).some((c) => c.path.includes("/create") || c.path.endsWith("/start"))
    ).toBe(false);
    const y = await managed();
    y.heartbeats.end();
    expect(await y.result).toBe(0);
    expect(y.f.containers.size).toBe(0);
    expect(y.store.state.resources).toEqual(y.resources);
  });

  it.each(["file", "directory"])(
    "failed lifecycle %s fsync still fences actual receiver, retains lock and performs no mutation",
    async (kind) => {
      const x = await managed();
      const original = fs.open;
      vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const file = await original(...args);
        if (
          args[0] ===
          (kind === "file" ? join(x.f.config.stateDir, "stop.json") : x.f.config.stateDir)
        )
          vi.spyOn(file, "sync").mockRejectedValue(new Error("fixture fsync failure"));
        return file;
      });
      x.signals.emit("SIGTERM");
      await expect(x.result).rejects.toThrow();
      await expect(x.g.open()).rejects.toThrow();
      expect(mutations(x.f)).toEqual([]);
      expect(x.store.state.resources).toEqual(x.resources);
      expect(await fs.lstat(join(x.f.config.stateDir, "daemon.lock"))).toBeDefined();
    }
  );

  it.each(["file", "directory"])(
    "held lifecycle %s fsync cannot postpone receiving retirement or authorize cleanup",
    async (kind) => {
      const x = await managed();
      const original = fs.open;
      let release!: () => void;
      const held = new Promise<void>((resolveHeld) => {
        release = resolveHeld;
      });
      let syncing = false;
      vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const file = await original(...args);
        if (
          args[0] ===
          (kind === "file" ? join(x.f.config.stateDir, "stop.json") : x.f.config.stateDir)
        ) {
          const sync = file.sync.bind(file);
          vi.spyOn(file, "sync").mockImplementation(async () => {
            syncing = true;
            await held;
            await sync();
          });
        }
        return file;
      });
      try {
        x.signals.emit("SIGTERM");
        await expect.poll(() => syncing).toBe(true);
        await expect
          .poll(async () => {
            try {
              await x.g.open();
              return false;
            } catch {
              return true;
            }
          })
          .toBe(true);
        expect(mutations(x.f)).toEqual([]);
        expect(x.store.state.generation).toBe(1);
        await expect(HostStateStore.openExisting(x.f.config)).rejects.toThrow();
      } finally {
        release();
      }
      expect(await x.result).toBe(0);
      expect(x.f.containers.size).toBe(0);
      expect(x.store.state.resources).toEqual(x.resources);
    }
  );

  it("gateway cleanup failure halts desktop and retains every identity", async () => {
    const x = await managed();
    x.f.faults.remove = true;
    x.signals.emit("SIGINT");
    await expect(x.result).rejects.toThrow();
    expect(mutations(x.f).every((c) => c.path.includes(x.resources[0]!.id!))).toBe(true);
    expect(x.store.state.resources).toEqual(x.resources);
    expect(x.f.containers.size).toBe(2);
  });
});

async function nativeManaged(
  options: { holdRoot?: boolean; holdLifecycle?: "file" | "directory" } = {}
) {
  const { f, resources, lifetime } = await seeded();
  const g = await processFixture(false, { autoLifetime: false, lifetime });
  cleanups.push(() => g.close());
  const path = join(f.config.stateDir, "managed-fixture.mts");
  const url = (p: string) => JSON.stringify(pathToFileURL(resolve(p)).href);
  await fs.writeFile(
    path,
    `
    import {HostStateStore} from ${url("scripts/computer-host/state.ts")};
    import {open} from "node:fs/promises";
    import {runManagedComputerHost} from ${url("scripts/computer-watchdog/managed-host.ts")};
    import {managedNow,managedSupervisorFixture} from ${url("tests/unit/computer-managed-host-fixture.ts")};
    const config=${JSON.stringify(f.config)};
    const lifetime=${JSON.stringify(lifetime)};
    const store=await HostStateStore.openExisting(config);
    if(${!!options.holdLifecycle}) {
      const probe=await open(config.stateDir,"r");
      const prototype=Object.getPrototypeOf(probe);
      const sync=prototype.sync;
      prototype.sync=async function(){
        if(store.stopRequested && (await this.stat()).isDirectory()===${options.holdLifecycle === "directory"}) return new Promise(()=>{});
        return sync.call(this);
      };
      await probe.close();
    }
    try {
      const code=await runManagedComputerHost({store,now:managedNow,signals:process,fatal:()=>process.exit(2),
        supervise:hooks=>managedSupervisorFixture({lifetime,socketPath:${JSON.stringify(lifetimePath(g.config.socketPath))},signals:process,hooks,holdRoot:${!!options.holdRoot}})});
      process.exit(code);
    }catch{process.exit(2)}
  `
  );
  const child = spawn(process.execPath, ["--import", "tsx", path], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  const exit = once(child, "exit");
  let output = "";
  child.stdout.on("data", (c: Buffer) => {
    output = (output + c.toString()).slice(-2048);
  });
  child.stderr.on("data", (c: Buffer) => {
    output = (output + c.toString()).slice(-2048);
  });
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exit;
  });
  const socket = join(f.config.controlDir, "host.sock");
  await expect
    .poll(async () => !!(await fs.lstat(socket).catch(() => null)), { timeout: 3000 })
    .toBe(true);
  await expect
    .poll(
      async () => {
        try {
          await g.open();
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 3000 }
    )
    .toBe(true);
  return { f, resources, g, child, exit, socket, output: () => output };
}

describe("native managed executable composition with disclosed trust/collection fixtures", () => {
  it("ordinary host request drives actual root/receiver then exact cleanup and normal exit", async () => {
    const x = await nativeManaged();
    expect(
      await hostJsonRequest({
        socketPath: x.socket,
        path: "/operation",
        method: "POST",
        body: request("disable"),
        limit: 1024,
        timeoutMs: 10_000
      })
    ).toMatchObject({ state: "disabled", generation: 2 });
    expect(await x.exit).toEqual([0, null]);
    expect(x.output()).toBe("");
    expect(x.f.containers.size).toBe(0);
  });
  it.each(["file", "directory"] as const)(
    "failed root finalization exits at5s despite held lifecycle %s fsync and repeated real TERM",
    async (kind) => {
      const x = await nativeManaged({ holdRoot: true, holdLifecycle: kind });
      const started = managedNow();
      x.child.kill("SIGTERM");
      await expect
        .poll(
          async () =>
            (await fs.stat(join(x.f.config.stateDir, "stop.json")).catch(() => null))?.size ?? 0
        )
        .toBeGreaterThan(0);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 40));
      x.child.kill("SIGTERM");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const observed = await Promise.race([
          x.exit,
          new Promise((resolveBound) => {
            timer = setTimeout(() => resolveBound(["deadline-expired", null]), 6300);
          })
        ]);
        expect(observed).toEqual([2, null]);
      } finally {
        clearTimeout(timer);
      }
      expect(managedNow() - started).toBeLessThan(6500);
      expect(mutations(x.f)).toEqual([]);
      expect(await fs.lstat(join(x.f.config.stateDir, "daemon.lock"))).toBeDefined();
      expect(x.f.containers.size).toBe(2);
      await expect(x.g.open()).rejects.toThrow();
    },
    10_000
  );
});
