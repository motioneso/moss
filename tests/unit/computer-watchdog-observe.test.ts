import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as trust from "../../scripts/computer-watchdog/trust.js";
import * as linux from "../../scripts/computer-watchdog/linux.js";
import {
  checkComputerLogs,
  checkMossReadiness,
  observeComputer
} from "../../scripts/computer-watchdog/observe.js";
import { ObservationJournal } from "../../scripts/computer-watchdog/journal.js";
import { inspectRoots } from "../../scripts/computer-host/config.js";
import { binding, hostFixture } from "./computer-host-fixture.js";

vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof fs>()) }));
vi.mock("node:http", async (original) => ({ ...(await original<typeof http>()) }));
vi.mock("../../scripts/computer-watchdog/trust.js", async (original) => ({
  ...(await original<typeof trust>())
}));
vi.mock("../../scripts/computer-watchdog/linux.js", async (original) => ({
  ...(await original<typeof linux>())
}));
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
});
const runId = "10000000-0000-4000-8000-000000000001";
const runner = { pid: 101, processGroupId: 101, startTicks: "123" };
const watchdog = { pid: 202, processGroupId: 202, startTicks: "456" };

async function readiness(options: { status?: number; body?: string; hold?: boolean } = {}) {
  const root = await fs.mkdtemp(join(tmpdir(), "computer-ready-"));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const path = join(root, "ready.sock");
  const server = http.createServer((request, response) => {
    expect(request.url).toBe("/health/ready");
    if (options.hold) return;
    response.writeHead(options.status ?? 200, { "content-type": "application/json" });
    response.end(options.body ?? JSON.stringify({ ok: true, db: "ok", pgboss: "ok" }));
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const original = http.request;
  const request = vi.spyOn(http, "request").mockImplementation(((
    first: unknown,
    ...args: unknown[]
  ) => {
    // Only redirect the native loopback readiness transport to a real private Unix HTTP fixture.
    // Docker Unix requests retain the canonical host adapter without interception.
    if (first instanceof URL)
      return original({ socketPath: path, method: "GET", path: first.pathname, agent: false });
    return Reflect.apply(original, http, [first, ...args]) as ReturnType<typeof http.request>;
  }) as typeof http.request);
  return { request };
}
async function fixture() {
  const host = await hostFixture({ admitted: true });
  cleanups.push(() => host.close());
  await host.client.request(binding(), "enable", 0);
  const path = await fs.mkdtemp(join(await fs.realpath(tmpdir()), "computer-observe-"));
  cleanups.push(() => fs.rm(path, { recursive: true, force: true }));
  const root = async (name: string) => {
    const pathName = join(path, name);
    await fs.mkdir(pathName, { mode: 0o700 });
    const { dev, ino, uid, gid, mode } = await fs.lstat(pathName);
    return { path: pathName, dev, ino, uid, gid, mode };
  };
  const data = await root("data"),
    dockerData = await root("docker"),
    monitor = await root("monitor");
  const configuration = {
    runId,
    runner,
    host: host.config,
    data,
    dockerData,
    monitor,
    readyUrl: "http://127.0.0.1:5180/health/ready",
    artifactSha256: "a".repeat(64),
    bootId: runId,
    namespaces: { pid: "pid:[1]", mnt: "mnt:[2]", user: "user:[3]" }
  };
  const roots = await inspectRoots(host.config);
  const deployment: trust.SupervisorDeployment = {
    configuration,
    roots,
    marker: JSON.stringify({ config: host.config, roots }),
    configPath: "fixture",
    configSha256: "a".repeat(64),
    artifactPath: "fixture",
    nodePath: process.execPath
  };
  const journal = await ObservationJournal.create(monitor, {
    runId,
    runner,
    watchdog,
    startedAtMs: 0
  });
  cleanups.push(() => journal.close());
  const logs: string[] = [];
  for (const container of host.containers.values()) {
    const directory = join(dockerData.path, "containers", container.Id);
    await fs.mkdir(directory, { recursive: true });
    const logPath = join(directory, `${container.Id}-json.log`);
    await fs.writeFile(logPath, "", { mode: 0o600 });
    Object.assign(container, { LogPath: logPath });
    logs.push(logPath);
  }
  // Disclosed root-log ownership/ancestry fixtures. Real directory entries, byte sizes, rotation,
  // host state, exact Docker HTTP spec checks and monitor receipts remain in the exercised path.
  vi.spyOn(trust, "assertTrustedPath").mockResolvedValue();
  const originalStat = fs.lstat;
  vi.spyOn(fs, "lstat").mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
    const stat = await originalStat(...args);
    if (String(args[0]).includes("-json.log")) Object.assign(stat, { uid: 0 });
    return stat;
  });
  return { host, deployment, logs, journal };
}

