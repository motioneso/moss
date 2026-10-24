import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { ComputerDocker } from "../../scripts/computer-host/docker.js";
import { HostStateStore, privateJson } from "../../scripts/computer-host/state.js";
import {
  inspectComputerRecovery,
  persistComputerStop,
  stopComputerRecovery
} from "../../scripts/computer-host/recovery.js";
import { binding, hostFixture, isolatedConfig } from "./computer-host-fixture.js";

vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof fs>()) }));
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture(admitted = true) {
  const f = await hostFixture({ admitted });
  cleanups.push(() => f.close());
  return {
    ...f,
    get store() {
      return f.store;
    },
    docker: new ComputerDocker(f.config)
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const marker = (f: Fixture) => join(f.config.stateDir, "stop.json");
const mutations = (f: Fixture) => f.calls.filter((call) => call.method !== "GET");
async function running() {
  const f = await fixture();
  expect((await f.client.request(binding(), "enable", 0)).state).toBe("running");
  f.calls.length = 0;
  return f;
}
async function invoke(f: Fixture, operation: string, extra: string[] = []) {
  const config = join(f.config.stateDir, "recovery-config.json");
  await fs.writeFile(config, JSON.stringify(f.config), { mode: 0o600 });
  const child = spawn(
    process.execPath,
    ["--import", "tsx", resolve("scripts/computer-recovery.ts"), operation, config, ...extra],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  let stdout = "";
  let stderr = "";
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  child.stdout.on("data", (bytes: Buffer) => {
    stdout += bytes.toString();
  });
  child.stderr.on("data", (bytes: Buffer) => {
    stderr += bytes.toString();
  });
  try {
    const exit = await new Promise<number | null>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("exit", resolveExit);
    });
    return { exit, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

describe("explicit terminal reconciliation (native files/Unix HTTP; no real Docker)", () => {
  it("existing-only open never initializes missing identity/state", async () => {
    const f = await isolatedConfig();
    cleanups.push(f.close);
    await expect(HostStateStore.openExisting(f.config)).rejects.toThrow();
    expect(await fs.readdir(f.config.stateDir)).toEqual([]);
    await fs.writeFile(join(f.config.stateDir, "stop.json"), "partial", { mode: 0o600 });
    await expect(HostStateStore.open(f.config)).rejects.toThrow();
    expect(await fs.readdir(f.config.stateDir)).toEqual(["stop.json"]);
  });

  it("refuses live and stale locks without stealing them", async () => {
    const f = await fixture();
    const lock = join(f.config.stateDir, "daemon.lock");
    const before = await fs.lstat(lock);
    await expect(HostStateStore.openExisting(f.config)).rejects.toThrow();
    expect((await fs.lstat(lock)).ino).toBe(before.ino);
    await f.releaseControl();
    await fs.writeFile(lock, "stale", { mode: 0o600 });
    await expect(HostStateStore.openExisting(f.config)).rejects.toThrow();
    expect(await fs.readFile(lock, "utf8")).toBe("stale");
  });

  it("inspection is read-only, including resolving a pending name in memory", async () => {
    const f = await running();
    await f.store.save({
      ...f.store.state,
      resources: f.store.state.resources.map((r) => ({ ...r, id: null }))
    });
    const before = await fs.readFile(join(f.config.stateDir, "state.json"));
    expect(await inspectComputerRecovery(f.store, f.docker)).toEqual({
      operation: "inspect",
      terminal: false,
      remainingResources: 2
    });
    expect(await fs.readFile(join(f.config.stateDir, "state.json"))).toEqual(before);
    expect(mutations(f)).toEqual([]);
    expect(await fs.readdir(f.config.stateDir)).not.toContain("stop.json");
  });

  it("fsyncs immutable first intent, advances CAS, retains full IDs and home after stop/restart", async () => {
    const f = await running();
    const resources = structuredClone(f.store.state.resources);
    await fs.writeFile(join(f.config.homeDir, "kept"), "same home");
    await persistComputerStop(f.store);
    const first = await fs.readFile(marker(f));
    expect(await stopComputerRecovery(f.store, f.docker)).toEqual({
      operation: "stop",
      terminal: true,
      remainingResources: 0
    });
    expect(f.store.state).toMatchObject({ generation: 2, enabled: false, resources });
    expect(await fs.readFile(marker(f))).toEqual(first);
    expect(
      mutations(f)
        .filter((c) => c.path.includes("/stop?"))
        .map((c) => c.path)
    ).toEqual(resources.map((r) => `/containers/${r.id}/stop?t=10`));
    expect(
      mutations(f)
        .filter((c) => c.method === "DELETE")
        .every((c) => c.path.endsWith("?force=0&v=0"))
    ).toBe(true);
    expect(await fs.readFile(join(f.config.homeDir, "kept"), "utf8")).toBe("same home");
    await f.restart(f.admission);
    expect(f.store.state.resources).toEqual(resources);
    f.calls.length = 0;
    f.admission.assertAdmitted.mockClear();
    expect((await f.client.request(binding(), "enable", 2)).reason).toBe(
      "prerequisite-unavailable"
    );
    expect((await f.client.request(binding(), "recreate", 2)).reason).toBe(
      "prerequisite-unavailable"
    );
    expect((await f.client.request(binding(), "disable", 2)).reason).toBe(
      "prerequisite-unavailable"
    );
    expect(f.admission.assertAdmitted).not.toHaveBeenCalled();
    expect(f.calls).toEqual([]);
    expect(await fs.readFile(marker(f))).toEqual(first);
    await expect(f.store.save({ ...f.store.state, resources: [] })).rejects.toThrow();
    await expect(f.store.save({ ...f.store.state, enabled: true })).rejects.toThrow();
  });

  it.each(["file", "directory", "write"])(
    "failed %s durability retains latch/identities with zero Docker mutation",
    async (kind) => {
      const f = await running();
      const before = structuredClone(f.store.state);
      const original = fs.open;
      vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const handle = await original(...args);
        const path = String(args[0]);
        if (kind === "file" && path === marker(f))
          vi.spyOn(handle, "sync").mockRejectedValue(new Error("disk"));
        if (kind === "directory" && path === f.config.stateDir)
          vi.spyOn(handle, "sync").mockRejectedValue(new Error("disk"));
        if (kind === "write" && path === marker(f))
          vi.spyOn(handle, "writeFile").mockRejectedValue(new Error("disk"));
        return handle;
      });
      await expect(stopComputerRecovery(f.store, f.docker)).rejects.toThrow();
      expect(f.calls).toEqual([]);
      expect(f.store.state).toEqual(before);
      expect(f.store.stopRequested).toBe(true);
      expect((await fs.lstat(marker(f))).isFile()).toBe(true);
      vi.restoreAllMocks();
      await expect(f.store.assertLaunchable()).rejects.toThrow();
      await fs.unlink(marker(f)); // Disclosed hostile operator removal: local terminal latch must remain.
      await expect(f.store.assertLaunchable()).rejects.toThrow();
    }
  );

  it("held fsync suspends cleanup but not immediate local launch refusal", async () => {
    const f = await running();
    const original = fs.open;
    let release!: () => void;
    let entered!: () => void;
    const reached = new Promise<void>((r) => {
      entered = r;
    });
    const hold = new Promise<void>((r) => {
      release = r;
    });
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await original(...args);
      if (String(args[0]) === marker(f)) {
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, "sync").mockImplementation(async () => {
          entered();
          await hold;
          await sync();
        });
      }
      return handle;
    });
    const stopping = stopComputerRecovery(f.store, f.docker);
    try {
      await reached;
      await expect(f.store.assertLaunchable()).rejects.toThrow();
      expect(f.calls).toEqual([]);
    } finally {
      release();
    }
    await stopping;
  });

  it("resyncs an existing marker instead of trusting a previous failed fsync", async () => {
    const f = await running();
    await persistComputerStop(f.store);
    const original = fs.open;
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await original(...args);
      if (String(args[0]) === marker(f))
        vi.spyOn(handle, "sync").mockRejectedValue(new Error("disk"));
      return handle;
    });
    await expect(stopComputerRecovery(f.store, f.docker)).rejects.toThrow();
    expect(mutations(f)).toEqual([]);
  });

  it("records resolved pending IDs before mutation and retains them after restart and removal", async () => {
    const f = await running();
    const ids = structuredClone(f.store.state.resources);
    await f.store.save({ ...f.store.state, resources: ids.map((r) => ({ ...r, id: null })) });
    const remove = f.docker.remove.bind(f.docker);
    vi.spyOn(f.docker, "remove").mockImplementation(async (...args) => {
      expect(
        ((await privateJson(join(f.config.stateDir, "state.json"))) as { resources: unknown })
          .resources
      ).toEqual(ids);
      return remove(...args);
    });
    await stopComputerRecovery(f.store, f.docker);
    expect(f.store.state.resources).toEqual(ids);
    expect(
      JSON.parse(await fs.readFile(marker(f), "utf8")).state.resources.every(
        (r: { id: unknown }) => r.id === null
      )
    ).toBe(true);
    await f.restart();
    expect(f.store.state.resources).toEqual(ids);
    expect((await stopComputerRecovery(f.store, f.docker)).remainingResources).toBe(0);
    expect(f.store.state.generation).toBe(3);
    expect(f.store.state.resources).toEqual(ids);
  });

  it("pending-name404 remains unresolved across repeated explicit attempts", async () => {
    const f = await fixture();
    f.faults.createWithoutResult = true;
    await f.client.request(binding(), "enable", 0);
    const pending = structuredClone(f.store.state.resources);
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(stopComputerRecovery(f.store, f.docker)).rejects.toThrow();
      expect(f.store.state.resources).toEqual(pending);
    }
    expect(f.store.state.generation).toBe(3);
    expect(f.calls.filter((c) => c.path.startsWith("/containers/create"))).toHaveLength(1);
  });

  it("gateway removal failure halts before touching desktop and retains exact IDs", async () => {
    const f = await running();
    const resources = structuredClone(f.store.state.resources);
    f.faults.remove = true;
    await expect(stopComputerRecovery(f.store, f.docker)).rejects.toThrow();
    const desktop = resources.find((r) => r.role === "desktop")!;
    expect(mutations(f).some((c) => c.path.includes(desktop.id!))).toBe(false);
    expect(f.store.state.resources).toEqual(resources);
    expect(f.store.state.generation).toBe(2);
    f.faults.remove = false;
    expect((await stopComputerRecovery(f.store, f.docker)).remainingResources).toBe(0);
    expect(f.store.state.generation).toBe(3);
  });

  it("lost gateway DELETE reply retains uncertainty; later initial known-ID404 permits desktop cleanup", async () => {
    const f = await running();
    const resources = structuredClone(f.store.state.resources);
    f.faults.removeWithoutResult = true;
    await expect(stopComputerRecovery(f.store, f.docker)).rejects.toThrow();
    expect(f.containers.size).toBe(1);
    expect(f.store.state.resources).toEqual(resources);
    f.faults.removeWithoutResult = false;
    expect((await stopComputerRecovery(f.store, f.docker)).remainingResources).toBe(0);
    expect(f.store.state.resources).toEqual(resources);
  });

  it("image/spec404 never clears identities or authorizes mutation", async () => {
    const f = await running();
    const resources = structuredClone(f.store.state.resources);
    f.faults.missingImage = true;
    await expect(stopComputerRecovery(f.store, f.docker)).rejects.toThrow();
    expect(mutations(f)).toEqual([]);
    expect(f.store.state.resources).toEqual(resources);
  });

  it.each(["malformed", "symlink", "fifo", "mode", "hardlink"])(
    "unsafe %s stop marker blocks launch and mutation",
    async (kind) => {
      const f = await running();
      await persistComputerStop(f.store);
      if (kind === "malformed") await fs.writeFile(marker(f), "{");
      if (kind === "mode") await fs.chmod(marker(f), 0o644);
      if (kind === "hardlink") await fs.link(marker(f), join(f.config.stateDir, "other"));
      if (kind === "symlink") {
        await fs.rename(marker(f), `${marker(f)}.old`);
        await fs.symlink(`${marker(f)}.old`, marker(f));
      }
      if (kind === "fifo") {
        await fs.unlink(marker(f));
        const child = spawn("mkfifo", ["-m", "600", marker(f)]);
        await new Promise<void>((done, reject) => {
          child.once("error", reject);
          child.once("exit", (code) => (code === 0 ? done() : reject(new Error("mkfifo failed"))));
        });
      }
      await expect(f.store.assertLaunchable()).rejects.toThrow();
      await expect(stopComputerRecovery(f.store, f.docker)).rejects.toThrow();
      expect(mutations(f)).toEqual([]);
    }
  );

  it.each(["instance", "roots", "role", "generation", "id"])(
    "refuses %s marker tuple substitution",
    async (kind) => {
      const f = await running();
      await persistComputerStop(f.store);
      const value = JSON.parse(await fs.readFile(marker(f), "utf8"));
      if (kind === "instance") value.instanceId = "wrong";
      if (kind === "roots") value.roots = [];
      if (kind === "role") value.state.resources = value.state.resources.slice(1);
      if (kind === "generation") value.state.generation++;
      if (kind === "id") value.state.resources[0].id = "e".repeat(64);
      await fs.writeFile(marker(f), JSON.stringify(value));
      await expect(stopComputerRecovery(f.store, f.docker)).rejects.toThrow();
      expect(mutations(f)).toEqual([]);
    }
  );

  it("generation exhaustion retains terminal record without mutation", async () => {
    const f = await running();
    await f.store.save({ ...f.store.state, generation: Number.MAX_SAFE_INTEGER });
    await expect(stopComputerRecovery(f.store, f.docker)).rejects.toThrow();
    expect(mutations(f)).toEqual([]);
    expect(f.store.stopRequested).toBe(true);
  });

  it("stop during awaited admission refuses create and retains terminal state", async () => {
    const f = await fixture();
    f.admission.assertAdmitted.mockImplementationOnce(async () => {
      await persistComputerStop(f.store);
    });
    expect((await f.client.request(binding(), "enable", 0)).reason).toBe(
      "prerequisite-unavailable"
    );
    expect(mutations(f)).toEqual([]);
    expect(f.store.stopRequested).toBe(true);
  });

  it("late create result after stop is durably retained but never started or automatically erased", async () => {
    const f = await fixture();
    f.faults.beforeCreateResult = async () => {
      await persistComputerStop(f.store);
    };
    expect((await f.client.request(binding(), "enable", 0)).reason).toBe("runtime-unavailable");
    expect(f.store.state.enabled).toBe(false);
    expect(f.store.state.resources).toEqual([
      { role: "gateway", generation: 1, id: [...f.containers.keys()][0] }
    ]);
    expect(mutations(f)).toHaveLength(1);
    expect(mutations(f)[0]!.path).toContain("/containers/create");
  });

  it("terminal entry during Docker start inspect blocks the actual POST", async () => {
    const f = await running();
    const inspect = f.docker.inspect.bind(f.docker);
    vi.spyOn(f.docker, "inspect").mockImplementationOnce(async (resource) => {
      const result = await inspect(resource);
      f.store.latchStop();
      return result;
    });
    await expect(
      f.docker.start(f.store.state.resources[0]!, {
        check: () => f.store.assertLaunchable(),
        assertCurrent: () => f.store.assertNotStopped()
      })
    ).rejects.toThrow();
    expect(mutations(f)).toEqual([]);
  });

  it("final synchronous guard catches stop between awaited check and mutation", async () => {
    const f = await fixture();
    await expect(
      f.docker.create(
        { role: "gateway", generation: 0, id: null },
        {
          check: async () => {
            f.store.latchStop();
          },
          assertCurrent: () => f.store.assertNotStopped()
        }
      )
    ).rejects.toThrow();
    expect(mutations(f)).toEqual([]);
  });

  it.each(["roots", "file-sync"])(
    "terminal entry during state save %s prevents enabled or identity-erasing publication",
    async (point) => {
      const f = await running();
      const before = structuredClone(f.store.state);
      if (point === "roots") {
        const roots = f.store.assertRoots.bind(f.store);
        vi.spyOn(f.store, "assertRoots").mockImplementationOnce(async () => {
          await roots();
          f.store.latchStop();
        });
      } else {
        const original = fs.open;
        vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
          const handle = await original(...args);
          if (String(args[0]).includes(".state-")) {
            const sync = handle.sync.bind(handle);
            vi.spyOn(handle, "sync").mockImplementationOnce(async () => {
              await sync();
              f.store.latchStop();
            });
          }
          return handle;
        });
      }
      await expect(f.store.save({ ...before, resources: [] })).rejects.toThrow();
      expect(f.store.state).toEqual(before);
      expect(await privateJson(join(f.config.stateDir, "state.json"))).toEqual(before);
      expect(mutations(f)).toEqual([]);
    }
  );

  it("late create identity survives terminal entry during its state-file fsync", async () => {
    const f = await fixture();
    const original = fs.open;
    let stopped = false;
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await original(...args);
      const path = String(args[0]);
      if (path.includes(".state-")) {
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, "sync").mockImplementationOnce(async () => {
          await sync();
          const pending = JSON.parse(await fs.readFile(path, "utf8"));
          if (!stopped && pending.resources.some((r: { id: string | null }) => r.id !== null)) {
            stopped = true;
            await persistComputerStop(f.store);
          }
        });
      }
      return handle;
    });
    expect((await f.client.request(binding(), "enable", 0)).reason).toBe("runtime-unavailable");
    expect(stopped).toBe(true);
    expect(f.store.state.enabled).toBe(false);
    expect(f.store.state.resources).toEqual([
      { role: "gateway", generation: 1, id: [...f.containers.keys()][0] }
    ]);
    expect(await privateJson(join(f.config.stateDir, "state.json"))).toEqual(f.store.state);
    expect(mutations(f)).toHaveLength(1);
    expect(mutations(f)[0]!.path).toContain("/containers/create");
  });

  it("terminal snapshot during directory fsync observes the already published state", async () => {
    const f = await running();
    const original = fs.open;
    let stopped = false;
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await original(...args);
      if (String(args[0]) === f.config.stateDir) {
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, "sync").mockImplementationOnce(async () => {
          if (!stopped) {
            stopped = true;
            await persistComputerStop(f.store);
          }
          await sync();
        });
      }
      return handle;
    });
    const state = { ...f.store.state, enabled: false, generation: 2 };
    await f.store.save(state);
    expect(((await privateJson(marker(f))) as { state: unknown }).state).toEqual(state);
    expect(f.store.state).toEqual(state);
    expect(mutations(f)).toEqual([]);
  });

  it("terminal entry during normal disable inspect prevents every actual mutation", async () => {
    const f = await running();
    const before = structuredClone(f.store.state.resources);
    const inspect = ComputerDocker.prototype.inspect;
    let gatewayInspects = 0;
    vi.spyOn(ComputerDocker.prototype, "inspect").mockImplementation(async function (
      this: ComputerDocker,
      resource
    ) {
      const result = await inspect.call(this, resource);
      if (resource.role === "gateway" && ++gatewayInspects === 2) f.store.latchStop();
      return result;
    });
    expect((await f.client.request(binding(), "disable", 1)).reason).toBe("runtime-unavailable");
    expect(mutations(f)).toEqual([]);
    expect(f.store.state.resources).toEqual(before);
  });

  it("actual CLI inspects/stops only the fixture after clean lock release and leaves no owned lock", async () => {
    const f = await running();
    expect((await invoke(f, "inspect")).exit).toBe(1); // Live daemon lock is not stolen.
    await f.releaseControl();
    const inspect = await invoke(f, "inspect");
    expect(inspect).toEqual({
      exit: 0,
      stderr: "",
      stdout: '{"operation":"inspect","terminal":false,"remainingResources":2}\n'
    });
    expect(mutations(f)).toEqual([]);
    const stop = await invoke(f, "stop");
    expect(stop).toEqual({
      exit: 0,
      stderr: "",
      stdout: '{"operation":"stop","terminal":true,"remainingResources":0}\n'
    });
    expect(f.containers.size).toBe(0);
    expect(await fs.readdir(f.config.stateDir)).not.toContain("daemon.lock");
    const invalid = await invoke(f, "enable");
    expect(invalid).toEqual({
      exit: 1,
      stdout: "",
      stderr: "Computer terminal reconciliation unavailable\n"
    });
    expect((await invoke(f, "stop", ["extra"])).exit).toBe(1);
  });
});
