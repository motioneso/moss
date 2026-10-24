import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as syncFs from "node:fs";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { build } from "esbuild";
import { captureFixture } from "./computer-capture-fixture.js";
import {
  parseSupervisorConfiguration,
  loadSupervisorDeployment,
  sha256
} from "../../scripts/computer-watchdog/trust.js";
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
  it.each(["file", "directory"])(
    "native manage retains lock/output at absolute original5s bootstrap bound with held %s persistence and repeated signals",
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
        entryPoints: ["tests/unit/computer-capture-native-fixture.ts"],
        bundle: true,
        platform: "node",
        format: "cjs",
        outfile: wrapper
      });
      const child = spawn(
        process.execPath,
        [
          "-e",
          "require(process.argv[1]).prepareNativeCapture(process.argv[2],process.argv[3]).then(()=>{const artifact=process.argv[4];process.argv=[process.execPath,artifact, 'manage',process.argv[2]];require(artifact)})",
          wrapper,
          f.configPath,
          held,
          artifact
        ],
        { stdio: ["pipe", "pipe", "pipe", "ipc"], detached: true, env: {} }
      );
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (b) => {
        stdout += b;
      });
      child.stderr.on("data", (b) => {
        stderr += b;
      });
      cleanups.push(async () => {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, "exit");
          child.kill("SIGKILL");
          await exited;
        }
      });
      const messages: { type: string; timerStartedAtNs: string; heldAtNs: string }[] = [];
      child.on("message", (m) => messages.push(m as (typeof messages)[number]));
      const safety = setTimeout(() => child.kill("SIGKILL"), 8000);
      const startedAtNs = process.hrtime.bigint();
      try {
        await expect
          .poll(
            () =>
              messages.length
                ? "held"
                : child.exitCode !== null
                  ? `exit${child.exitCode}:${stderr}`
                  : "pending",
            { timeout: 4500 }
          )
          .toBe("held");
        child.kill("SIGTERM");
        const signal = setInterval(() => child.kill("SIGINT"), 300);
        const [code, nativeSignal] = await once(child, "exit");
        clearInterval(signal);
        const finishedAtNs = process.hrtime.bigint();
        const elapsedMs = Number(finishedAtNs - BigInt(messages[0]!.timerStartedAtNs)) / 1e6;
        expect(code).toBe(2);
        expect(nativeSignal).toBe(null);
        expect(stdout).toBe("");
        expect(stderr).toBe("");
        expect(elapsedMs).toBeGreaterThanOrEqual(4900);
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
