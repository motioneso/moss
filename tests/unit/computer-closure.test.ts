import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { build } from "esbuild";
import { createHash, createPublicKey, verify } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { hostJsonRequest } from "../../apps/api/src/computer/host-http.js";
import { verifyComputerClosure } from "../../scripts/computer-closure/run.js";
import { closureFile, recheckClosureFile } from "../../scripts/computer-closure/files.js";
import { closureCollectors, readClosureRecords } from "../../scripts/computer-closure/records.js";
import {
  assertProcessesAbsent,
  inspectClosureEndpoints
} from "../../scripts/computer-closure/observe.js";
import { parseClosureConfiguration } from "../../scripts/computer-closure/config.js";
import { processIdentity } from "../../scripts/computer-watchdog/trust.js";
import { ComputerDocker } from "../../scripts/computer-host/docker.js";
import { resourceName, resourceSpec } from "../../scripts/computer-host/spec.js";
import type { WatchdogProcessIdentity } from "../../scripts/computer-watchdog/policy.js";
import {
  closureFixture,
  closureStarted,
  deadClosureProcess,
  fixtureRevalidate
} from "./computer-closure-fixture.js";

vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof fs>()) }));
const cleanups: (() => Promise<unknown>)[] = [];
let identities: WatchdogProcessIdentity[];
let bundle: string;
let bundleDir: string;
let nativeReceipt = 0;
beforeAll(async () => {
  identities = [];
  for (let i = 0; i < 5; i++) identities.push(await deadClosureProcess());
  bundleDir = await fs.mkdtemp("/tmp/closure-native-");
  bundle = join(bundleDir, "verifier.cjs");
  await build({
    entryPoints: ["tests/unit/computer-closure-native-fixture.ts"],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24"
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
});
afterAll(async () => {
  await fs.rm(bundleDir, { recursive: true, force: true });
});
async function fixture() {
  const f = await closureFixture(identities);
  cleanups.push(() => f.close());
  return f;
}
async function native(f: Awaited<ReturnType<typeof fixture>>) {
  const startedAtNs = process.hrtime.bigint();
  const argv = [bundle, f.deployment.config.path, f.readySocket];
  const child = spawn(process.execPath, argv, {
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (b) => {
    output += String(b);
  });
  child.stderr.on("data", (b) => {
    output += String(b);
  });
  const [code] = await once(child, "close");
  const finishedAtNs = process.hrtime.bigint();
  const capture = process.env.COMPUTER_CLOSURE_TEST_RECEIPTS;
  if (capture) {
    await fs.mkdir(capture, { recursive: true });
    const name = `native-${++nativeReceipt}`;
    const receipt = await fs
      .readFile(join(f.deployment.configuration.receipt.path, "closure.jsonl"))
      .catch(() => Buffer.alloc(0));
    const artifact = await fs.readFile(bundle);
    const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
    await fs.writeFile(join(capture, name + ".jsonl"), receipt);
    await fs.writeFile(join(capture, "fixture.cjs"), artifact);
    await fs.writeFile(
      join(capture, name + ".public.der"),
      createPublicKey(f.deployment.signingKey).export({ type: "spki", format: "der" })
    );
    await fs.writeFile(
      join(capture, name + ".json"),
      JSON.stringify(
        {
          argv: [process.execPath, ...argv],
          pid: child.pid,
          uid: process.getuid!(),
          node: process.version,
          exit: code,
          startedAtNs: startedAtNs.toString(),
          finishedAtNs: finishedAtNs.toString(),
          outputBytes: Buffer.byteLength(output),
          outputSha256: hash(output),
          artifactSha256: hash(artifact),
          receiptSha256: hash(receipt)
        },
        null,
        2
      ) + "\n"
    );
  }
  expect(output).toBe("");
  return code;
}
async function run(
  f: Awaited<ReturnType<typeof fixture>>,
  options: Partial<Parameters<typeof verifyComputerClosure>[1]> = {}
) {
  return verifyComputerClosure(f.deployment, {
    startedAtMs: closureStarted(),
    interrupted: () => false,
    revalidate: fixtureRevalidate,
    ready: async () => {
      await hostJsonRequest({
        socketPath: f.readySocket,
        method: "GET",
        path: "/health/ready",
        limit: 4096,
        timeoutMs: 2000
      });
    },
    ...options
  });
}
async function lines(f: Awaited<ReturnType<typeof fixture>>) {
  return (await fs.readFile(join(f.deployment.configuration.receipt.path, "closure.jsonl"), "utf8"))
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
}

describe("independently executed closure, disclosed trusted-config/Unix readiness/Docker fixtures", () => {
  it("native child proves sampled closure twice and retains two verifiable signatures without touching the lock", async () => {
    const f = await fixture();
    const lock = join(f.host.config.stateDir, "daemon.lock");
    await fs.writeFile(lock, "retained crash lock", { mode: 0o600 });
    expect(await native(f)).toBe(0);
    const records = await lines(f);
    expect(records.map((r) => r.record.type)).toEqual(["attempt", "observed-closed"]);
    expect(records[0].record.observations).toEqual({
      files: null,
      collectors: null,
      endpointsSha256: null,
      lockPresent: null
    });
    expect(records[1].record.verifier.pid).not.toBe(process.pid);
    expect(records[1].record.observations.lockPresent).toBe(true);
    const publicKey = createPublicKey(f.deployment.signingKey);
    for (const record of records) {
      expect(
        verify(
          null,
          Buffer.from(JSON.stringify(record.record)),
          publicKey,
          Buffer.from(record.signature, "base64")
        )
      ).toBe(true);
      record.record.reason = "tampered";
      expect(
        verify(
          null,
          Buffer.from(JSON.stringify(record.record)),
          publicKey,
          Buffer.from(record.signature, "base64")
        )
      ).toBe(false);
    }
    expect(await fs.readFile(lock, "utf8")).toBe("retained crash lock");
    expect(f.host.calls).toHaveLength(6);
    expect(f.host.calls.every((call) => call.method === "GET")).toBe(true);
  });
  it("refuses an unknown raw collector PID instead of inventing its start/group identity", async () => {
    const f = await fixture();
    const records: unknown[] = [
      ...f.records.slice(0, 2),
      { type: "stop", atMs: 2, reason: "operator-stop", collector: null, collectorPid: 123 }
    ];
    await fs.writeFile(f.journalPath, records.map((r) => JSON.stringify(r) + "\n").join(""));
    expect(await native(f)).toBe(2);
    expect((await lines(f)).at(-1).record.type).toBe("failed");
  });
  it("refuses the hidden underlying Unix listener after its public alias is absent, without application bytes", async () => {
    const f = await fixture();
    let received = 0;
    const server = createServer((socket) => {
      socket.on("data", (b) => {
        received += b.length;
      });
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve) =>
      server.listen(join(f.host.config.gatewayDir, ".gateway-hidden.sock"), resolve)
    );
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    expect(await native(f)).toBe(2);
    expect(received).toBe(0);
  });
  it("accepts an actual inert stale guest socket without deleting it", async () => {
    const f = await fixture();
    const path = join(f.host.config.guestSocketDir, "viewer.sock");
    const child = spawn(
      process.execPath,
      [
        "-e",
        "require('net').createServer().listen(process.argv[1],()=>process.send('ready'))",
        path
      ],
      { stdio: ["ignore", "ignore", "ignore", "ipc"] }
    );
    await once(child, "message");
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    expect((await fs.lstat(path)).isSocket()).toBe(true);
    expect(await native(f)).toBe(0);
    expect((await fs.lstat(path)).isSocket()).toBe(true);
  });
  it("refuses unhealthy Moss in the distinct native composition", async () => {
    const f = await fixture();
    f.unhealthy();
    expect(await native(f)).toBe(2);
  });
  it("retains the first receipt and refuses exclusive-file overwrite", async () => {
    const f = await fixture();
    expect(await native(f)).toBe(0);
    const path = join(f.deployment.configuration.receipt.path, "closure.jsonl");
    const before = await fs.readFile(path);
    expect(await native(f)).toBe(2);
    expect(await fs.readFile(path)).toEqual(before);
  });
});

describe("fail-closed observation and persistence boundaries", () => {
  it("refuses a disclosed same-device bind mount identity without performing any actual mount", async () => {
    const f = await fixture();
    const root = f.deployment.roots.find((r) => r.path === f.host.config.gatewayDir)!;
    await fs.writeFile(join(root.path, "bindfile"), "inert file");
    await expect(inspectClosureEndpoints([root], [[]])).resolves.toMatch(/^[0-9a-f]{64}$/);
    const fdinfo = join(f.root, "different-mount-id");
    await fs.writeFile(fdinfo, "mnt_id:\t999999999\n");
    const original = fs.open;
    const paths = new Set<number>();
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const path = String(args[0]);
      const fake = [...paths].some((fd) => path === `/proc/self/fdinfo/${fd}`);
      const handle = await original(fake ? fdinfo : args[0], args[1], args[2]);
      if (path.endsWith("/bindfile")) paths.add(handle.fd);
      return handle;
    });
    await expect(inspectClosureEndpoints([root], [[]])).rejects.toThrow();
  });
  it("refuses an actual surviving detached process and a reused expected PID", async () => {
    const child = spawn(
      process.execPath,
      ["-e", "process.send('ready');setInterval(()=>{},1000)"],
      { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] }
    );
    try {
      await once(child, "message");
      const identity = await processIdentity(child.pid!);
      await expect(assertProcessesAbsent([identity])).rejects.toThrow();
      await expect(assertProcessesAbsent([{ ...identity, startTicks: "1" }])).rejects.toThrow();
      await expect(
        assertProcessesAbsent([{ ...identities[0]!, processGroupId: identity.processGroupId }])
      ).rejects.toThrow();
    } finally {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
  });
  it("refuses an exactly inspected remaining container, including a stopped one", async () => {
    const f = await fixture();
    const records = await readClosureRecords(f.deployment);
    const resource = records.state.resources[0]!;
    const spec = resourceSpec(f.host.config, resource);
    f.host.containers.set(resource.id!, {
      Id: resource.id!,
      Name: `/${resourceName(f.host.config, resource)}`,
      Image: spec.Image,
      Config: {
        ...spec,
        Cmd: ["fixed-entrypoint"],
        Entrypoint: null,
        Env: [],
        WorkingDir: "",
        Healthcheck: null
      },
      HostConfig: spec.HostConfig,
      State: { Running: false },
      NetworkSettings: { Ports: {} },
      Mounts: spec.HostConfig.Binds.map((bind) => {
        const [Source, Destination, mode] = bind.split(":");
        return { Type: "bind", Source, Destination, RW: mode === "rw", Propagation: "rprivate" };
      })
    });
    expect(await new ComputerDocker(f.host.config).inventory(records.state.resources)).toHaveLength(
      1
    );
    expect(await run(f)).toBe(2);
  });
  it.each(["file", "directory"])(
    "scaled native absolute timer exits2 on held final %s fsync despite repeated signals",
    async (kind) => {
      const f = await fixture();
      const code = `const fs=require('node:fs/promises');const original=fs.open;fs.open=async(...args)=>{const h=await original(...args);const p=String(args[0]);if(${JSON.stringify(kind)}==='file'?p.endsWith('/closure.jsonl'):p===${JSON.stringify(f.deployment.configuration.receipt.path)}){let count=0;const sync=h.sync.bind(h);h.sync=()=>{if(++count===2){process.send('held');return new Promise(()=>{});}return sync();};}return h;};const timer=global.setTimeout;global.setTimeout=(fn,ms,...args)=>timer(fn,ms===60000?500:ms,...args);require(process.argv[1]);`;
      const child = spawn(
        process.execPath,
        ["-e", code, bundle, f.deployment.config.path, f.readySocket],
        { stdio: ["ignore", "pipe", "pipe", "ipc"] }
      );
      let output = "";
      child.stdout!.on("data", (b) => {
        output += String(b);
      });
      child.stderr!.on("data", (b) => {
        output += String(b);
      });
      const exited = once(child, "exit");
      const [message] = await once(child, "message");
      expect(message).toBe("held");
      child.kill("SIGTERM");
      child.kill("SIGINT");
      child.kill("SIGTERM");
      expect((await exited)[0]).toBe(2);
      expect(output).toBe("");
      expect((await lines(f)).at(-1).record.type).toBe("observed-closed");
    }
  );
  it("refuses a receipt replaced after final persistence and close", async () => {
    const f = await fixture();
    let count = 0;
    expect(
      await run(f, {
        revalidate: async (d) => {
          await fixtureRevalidate(d);
          if (++count === 4) {
            const path = join(d.configuration.receipt.path, "closure.jsonl");
            const bytes = await fs.readFile(path);
            await fs.rename(path, path + ".old");
            await fs.writeFile(path, bytes, { mode: 0o600 });
          }
        }
      })
    ).toBe(2);
  });
  it("refuses live, reused and zombie-prone PID identities and surviving groups", async () => {
    const own = await processIdentity(process.pid);
    for (const p of [
      own,
      { ...own, startTicks: "1" },
      { ...identities[0]!, processGroupId: own.processGroupId }
    ])
      await expect(assertProcessesAbsent([p])).rejects.toThrow();
    await expect(assertProcessesAbsent(identities)).resolves.toBeUndefined();
  });
  it.each(["pending", "resurrected", "changed-generation", "wrong-stop", "untracked"])(
    "refuses %s retained state/resource ambiguity",
    async (mode) => {
      const f = await fixture();
      const state = JSON.parse(await fs.readFile(f.statePath, "utf8"));
      if (mode === "pending") state.resources[0].id = null;
      if (mode === "resurrected") state.enabled = true;
      if (mode === "changed-generation") state.resources[0].generation = 2;
      if (mode === "wrong-stop") {
        const stop = JSON.parse(await fs.readFile(f.stopPath, "utf8"));
        stop.state.generation = 2;
        await fs.writeFile(f.stopPath, JSON.stringify(stop));
      } else await fs.writeFile(f.statePath, JSON.stringify(state));
      if (mode === "untracked")
        f.host.containers.set("c".repeat(64), { Id: "c".repeat(64) } as never);
      expect(await run(f)).toBe(2);
    }
  );
  it.each(["state", "stop", "journal", "config", "root"])(
    "refuses %s replacement during observation",
    async (name) => {
      const f = await fixture();
      let changed = false;
      const paths = {
        state: f.statePath,
        stop: f.stopPath,
        journal: f.journalPath,
        config: f.deployment.config.path
      };
      expect(
        await run(f, {
          ready: async () => {
            if (changed) return;
            changed = true;
            if (name === "root") {
              await fs.rename(f.host.config.controlDir, f.host.config.controlDir + "-old");
              await fs.mkdir(f.host.config.controlDir, { mode: 0o700 });
              return;
            }
            const path = paths[name as keyof typeof paths];
            const bytes = await fs.readFile(path);
            await fs.rename(path, path + "-old");
            await fs.writeFile(path, bytes, { mode: 0o600 });
          }
        })
      ).toBe(2);
    }
  );
  it("refuses deadline equality and latched repeated signals", async () => {
    const f = await fixture();
    expect(await run(f, { startedAtMs: 0, now: () => 60000 })).toBe(2);
    let interrupted = false;
    expect(
      await run(f, {
        interrupted: () => interrupted,
        ready: async () => {
          interrupted = true;
        }
      })
    ).toBe(2);
  });
  it.each(["file", "directory"])("never returns success after failed %s fsync", async (kind) => {
    const f = await fixture();
    const original = fs.open;
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const file = await original(...args);
      const path = String(args[0]);
      if (
        (kind === "file" && path.endsWith("/closure.jsonl")) ||
        (kind === "directory" && path === f.deployment.configuration.receipt.path)
      )
        vi.spyOn(file, "sync").mockRejectedValue(new Error("disclosed fsync failure"));
      return file;
    });
    expect(await run(f)).toBe(2);
  });
  it.each(["symlink", "fifo", "oversize", "hardlink", "mode"])(
    "refuses unsafe %s input files",
    async (mode) => {
      const f = await fixture();
      const path = join(f.root, "unsafe");
      if (mode === "symlink") await fs.symlink(f.statePath, path);
      if (mode === "fifo") {
        const child = spawn("mkfifo", [path]);
        await once(child, "exit");
      }
      if (mode === "hardlink") await fs.link(f.statePath, path);
      if (mode === "mode" || mode === "oversize")
        await fs.writeFile(path, "a".repeat(mode === "oversize" ? 101 : 1), {
          mode: mode === "mode" ? 0o644 : 0o600
        });
      await expect(closureFile(path, 100)).rejects.toThrow();
    }
  );
  it("refuses same-inode byte changes", async () => {
    const f = await fixture();
    const file = await closureFile(f.statePath, 16384);
    await fs.writeFile(f.statePath, "{}");
    await expect(recheckClosureFile(file)).rejects.toThrow();
  });
  it.each(["symlink", "depth", "count"])("bounds endpoint traversal: %s", async (mode) => {
    const f = await fixture();
    const root = f.deployment.roots.find((r) => r.path === f.host.config.gatewayDir)!;
    if (mode === "symlink") await fs.symlink(f.root, join(root.path, "escape"));
    if (mode === "depth") await fs.mkdir(join(root.path, "a/b/c/d"), { recursive: true });
    if (mode === "count")
      for (let i = 0; i < 257; i++) await fs.writeFile(join(root.path, String(i)), "");
    await expect(inspectClosureEndpoints([root], [[]])).rejects.toThrow();
  });
  it("requires exact trusted fields, independent signer and full process tuples", async () => {
    const f = await fixture();
    const value = {
      ...f.deployment.configuration,
      receipt: { ...f.deployment.configuration.receipt, uid: 0 }
    };
    expect(parseClosureConfiguration(value).supervisor.lifetime!.binding).toEqual(
      value.supervisor.lifetime!.binding
    );
    for (const change of [
      { extra: true },
      { publicKeySha256: "invalid" },
      { processes: { ...value.processes, watchdog: value.supervisor.runner } },
      { supervisor: { ...value.supervisor, lifetime: undefined } }
    ])
      expect(() => parseClosureConfiguration({ ...value, ...change })).toThrow();
  });
  it("bounds actual journal ordering, lines, identity and trailing records", async () => {
    const f = await fixture();
    await expect(readClosureRecords(f.deployment)).resolves.toBeDefined();
    const bytes = await fs.readFile(f.journalPath);
    for (const invalid of [
      Buffer.concat([bytes, Buffer.from("{}\n")]),
      bytes.subarray(0, bytes.length - 1),
      Buffer.from("x".repeat(4097) + "\n{}\n"),
      Buffer.from(bytes.toString().replace('"pid":' + identities[0]!.pid, '"pid":1'))
    ])
      expect(() => closureCollectors(invalid, f.deployment)).toThrow();
  });
});
