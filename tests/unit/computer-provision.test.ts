import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { build } from "esbuild";
import { provisionFixture } from "./computer-provision-fixture.js";
import { readComputerGatewayConfig } from "../../scripts/computer-gateway/config.js";
import {
  loadProvisionDeployment,
  parseProvisionConfiguration
} from "../../scripts/computer-provision/config.js";
import { loadSupervisorDeployment } from "../../scripts/computer-watchdog/trust.js";
import { HostStateStore } from "../../scripts/computer-host/state.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
async function fixture() {
  const f = await provisionFixture();
  cleanups.push(() => f.close());
  return f;
}
const exists = async (path: string) =>
  fs.lstat(path).then(
    () => true,
    (e: NodeJS.ErrnoException) => {
      if (e.code !== "ENOENT") throw e;
      return false;
    }
  );
function afterPublication(
  f: Awaited<ReturnType<typeof fixture>>,
  name: string,
  action: () => Promise<void>
) {
  const open = vi.mocked(f.io.open).getMockImplementation()!;
  let invoked = false;
  vi.spyOn(f.io, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (String(args[0]).endsWith(`/${name}`) && Number(args[1]) & 0o100) {
      const sync = file.sync.bind(file);
      vi.spyOn(file, "sync").mockImplementation(async () => {
        await sync();
        if (!invoked) {
          invoked = true;
          await action();
        }
      });
    }
    return file;
  });
}
describe("actual stopped-pair config publisher; disclosed root/runtime/namespace/Node/Docker fixtures", () => {
  it("durably delivers identical lifetime to actual root and gateway consumers without state mutation", async () => {
    const f = await fixture();
    const state = await fs.readFile(join(f.host.stateDir, "state.json"));
    expect(await f.run()).toBe(0);
    const root = await loadSupervisorDeployment(
      join(f.configuration.output.path, "supervisor.json"),
      f.configuration.supervisorArtifactPath,
      true
    );
    const gateway = await readComputerGatewayConfig(join(f.host.gatewayConfigDir, "gateway.json"));
    expect(gateway.lifetime).toEqual(root.configuration.lifetime);
    expect(gateway.lifetime.binding.desktopId).toBe(f.resources[1]!.id);
    expect(gateway.lifetime.binding.gatewayId).toBe(f.resources[0]!.id);
    expect(gateway.authSocketPath).toBe("/auth/auth.sock");
    const receipt = await fs.readFile(join(f.configuration.output.path, "prepared.json"), "utf8");
    expect(receipt).not.toContain(gateway.lifetime.secret);
    expect(await fs.readFile(join(f.host.stateDir, "state.json"))).toEqual(state);
    expect(f.calls.every((c) => c.method === "GET")).toBe(true);
    expect(await exists(join(f.host.stateDir, "daemon.lock"))).toBe(false);
    expect((await fs.lstat(join(f.host.gatewayConfigDir, "gateway.json"))).mode & 0o7777).toBe(
      0o640
    );
    // Exclusive prior output refusal keeps all original bytes and the failed attempt's lock.
    expect(await f.run()).toBe(2);
    expect(await fs.readFile(join(f.configuration.output.path, "prepared.json"), "utf8")).toBe(
      receipt
    );
    expect(await exists(join(f.host.stateDir, "daemon.lock"))).toBe(true);
  });
  it.each([
    "running",
    "stopped-prior",
    "pid",
    "started",
    "partial",
    "foreign",
    "pending",
    "disabled"
  ])("refuses %s pair before publication and retains lock", async (mode) => {
    const f = await fixture();
    if (mode === "running") f.containers[0]!.State.Running = true;
    if (mode === "stopped-prior") f.containers[0]!.State.Status = "exited";
    if (mode === "pid") f.containers[0]!.State.Pid = 42;
    if (mode === "started") f.containers[0]!.State.StartedAt = "2026-10-24T00:00:00Z";
    if (mode === "partial") f.containers.pop();
    if (mode === "foreign") f.containers[0]!.Name = "/foreign";
    if (mode === "pending" || mode === "disabled") {
      const path = join(f.host.stateDir, "state.json");
      const state = JSON.parse(await fs.readFile(path, "utf8"));
      if (mode === "pending") state.resources[0].id = null;
      else state.enabled = false;
      await fs.writeFile(path, JSON.stringify(state));
    }
    expect(await f.run()).toBe(2);
    expect(await fs.readdir(f.configuration.output.path)).toEqual([]);
    expect(await exists(join(f.host.stateDir, "daemon.lock"))).toBe(true);
    expect(f.calls.every((c) => c.method === "GET")).toBe(true);
  });
  it("refuses stop arrival after actual file fsync, retaining partial config and lock", async () => {
    const f = await fixture();
    const open = vi.mocked(f.io.open).getMockImplementation()!;
    vi.spyOn(f.io, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const file = await open(...args);
      if (
        String(args[0]).endsWith("/supervisor.json") &&
        args[1] !== undefined &&
        (Number(args[1]) & 0o100) !== 0
      ) {
        const sync = file.sync.bind(file);
        vi.spyOn(file, "sync").mockImplementation(async () => {
          await sync();
          await fs.writeFile(join(f.host.stateDir, "stop.json"), "{}", { mode: 0o600 });
        });
      }
      return file;
    });
    expect(await f.run()).toBe(2);
    expect(await exists(join(f.configuration.output.path, "supervisor.json"))).toBe(true);
    expect(await exists(join(f.host.gatewayConfigDir, "gateway.json"))).toBe(false);
    expect(await exists(join(f.host.stateDir, "daemon.lock"))).toBe(true);
  });
  it.each(["file", "directory", "close"])(
    "failed publication %s retains output and lock",
    async (mode) => {
      const f = await fixture();
      const open = vi.mocked(f.io.open).getMockImplementation()!;
      vi.spyOn(f.io, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const file = await open(...args);
        const path = String(args[0]);
        if (path.endsWith("/supervisor.json") && mode !== "directory") {
          if (mode === "file")
            vi.spyOn(file, "sync").mockRejectedValue(new Error("fixture fsync failure"));
          else {
            const close = file.close.bind(file);
            vi.spyOn(file, "close").mockImplementationOnce(async () => {
              await close();
              throw new Error("fixture close failure");
            });
          }
        }
        if (mode === "directory" && path === f.configuration.output.path)
          vi.spyOn(file, "sync").mockRejectedValue(new Error("fixture directory fsync failure"));
        return file;
      });
      expect(await f.run()).toBe(2);
      expect(await exists(join(f.configuration.output.path, "supervisor.json"))).toBe(true);
      expect(await exists(join(f.configuration.output.path, "prepared.json"))).toBe(false);
      expect(await exists(join(f.host.stateDir, "daemon.lock"))).toBe(true);
    }
  );
  it.each(["equality", "signal"])(
    "%s after actual final directory fsync cannot release the lock",
    async (mode) => {
      const f = await fixture();
      const open = vi.mocked(f.io.open).getMockImplementation()!;
      let receipt = false;
      vi.spyOn(f.io, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const file = await open(...args);
        const path = String(args[0]);
        if (path.endsWith("/prepared.json")) receipt = true;
        if (path === f.configuration.output.path) {
          const sync = file.sync.bind(file);
          vi.spyOn(file, "sync").mockImplementation(async () => {
            await sync();
            if (receipt) {
              if (mode === "equality") f.setNow(60_000);
              else f.interrupt();
            }
          });
        }
        return file;
      });
      expect(await f.run()).toBe(2);
      expect(await exists(join(f.configuration.output.path, "prepared.json"))).toBe(true);
      expect(await exists(join(f.host.stateDir, "daemon.lock"))).toBe(true);
    }
  );
  it("same-byte state replacement after publication refuses completion", async () => {
    const f = await fixture();
    const open = vi.mocked(f.io.open).getMockImplementation()!;
    vi.spyOn(f.io, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const file = await open(...args);
      if (String(args[0]).endsWith("/supervisor.json") && (Number(args[1]) & 0o100) !== 0) {
        const sync = file.sync.bind(file);
        vi.spyOn(file, "sync").mockImplementation(async () => {
          await sync();
          const path = join(f.host.stateDir, "state.json");
          const bytes = await fs.readFile(path);
          await fs.rename(path, `${path}.retained`);
          await fs.writeFile(path, bytes, { mode: 0o600 });
        });
      }
      return file;
    });
    expect(await f.run()).toBe(2);
    expect(await exists(join(f.configuration.output.path, "prepared.json"))).toBe(false);
  });
  it("refuses root/output/artifact/input/namespace and pre-supplied lifetime ambiguity", async () => {
    const f = await fixture();
    expect(() =>
      parseProvisionConfiguration({
        ...f.configuration,
        supervisor: { ...f.configuration.supervisor, lifetime: {} }
      })
    ).toThrow();
    await fs.writeFile(f.artifact, "changed");
    await expect(loadProvisionDeployment(f.path, f.artifact)).rejects.toThrow();
    expect(await f.run()).toBe(2);
    expect(await exists(join(f.host.stateDir, "daemon.lock"))).toBe(false);
  });
  it("canonical close failure guard retains exact lock and allows no postrelease asynchronous work", async () => {
    const f = await fixture();
    const store = await HostStateStore.openExisting(f.host);
    await expect(
      store.close({
        check: async () => {
          throw new Error("fixture final check");
        },
        assertCurrent: () => {}
      })
    ).rejects.toThrow();
    expect(await exists(join(f.host.stateDir, "daemon.lock"))).toBe(true);
  });
  it.each(["marker", "state", "missing"])("retains failed-open lock for %s", async (mode) => {
    const f = await fixture();
    const path = join(f.host.stateDir, mode === "marker" ? "identity.json" : "state.json");
    if (mode === "missing") await fs.unlink(path);
    else await fs.writeFile(path, "{}");
    expect(await f.run()).toBe(2);
    expect(await exists(join(f.host.stateDir, "daemon.lock"))).toBe(true);
    expect(await fs.readdir(f.configuration.output.path)).toEqual([]);
  });
  it("never steals a pre-existing lifecycle lock", async () => {
    const f = await fixture();
    const path = join(f.host.stateDir, "daemon.lock");
    await fs.writeFile(path, "existing lock", { mode: 0o600 });
    expect(await f.run()).toBe(2);
    expect(await fs.readFile(path, "utf8")).toBe("existing lock");
  });
  it.each([
    "gateway-mode",
    "gateway-owner",
    "namespace",
    "output-overlap",
    "output-mode",
    "input-inode"
  ])("rejects changed deployment %s before acquisition", async (mode) => {
    const f = await fixture();
    if (mode === "gateway-mode") await fs.chmod(f.host.gatewayConfigDir, 0o700);
    if (mode === "gateway-owner") {
      const stat = vi.mocked(f.io.lstat).getMockImplementation()!;
      vi.spyOn(f.io, "lstat").mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
        const value = await stat(...args);
        if (String(args[0]) === f.host.gatewayConfigDir) value.uid = 123;
        return value;
      });
    }
    if (mode === "namespace") {
      f.configuration.supervisor.namespaces.pid = "pid:[123]";
      await f.save();
    }
    if (mode === "output-overlap") {
      f.configuration.output.path = f.host.stateDir;
      await f.save();
    }
    if (mode === "output-mode") await fs.chmod(f.configuration.output.path, 0o750);
    if (mode === "input-inode") {
      const bytes = await fs.readFile(f.path);
      await fs.rename(f.path, f.path + ".retained");
      await fs.writeFile(f.path, bytes, { mode: 0o600 });
    }
    if (mode !== "input-inode")
      await expect(loadProvisionDeployment(f.path, f.artifact)).rejects.toThrow();
    expect(await f.run()).toBe(2);
    expect(await exists(join(f.host.stateDir, "daemon.lock"))).toBe(false);
  });
  it.each(["root-mode", "output-inode", "gateway-bytes", "supervisor-inode", "artifact", "input"])(
    "retains partial publications and lock after %s changes",
    async (mode) => {
      const f = await fixture();
      afterPublication(f, "prepared.json", async () => {
        if (mode === "root-mode") await fs.chmod(f.configuration.output.path, 0o750);
        if (mode === "output-inode") {
          await fs.rename(f.configuration.output.path, f.configuration.output.path + ".retained");
          await fs.mkdir(f.configuration.output.path, { mode: 0o700 });
        }
        if (mode === "gateway-bytes")
          await fs.writeFile(join(f.host.gatewayConfigDir, "gateway.json"), "{}");
        if (mode === "supervisor-inode") {
          const path = join(f.configuration.output.path, "supervisor.json");
          const bytes = await fs.readFile(path);
          await fs.rename(path, path + ".retained");
          await fs.writeFile(path, bytes, { mode: 0o600 });
        }
        if (mode === "artifact") await fs.writeFile(f.artifact, "changed");
        if (mode === "input") await fs.writeFile(f.path, "{}");
      });
      expect(await f.run()).toBe(2);
      expect(await exists(join(f.host.stateDir, "daemon.lock"))).toBe(true);
    }
  );
  it.each(["stop", "equality"])("refuses %s arriving in final lock lstat", async (mode) => {
    const f = await fixture();
    const stat = vi.mocked(f.io.lstat).getMockImplementation()!;
    let injected = false;
    vi.spyOn(f.io, "lstat").mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
      const value = await stat(...args);
      if (
        String(args[0]) === join(f.host.stateDir, "daemon.lock") &&
        (await exists(join(f.configuration.output.path, "prepared.json")))
      ) {
        injected = true;
        if (mode === "stop")
          await fs.writeFile(join(f.host.stateDir, "stop.json"), "{}", { mode: 0o600 });
        else f.setNow(60000);
      }
      return value;
    });
    expect(await f.run()).toBe(2);
    expect(injected).toBe(true);
    expect(await exists(join(f.host.stateDir, "daemon.lock"))).toBe(true);
  });
  it("failed canonical lock descriptor close cannot authorize release", async () => {
    const f = await fixture();
    const open = vi.mocked(f.io.open).getMockImplementation()!;
    let injected = false;
    vi.spyOn(f.io, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const file = await open(...args);
      if (String(args[0]).endsWith("/daemon.lock"))
        vi.spyOn(file, "close").mockImplementationOnce(async () => {
          injected = true;
          throw new Error("fixture close failure");
        });
      return file;
    });
    expect(await f.run()).toBe(2);
    expect(injected).toBe(true);
    expect(await exists(join(f.configuration.output.path, "prepared.json"))).toBe(true);
    expect(await exists(join(f.host.stateDir, "daemon.lock"))).toBe(true);
  });
  it.each(["mode", "hardlink", "symlink", "ancestor"])(
    "root-delivered gateway consumer rejects unsafe %s",
    async (mode) => {
      const f = await fixture();
      expect(await f.run()).toBe(0);
      const path = join(f.host.gatewayConfigDir, "gateway.json");
      if (mode === "mode") await fs.chmod(path, 0o4600);
      if (mode === "hardlink") await fs.link(path, path + ".link");
      if (mode === "symlink") {
        await fs.rename(path, path + ".retained");
        await fs.symlink(path + ".retained", path);
      }
      if (mode === "ancestor") {
        const stat = vi.mocked(f.io.lstat).getMockImplementation()!;
        vi.spyOn(f.io, "lstat").mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
          const value = await stat(...args);
          if (String(args[0]) === f.root) value.uid = 123;
          return value;
        });
      }
      await expect(readComputerGatewayConfig(path)).rejects.toThrow();
    }
  );
  it.each(["success", "file", "directory"])(
    "native production CJS with disclosed OS trust fixtures: %s",
    async (kind) => {
      const f = await fixture();
      const bundle = join(f.root, "input/native.cjs");
      const preload = join(f.root, "input/preload.cjs");
      for (const [entry, outfile] of [
        ["scripts/computer-provision.ts", bundle],
        ["tests/unit/computer-provision-native-fixture.ts", preload]
      ])
        await build({
          entryPoints: [entry!],
          outfile,
          bundle: true,
          platform: "node",
          target: "node24",
          format: "cjs",
          logLevel: "silent"
        });
      f.configuration.artifactSha256 = (await import("node:crypto"))
        .createHash("sha256")
        .update(await fs.readFile(bundle))
        .digest("hex");
      await f.save();
      const code = `require(${JSON.stringify(preload)}).prepareNativeFixture(process.argv[2],${JSON.stringify(kind === "success" ? undefined : kind)}) .then(()=>require(process.argv[1]));`;
      const startedAtNs = process.hrtime.bigint();
      const child = spawn(process.execPath, ["-e", code, bundle, f.path], {
        stdio: ["ignore", "pipe", "pipe", "ipc"]
      });
      cleanups.push(async () => {
        if (child.exitCode === null) child.kill("SIGKILL");
      });
      let output = "";
      child.stdout!.on("data", (data) => {
        output += String(data);
      });
      child.stderr!.on("data", (data) => {
        output += String(data);
      });
      const exited = once(child, "exit");
      const safety = setTimeout(() => child.kill("SIGKILL"), kind === "success" ? 10000 : 3000);
      void exited.finally(() => clearTimeout(safety));
      if (kind !== "success") {
        const message = await Promise.race([once(child, "message"), exited]);
        expect(message[0]).toBe("held");
        child.kill("SIGTERM");
        child.kill("SIGINT");
        child.kill("SIGTERM");
      }
      const [exit, signal] = await exited;
      expect(exit).toBe(kind === "success" ? 0 : 2);
      expect(signal).toBeNull();
      expect(output).toBe("");
      expect(await exists(join(f.host.stateDir, "daemon.lock"))).toBe(kind !== "success");
      expect(await exists(join(f.configuration.output.path, "prepared.json"))).toBe(
        kind === "success"
      );
      if (kind === "success") {
        const root = await loadSupervisorDeployment(
          join(f.configuration.output.path, "supervisor.json"),
          f.configuration.supervisorArtifactPath,
          true
        );
        const gateway = await readComputerGatewayConfig(
          join(f.host.gatewayConfigDir, "gateway.json")
        );
        expect(gateway.lifetime).toEqual(root.configuration.lifetime);
      }
      const capture = process.env.COMPUTER_PROVISION_TEST_RECEIPTS;
      if (capture) {
        await fs.mkdir(capture, { recursive: true });
        await fs.writeFile(
          join(capture, `native-${kind}.json`),
          JSON.stringify({
            fixture:
              "OS ownership/runtime/namespace/Node hash and Unix Docker fixtures; no installed trust",
            startedAtNs: startedAtNs.toString(),
            finishedAtNs: process.hrtime.bigint().toString(),
            pid: child.pid,
            exit,
            signal,
            output,
            node: process.version,
            artifactSha256: f.configuration.artifactSha256,
            scaledDeadlineMs: kind === "success" ? null : 1000
          })
        );
        await fs.copyFile(bundle, join(capture, "provision.cjs"));
      }
    }
  );
  it("actual builtin-only CJS refuses nonroot silently", async () => {
    // Uses original native process UID, not the fixture projection above.
    const directory = await fs.mkdtemp("/tmp/computer-provision-refusal-");
    cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
    const path = join(directory, "provision.cjs");
    const result = await build({
      entryPoints: ["scripts/computer-provision.ts"],
      outfile: path,
      bundle: true,
      platform: "node",
      target: "node24",
      format: "cjs",
      metafile: true,
      logLevel: "silent"
    });
    expect(
      Object.values(result.metafile!.outputs).every((output) =>
        output.imports.every((i) => i.external && i.path.startsWith("node:"))
      )
    ).toBe(true);
    const child = spawnSync(process.execPath, [path, join(directory, "missing.json")], {
      encoding: "utf8",
      timeout: 2000
    });
    expect(child.status).toBe(2);
    expect(child.stdout).toBe("");
    expect(child.stderr).toBe("");
  });
});
