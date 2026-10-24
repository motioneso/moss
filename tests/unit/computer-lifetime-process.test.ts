import * as protocol from "../../apps/api/src/computer/lifetime-protocol.js";
import { connectComputerGatewayViewer } from "../../apps/api/src/computer/gateway-client.js";
import { binding } from "./computer-auth-fixture.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createConnection } from "node:net";
import { ComputerReceivingGateway } from "../../apps/api/src/computer/receiving-gateway.js";
import { lifetimePath } from "../../apps/api/src/computer/lifetime-protocol.js";
import { processFixture } from "./computer-process-fixture.js";

vi.mock("../../apps/api/src/computer/lifetime-protocol.js", async (original) => ({
  ...(await original<typeof protocol>())
}));

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});
async function fixture(autoLifetime = true) {
  const f = await processFixture(false, { autoLifetime });
  cleanups.push(() => f.close());
  return f;
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

/** Native executable fixture: real supervisor/policy/lifetime, synthetic measurements and journal. */
async function publisher(f: Awaited<ReturnType<typeof processFixture>>) {
  const file = join(f.auth.root, "root.mts");
  const source = pathToFileURL(join(process.cwd(), "scripts/computer-watchdog/supervisor.ts")).href;
  await writeFile(
    file,
    `
    import {runComputerSupervisor} from ${JSON.stringify(source)};
    import {PassThrough} from 'node:stream';
    const input=JSON.parse(await new Promise(resolve=>process.stdin.once('data',resolve)));
    const now=()=>Number(process.hrtime.bigint()/1000000n);
    const startedAtMs=now();
    const runner={pid:101,processGroupId:101,startTicks:'123'};
    const watchdog={pid:202,processGroupId:202,startTicks:'456'};
    const identity={pid:303,processGroupId:303,startTicks:'789'};
    let release;
    const held=new Promise(resolve=>release=resolve);
    process.stdin.once('data',()=>release());
    const sample={runId:input.configuration.binding.runId,measuredAtMs:startedAtMs,
      runner:{...runner,state:'running'},watchdog:{...watchdog,state:'running'},
      availableMemoryBytes:16*1024**3,rootAvailableBytes:40*1024**3,dataAvailableBytes:40*1024**3,
      homeBytes:4096,socketBytes:4096,mossHealthy:true,logsBounded:true,stopRequested:false};
    const result=runComputerSupervisor({
      configuration:{runId:sample.runId,startedAtMs,runner,watchdog},lifetime:input,
      now,heartbeats:new PassThrough(),signals:process,verifyRunner:async()=>{},
      journal:{pending:false,inspect:async()=>{},collector:async()=>{},sample:async()=>{},
        stop:async()=>{console.log('stopping');await held},close:async()=>{}},
      startCollector:()=>({pid:303,identity:Promise.resolve(identity),exited:Promise.resolve(),
        result:Promise.resolve(sample),collect(){},kill(){}})
    });
    result.then(value=>{console.log(JSON.stringify(value));process.exit(value.exitCode)});
  `
  );
  const child = spawn(process.execPath, ["--import", "tsx", file], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"]
  });
  const exited = once(child, "exit");
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-4096);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    errors = (errors + chunk.toString()).slice(-4096);
  });
  child.stdin.on("error", () => {});
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  });
  child.stdin.write(
    JSON.stringify({
      configuration: f.config.lifetime,
      socketPath: lifetimePath(f.config.socketPath)
    })
  );
  return { child, exited, output: () => output, errors: () => errors };
}
async function openWhenActive(f: Awaited<ReturnType<typeof processFixture>>) {
  let opened: Awaited<ReturnType<typeof f.open>> | undefined;
  const viewerId = f.auth.server.issue(binding());
  await expect
    .poll(
      async () => {
        try {
          const viewer = await connectComputerGatewayViewer({
            socketPath: f.config.socketPath,
            viewerId
          });
          cleanups.push(async () => viewer.disconnect());
          opened = { viewerId, viewer };
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 3000 }
    )
    .toBe(true);
  return opened!;
}

describe("real supervisor to receiving core lifetime, disclosed native executable fixtures", () => {
  it("rejects API access until authentication and keeps its lifetime slot outside the twelve API sockets", async () => {
    const f = await fixture(false);
    await expect(f.open()).rejects.toThrow();
    await f.startLifetime();
    const sockets = Array.from({ length: 12 }, () => createConnection(f.config.socketPath));
    for (const socket of sockets) socket.on("error", () => {});
    cleanups.push(async () => {
      for (const socket of sockets) socket.destroy();
    });
    await Promise.all(sockets.map((socket) => once(socket, "connect")));
    expect(await f.lifetime.stop()).toBe(true);
    await expect(f.open()).rejects.toThrow();
  });
  it("invokes core retirement before signed ack while asynchronous cleanup is held", async () => {
    const f = await fixture();
    const { viewer } = await f.open();
    await viewer.takeOver();
    const controller = await f.rfb(viewer, true);
    const watcher = await f.rfb(viewer);
    controller.keyEvent(65, true);
    await settle();
    expect(f.events).toContainEqual(["key", 65, true]);
    const original = ComputerReceivingGateway.prototype.close;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    cleanups.push(async () => release());
    const close = vi
      .spyOn(ComputerReceivingGateway.prototype, "close")
      .mockImplementation(function () {
        void original.call(this);
        return held;
      });
    const controllerClosed = once(controller, "close");
    const watcherClosed = once(watcher, "close");
    expect(await f.lifetime.stop()).toBe(true);
    expect(close).toHaveBeenCalled();
    expect(close.mock.contexts[0]!.snapshot().closed).toBe(true);
    await Promise.all([controllerClosed, watcherClosed]);
    await expect.poll(() => f.events).toContainEqual(["key", 65, false]);
    await expect(f.open()).rejects.toThrow();
    release();
  });
  it("real root terminal fences active input and watcher before held journal persistence finishes", async () => {
    const f = await fixture(false);
    const root = await publisher(f);
    const { viewer } = await openWhenActive(f).catch((error: unknown) => {
      throw new Error(root.errors() + root.output(), { cause: error });
    });
    await viewer.takeOver();
    const controller = await f.rfb(viewer, true);
    const watcher = await f.rfb(viewer);
    const update = once(watcher, "update");
    watcher.requestUpdate(false);
    expect((await update)[0].rects.length).toBeGreaterThan(0);
    controller.keyEvent(65, true);
    await expect.poll(() => f.events).toContainEqual(["key", 65, true]);
    const closed = Promise.all([once(controller, "close"), once(watcher, "close")]);
    root.child.kill("SIGTERM");
    await closed;
    await expect.poll(() => root.output()).toContain("stopping");
    expect(root.child.exitCode).toBeNull();
    await expect.poll(() => f.events).toContainEqual(["key", 65, false]);
    await expect(f.open()).rejects.toThrow();
    root.child.kill("SIGTERM");
    root.child.stdin.write("release");
    expect(await root.exited).toEqual([0, null]);
    expect(root.output()).toContain('"receiverFenced":true');
    expect(root.output()).toContain('"durableStop":true');
    expect(root.errors()).toBe("");
  });
  it.each(["SIGKILL", "SIGSTOP"] as const)(
    "root %s retires actual active receiver",
    async (signal) => {
      const f = await fixture(false);
      const root = await publisher(f);
      const { viewer } = await openWhenActive(f).catch((error: unknown) => {
        throw new Error(root.errors() + root.output(), { cause: error });
      });
      const watcher = await f.rfb(viewer);
      const closed = once(watcher, "close");
      root.child.kill(signal);
      await closed;
      await expect(f.open()).rejects.toThrow();
      if (signal === "SIGSTOP") {
        root.child.kill("SIGKILL");
        await root.exited;
      }
    }
  );
  it.each(["input", "frame"])(
    "actual %s dispatch expires at equality before the retirement timer runs",
    async (kind) => {
      let clock = 0;
      vi.spyOn(protocol, "lifetimeNow").mockImplementation(() => clock);
      const f = await fixture();
      const { viewer } = await f.open();
      await viewer.takeOver();
      const controller = await f.rfb(viewer, true);
      const watcher = await f.rfb(viewer);
      controller.keyEvent(65, true);
      await expect.poll(() => f.events).toContainEqual(["key", 65, true]);
      const closed = once(watcher, "close");
      let frames = 0;
      watcher.on("update", () => frames++);
      clock = 2000; // Initial acknowledged challenge's absolute idle expiry; native timer has not fired.
      if (kind === "input") controller.keyEvent(66, true);
      else watcher.requestUpdate(false);
      await closed;
      expect(f.events).not.toContainEqual(["key", 66, true]);
      expect(frames).toBe(0);
      await expect.poll(() => f.events).toContainEqual(["key", 65, false]);
      expect(await f.lifetime.stop()).toBe(false);
    }
  );
  it("authorization completing at lifetime expiry cannot send queued raw input", async () => {
    let clock = 0;
    vi.spyOn(protocol, "lifetimeNow").mockImplementation(() => clock);
    const f = await fixture();
    const { viewer } = await f.open();
    await viewer.takeOver();
    const controller = await f.rfb(viewer, true);
    const watcher = await f.rfb(viewer);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    cleanups.push(async () => release());
    const calls = f.auth.assertLive.mock.calls.length;
    f.auth.assertLive.mockImplementation(async () => held);
    controller.keyEvent(66, true);
    await expect.poll(() => f.auth.assertLive.mock.calls.length).toBeGreaterThan(calls);
    const closed = once(watcher, "close");
    clock = 2000;
    release();
    await closed;
    expect(f.events).not.toContainEqual(["key", 66, true]);
    expect(await f.lifetime.stop()).toBe(false);
  });
  it("a replacement connection permanently retires the active core", async () => {
    const f = await fixture();
    const { viewer } = await f.open();
    const watcher = await f.rfb(viewer);
    const closed = once(watcher, "close");
    const duplicate = createConnection(lifetimePath(f.config.socketPath));
    duplicate.on("error", () => {});
    cleanups.push(async () => duplicate.destroy());
    await closed;
    await expect(f.open()).rejects.toThrow();
    expect(await f.lifetime.stop()).toBe(false);
  });
});