describe("native bounded readiness with disclosed Unix destination seam", () => {
  it("requires exact healthy DB and pg-boss fields", async () => {
    await readiness();
    await expect(checkMossReadiness("http://127.0.0.1:5180/health/ready")).resolves.toBeUndefined();
  });
  it.each([
    { status: 201 },
    { status: 302 },
    { status: 503 },
    { body: '{"ok":true}' },
    { body: '{"ok":true,"db":"down","pgboss":"ok"}' },
    { body: '{"ok":true,"db":"ok","pgboss":"ok","extra":true}' },
    { body: "x".repeat(4097) }
  ])("refuses nonexact status, body and byte limit %j", async (options) => {
    await readiness(options);
    await expect(checkMossReadiness("http://127.0.0.1:5180/health/ready")).rejects.toThrow();
  });
  it("applies an absolute deadline to a silent native server", async () => {
    await readiness({ hold: true });
    const at = performance.now();
    await expect(checkMossReadiness("http://127.0.0.1:5180/health/ready")).rejects.toThrow();
    expect(performance.now() - at).toBeLessThan(3000);
  });
});
describe("complete observation with explicit trust/Linux fixtures, native files and Docker HTTP stand-in", () => {
  it("composes health/log/run/stop proof without freshening early checks", async () => {
    const f = await fixture();
    await readiness();
    vi.spyOn(trust, "revalidateDeployment").mockResolvedValue();
    vi.spyOn(trust, "assertNullOutputs").mockResolvedValue();
    vi.spyOn(linux, "readComputerProcess").mockResolvedValue({ ...watchdog, state: "running" });
    vi.spyOn(linux, "computerMonotonicMs").mockReturnValueOnce(1000).mockReturnValue(4000);
    vi.spyOn(linux, "collectComputerLinuxMeasurements").mockResolvedValue({
      measuredAtMs: 3000,
      runner: { ...runner, state: "running" },
      watchdog: { ...watchdog, state: "running" },
      availableMemoryBytes: 16 * 1024 ** 3,
      rootAvailableBytes: 40 * 1024 ** 3,
      dataAvailableBytes: 40 * 1024 ** 3,
      homeBytes: 4096,
      socketBytes: 4096
    });
    const sample = await observeComputer(f.deployment, watchdog);
    expect(sample).toMatchObject({
      measuredAtMs: 1000,
      runId,
      mossHealthy: true,
      logsBounded: true,
      stopRequested: false
    });
    expect(trust.revalidateDeployment).toHaveBeenCalledTimes(2);
    const boundary = f.host.calls.length;
    await checkComputerLogs(f.deployment);
    expect(f.host.calls.slice(boundary).every((call) => call.method === "GET")).toBe(true);
  });
  it("accounts real current and one rotation, rejects equality and unexpected rotations", async () => {
    const f = await fixture();
    await checkComputerLogs(f.deployment);
    await fs.writeFile(`${f.logs[0]!}.1`, "bounded", { mode: 0o600 });
    await checkComputerLogs(f.deployment);
    await fs.truncate(f.logs[0]!, 2 * 1024 ** 2);
    await expect(checkComputerLogs(f.deployment)).rejects.toThrow();
    await fs.truncate(f.logs[0]!, 0);
    await fs.writeFile(`${f.logs[0]!}.2`, "", { mode: 0o600 });
    await expect(checkComputerLogs(f.deployment)).rejects.toThrow();
  });
  it("rejects symlinks, missing logs and noncanonical Docker log paths", async () => {
    const f = await fixture();
    await fs.unlink(f.logs[0]!);
    await expect(checkComputerLogs(f.deployment)).rejects.toThrow();
    await fs.symlink(f.logs[1]!, f.logs[0]!);
    await expect(checkComputerLogs(f.deployment)).rejects.toThrow();
    const container = [...f.host.containers.values()][0]!;
    Object.assign(container, { LogPath: "/untrusted/log" });
    await expect(checkComputerLogs(f.deployment)).rejects.toThrow();
  });
  it("never treats pending intent or untracked inventory as empty prelaunch proof", async () => {
    const f = await fixture();
    await f.host.store.save({
      ...f.host.store.state,
      resources: f.host.store.state.resources.map((resource) => ({ ...resource, id: null }))
    });
    await expect(checkComputerLogs(f.deployment)).rejects.toThrow();
  });
});
