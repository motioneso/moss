import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as syncFs from "node:fs";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { build } from "esbuild";
import { captureFixture } from "./computer-capture-fixture.js";
import {
  parseSupervisorConfiguration,
  loadSupervisorDeployment,
  sha256
} from "../../scripts/computer-watchdog/trust.js";
import { ProvisionPublication } from "../../scripts/computer-provision/publication.js";
import * as capture from "../../scripts/computer-capture/run.js";
import { superviseDeployment } from "../../scripts/computer-watchdog/supervisor.js";

vi.mock("node:fs", async (original) => ({ ...(await original<typeof syncFs>()) }));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
});
const fixture = () => captureFixture((close) => cleanups.push(close));

describe("capture trust and native managed composition; disclosed OS projections", () => {
  it("pure PREPARE parsing preserves capture template while live loader refuses missing lifetime", async () => {
    const f = await fixture();
    const { lifetime: _lifetime, ...template } = f.config;
    expect(parseSupervisorConfiguration(template).capture).toEqual(f.config.capture);
    await fs.writeFile(f.configPath, JSON.stringify(template));
    await expect(
      loadSupervisorDeployment(f.configPath, f.deployment.artifactPath, true)
    ).rejects.toThrow();
  });
  it.each(["overlap", "ancestor", "mode", "foreign-owner", "artifact-inside"])(
    "refuses capture root %s",
    async (key) => {
      const f = await fixture();
      if (key === "overlap") f.config.capture = f.config.monitor;
      if (key === "ancestor") f.config.capture.path = f.root;
      if (key === "mode") {
        await fs.chmod(f.capture, 0o750);
        f.config.capture.mode = (await fs.lstat(f.capture)).mode;
      }
      if (key === "foreign-owner") f.config.capture.uid = 123;
      if (key === "artifact-inside") {
        f.config.capture.path = f.configuration.output.path;
        Object.assign(f.config.capture, await fs.lstat(f.configuration.output.path));
        // Keep a closed root shape.
        const { path, dev, ino, uid, gid, mode } = f.config.capture;
        f.config.capture = { path, dev, ino, uid, gid, mode };
      }
      await fs.writeFile(f.configPath, JSON.stringify(f.config));
      await expect(
        loadSupervisorDeployment(f.configPath, f.deployment.artifactPath, true)
      ).rejects.toThrow();
    }
  );
  it("rejects equality after final publication close and synchronous stop probe", async () => {
    const f = await fixture();
    const stat = syncFs.lstatSync;
    let injected = false;
    vi.spyOn(syncFs, "lstatSync").mockImplementation(
      (...args: Parameters<typeof syncFs.lstatSync>) => {
        try {
          return stat(...args);
        } finally {
          if (String(args[0]) === join(f.host.stateDir, "stop.json")) {
            injected = true;
            f.setNow(f.startedAtMs + 5000);
          }
        }
      }
    );
    await expect(f.run()).rejects.toThrow();
    expect(injected).toBe(true);
    expect(await fs.lstat(join(f.capture, "capture.json"))).toBeDefined();
    expect(await f.store.ownedLock()).toBeDefined();
  });
  it("refuses capture publication beyond64KiB before writing output", async () => {
    const f = await fixture();
    await expect(
      ProvisionPublication.create(
        f.config.capture,
        "capture.json",
        { oversize: "x".repeat(65536) },
        0o600,
        f.config.capture.gid,
        async () => {},
        () => {}
      )
    ).rejects.toThrow();
    expect(await fs.readdir(f.capture)).toEqual([]);
  });
  it("existing journal append refuses start-only provenance", async () => {
    const f = await fixture();
    await f.journal.collector(f.gateway);
    await expect(f.run()).rejects.toThrow();
    expect(await fs.readdir(f.capture)).toEqual([]);
  });
  it("unmanaged supervisor refuses capture without acquiring a second lock", async () => {
    const f = await fixture();
    await f.journal.close();
    await fs.unlink(join(f.config.monitor.path, "observation.jsonl")); // Remove only our synthetic setup journal.
    await expect(
      superviseDeployment(f.deployment, f.startedAtMs, f.watchdog, () => {
        throw new Error("unexpected start");
      })
    ).rejects.toThrow();
    expect(await f.store.ownedLock()).toBeDefined();
    expect(await fs.readdir(f.capture)).toEqual([]);
  });
  it("refuses bootstrap equality in actual capture's awaited continuation before driver/start acknowledgement", async () => {
    const f = await fixture();
    await f.journal.close();
    await fs.unlink(join(f.config.monitor.path, "observation.jsonl"));
    const actual = capture.captureManagedProcesses;
    vi.spyOn(capture, "captureManagedProcesses").mockImplementation(async (...args) => {
      await actual(...args);
      f.setNow(f.startedAtMs + 5000);
    });
    const started = vi.fn();
    await expect(
      superviseDeployment(f.deployment, f.startedAtMs, f.watchdog, started, undefined, f.store)
    ).rejects.toThrow();
    expect(started).not.toHaveBeenCalled();
    expect(await f.store.ownedLock()).toBeDefined();
  });
  it.each([
    "file",
    "directory",
    "continue",
    "boundary",
    "sample-file",
    "sample-directory",
    "collection",
    "collection-signal"
  ])(
    "native manage retains lock/output with %s bootstrap fixture",
    async (held) => {
      const f = await fixture();
      await f.journal.close();
      await f.store.close();
      await fs.unlink(join(f.config.monitor.path, "observation.jsonl"));
      const artifact = join(f.root, "input/native-watchdog.cjs");
      await build({
        entryPoints: ["scripts/computer-watchdog.ts"],
        bundle: true,
        platform: "node",
        target: "node24",
        format: "cjs",
        outfile: artifact
      });
      f.config.artifactSha256 = sha256(await fs.readFile(artifact));
      await fs.writeFile(f.configPath, JSON.stringify(f.config));
      for (const container of f.containers) {
        const directory = join(f.config.dockerData.path, "containers", container.Id);
        await fs.mkdir(directory, { recursive: true });
        const LogPath = join(directory, `${container.Id}-json.log`);
        await fs.writeFile(LogPath, "", { mode: 0o600 });
        Object.assign(container, { LogPath });
      }
      const readySocket = join(f.root, "input/ready.sock");
      const ready = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, db: "ok", pgboss: "ok" }));
      });
      cleanups.push(async () => {
        ready.closeAllConnections();
        await new Promise<void>((resolve) => ready.close(() => resolve()));
      });
      await new Promise<void>((resolve) => ready.listen(readySocket, resolve));
      const meminfo = join(f.root, "input/meminfo");
      const collectionMarker = join(f.root, "input/collection-held");
      await fs.writeFile(meminfo, "MemAvailable: 16777216 kB\n");
      const membershipFiles: Record<string, string> = {};
      for (const [pid, path] of f.membership) {
        const file = join(f.root, `input/cgroup-${pid}`);
        await fs.writeFile(file, `0::${path}\n`);
        membershipFiles[String(pid)] = file;
      }
      const hostGroup = join(f.root, "input/cgroup-host");
      await fs.writeFile(hostGroup, "0::/host.slice\n");
      await fs.writeFile(
        join(f.configuration.output.path, "capture-os.json"),
        JSON.stringify({
          readySocket,
          meminfo,
          collectionMarker,
          cgRoot: f.cgRoot,
          membershipFiles,
          hostGroup,
          artifact,
          uidMap: join(f.root, "input/uid-map"),
          ownInfo: join(f.root, "input/own-info"),
          heartbeatInfo: join(f.root, "input/heartbeat-info"),
          namespaces: {
            net: await fs.readlink("/proc/self/ns/net"),
            cgroup: await fs.readlink("/proc/self/ns/cgroup")
          }
        })
      );
      const wrapper = join(f.root, "input/capture-preload.cjs");
      await build({
        entryPoints: ["tests/unit/computer-bootstrap-native-fixture.ts"],
        bundle: true,
        platform: "node",
        format: "cjs",
        outfile: wrapper
      });
      const child = spawn(
        process.execPath,
        [
          "-e",
          "require(process.argv[1]).prepareNativeBootstrap(process.argv[2],process.argv[3],process.argv[1]).then(()=>{const artifact=process.argv[4];process.argv=[process.execPath,artifact, 'manage',process.argv[2]];require(artifact)})",
          wrapper,
          f.configPath,
          held,
          artifact
        ],
        { stdio: ["pipe", "pipe", "pipe", "ipc"], detached: true, env: {} }
      );
      const exited = once(child, "exit");
      let stdout = "",
        stderr = "";
      child.stdout!.on("data", (b) => {
        stdout += b;
      });
      child.stderr!.on("data", (b) => {
        stderr += b;
      });
      cleanups.push(async () => {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, "exit");
          child.kill("SIGKILL");
          await exited;
        }
      });
      const messages: {
        type: string;
        timerStartedAtNs?: string;
        heldAtNs?: string;
        sampleWritten?: boolean;
        fileSynced?: boolean;
        directorySynced?: boolean;
      }[] = [];
      child.on("message", (m) => messages.push(m as (typeof messages)[number]));
      const safety = setTimeout(() => child.kill("SIGKILL"), 8000);
      const startedAtNs = process.hrtime.bigint();
      try {
        await expect
          .poll(
            () =>
              (
                held.startsWith("collection")
                  ? syncFs.existsSync(collectionMarker)
                  : messages.some((m) => ["held", "continued", "boundary"].includes(m.type))
              )
                ? "held"
                : child.exitCode !== null
                  ? `exit${child.exitCode}:${stderr}`
                  : "pending",
            { timeout: 4500 }
          )
          .toBe("held");
        // Separate bootstrap expiry from a later terminal-finalization timer in sensitivity runs.
        if (["file", "directory", "sample-file", "sample-directory"].includes(held))
          await new Promise<void>((resolve) => setTimeout(resolve, 1800));
        if (!["boundary", "collection"].includes(held)) child.kill("SIGTERM");
        const signal = !["boundary", "collection"].includes(held)
          ? setInterval(() => child.kill("SIGINT"), 300)
          : undefined;
        const [code, nativeSignal] = await exited;
        clearInterval(signal);
        const finishedAtNs = process.hrtime.bigint();
        const elapsedMs =
          Number(
            finishedAtNs -
              BigInt(messages.find((m) => m.timerStartedAtNs)?.timerStartedAtNs ?? startedAtNs)
          ) / 1e6;
        expect(code).toBe(2);
        expect(nativeSignal).toBe(null);
        expect(stdout).toBe("");
        expect(stderr).toBe("");
        if (["file", "directory", "sample-file", "sample-directory", "collection"].includes(held))
          expect(elapsedMs).toBeGreaterThanOrEqual(4900);
        if (!held.startsWith("collection"))
          expect(messages.find((m) => !["durable", "bootstrap"].includes(m.type))?.type).toBe(
            held === "continue" ? "continued" : held === "boundary" ? "boundary" : "held"
          );
        if (held !== "continue") {
          expect(messages.some((m) => m.type === "continued")).toBe(false);
          expect(messages.some((m) => m.type === "durable")).toBe(false);
        }
        if (held === "boundary") expect(messages.some((m) => m.type === "continued")).toBe(false);
        if (held === "continue") {
          expect(messages.find((m) => m.type === "durable")).toMatchObject({
            sampleWritten: true,
            fileSynced: true,
            directorySynced: true
          });
          const records = (
            await fs.readFile(join(f.config.monitor.path, "observation.jsonl"), "utf8")
          )
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
          expect(records.map((r) => r.type)).toEqual(["start", "collector", "sample", "stop"]);
          expect(records[2].sample).toMatchObject({
            mossHealthy: true,
            logsBounded: true,
            stopRequested: false
          });
          const receipt = JSON.parse(await fs.readFile(join(f.capture, "capture.json"), "utf8"));
          expect(receipt.watchdog.pid).toBe(child.pid);
          expect(receipt.coverage).toBe("sampled-cgroup-v2");
        }
        expect(elapsedMs).toBeLessThan(6800);
        expect(await fs.lstat(join(f.host.stateDir, "daemon.lock"))).toBeDefined();
        expect(await fs.lstat(join(f.capture, "capture.json"))).toBeDefined();
        expect(f.calls.every((c) => c.method === "GET")).toBe(true);
        const evidence = process.env.COMPUTER_CAPTURE_NATIVE_EVIDENCE;
        if (evidence)
          await fs.writeFile(
            join(resolve(evidence), `native-${held}.json`),
            JSON.stringify({
              fixture:
                "OS root/runtime/namespace/cgroup/heartbeat/Node provenance projections; Unix Docker; actual managed CJS and real native timer/persistence",
              artifactSha256: f.config.artifactSha256,
              startedAtNs: startedAtNs.toString(),
              finishedAtNs: finishedAtNs.toString(),
              held: messages[0],
              messages,
              elapsedMs,
              code,
              signal: nativeSignal,
              stdout,
              stderr,
              pid: child.pid,
              node: process.version,
              nativeUid: f.nativeUid,
              nativeGid: f.nativeGid
            })
          );
      } finally {
        clearTimeout(safety);
      }
    },
    15000
  );
  it("actual production native CJS refuses nonroot silently", async () => {
    const f = await fixture();
    const artifact = join(f.root, "input/bare-watchdog.cjs");
    await build({
      entryPoints: ["scripts/computer-watchdog.ts"],
      bundle: true,
      platform: "node",
      target: "node24",
      format: "cjs",
      outfile: artifact
    });
    const reply = spawnSync(process.execPath, [artifact, "manage", f.configPath], {
      env: {},
      encoding: "utf8",
      timeout: 8000
    });
    expect(reply.status).toBe(2);
    expect(reply.signal).toBe(null);
    expect(reply.stdout).toBe("");
    expect(reply.stderr).toBe("");
  });
});
