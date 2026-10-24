import { spawn } from "node:child_process";
import { join } from "node:path";
import { once } from "node:events";
import { createConnection, createServer, type Socket } from "node:net";
import { lstat, readdir, unlink, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { serveComputerGateway } from "../../apps/api/src/computer/gateway-server.js";
import { connectComputerGatewayViewer } from "../../apps/api/src/computer/gateway-client.js";
import { processFixture } from "./computer-process-fixture.js";
import { authFixture, binding, SESSION, tick, OWNER } from "./computer-auth-fixture.js";
import { WIDTH, HEIGHT } from "./computer-gateway-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
async function setup(executable = false) {
  const f = await processFixture(executable);
  cleanups.push(() => f.close());
  return f;
}
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

describe("separate Computer gateway executable and private IPC", () => {
  it("runs the actual executable: one upstream, watching pixels, owner input, return and intentional close", async () => {
    const f = await setup(true);
    const { viewer } = await f.open();
    const watcher = await f.rfb(viewer);
    const update = once(watcher, "update");
    watcher.requestUpdate(false);
    const [frame] = await update;
    expect(frame.rects[0]).toMatchObject({ width: WIDTH, height: HEIGHT });
    expect([...frame.rects[0].data.subarray(0, 4)]).toEqual([204, 34, 17, 0]);
    watcher.keyEvent(66, true);
    await settle();
    expect(f.events).toEqual([]);
    await viewer.takeOver();
    const controller = await f.rfb(viewer, true);
    controller.keyEvent(65, true);
    await settle();
    expect(f.events).toContainEqual(["key", 65, true]);
    // Controller EOF occurs before return's delayed Fence reply; private lifetime must survive.
    f.holdFences();
    const returning = viewer.returnToMoss();
    await once(controller, "close");
    f.releaseFences();
    await returning;
    expect(await viewer.snapshot()).toMatchObject({ mode: "moss", receivingReady: true });
    expect(f.events).toContainEqual(["key", 65, false]);
    await viewer.takeOver();
    const nextController = await f.rfb(viewer, true);
    nextController.keyEvent(67, true);
    await settle();
    await viewer.closeViewer();
    const observer = await f.open(binding("40000000-0000-4000-8000-000000000004"));
    expect(await observer.viewer.snapshot()).toMatchObject({ mode: "moss", viewerCount: 1 });
    expect(f.connections).toBe(1);
    expect((await lstat(f.config.socketPath)).mode & 0o777).toBe(0o600);
    expect(await f.stop()).toBe(0);
    expect(f.childOutput).toBe("Computer gateway listening\n");
    await expect(lstat(f.config.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(f.auth.root)).filter((name) => name.startsWith(".gateway-"))).toEqual([]);
  });

  it("active auth push closes actual visual streams and pauses the same private receiver", async () => {
    const f = await setup();
    const { viewer } = await f.open();
    await viewer.takeOver();
    const client = await f.rfb(viewer, true);
    const closed = once(client, "close");
    f.auth.invalidations.invalidate({ actorUserId: binding().actorUserId, sessionId: SESSION });
    await closed;
    expect(await viewer.snapshot()).toMatchObject({ mode: "paused", receivingReady: false });
    await expect(viewer.takeOver()).rejects.toThrow();
  });

  it("lost control channel fences pressed input, while unexpected raw loss never returns authority", async () => {
    const f = await setup();
    const { viewer } = await f.open();
    const observer = await f.open(binding("40000000-0000-4000-8000-000000000004"));
    await viewer.takeOver();
    const controller = await f.rfb(viewer, true);
    controller.keyEvent(65, true);
    await settle();
    viewer.disconnect();
    await settle();
    expect(await observer.viewer.snapshot()).toMatchObject({ mode: "paused" });
    expect(f.events).toContainEqual(["key", 65, false]);
    await observer.viewer.takeOver();
    const second = await f.rfb(observer.viewer, true);
    second.destroy();
    await settle();
    expect(await observer.viewer.snapshot()).toMatchObject({ mode: "paused" });
  });

  it("refuses duplicate/reused/foreign-issued bindings and a fifth control lifetime", async () => {
    const f = await setup();
    const { viewer, viewerId } = await f.open();
    await expect(
      connectComputerGatewayViewer({ socketPath: f.config.socketPath, viewerId })
    ).rejects.toThrow();
    await expect(
      connectComputerGatewayViewer({
        socketPath: f.config.socketPath,
        viewerId: "90000000-0000-4000-8000-000000000009"
      })
    ).rejects.toThrow();
    for (let i = 0; i < 3; i++) await f.open(binding(`40000000-0000-4000-8000-00000000000${i}`));
    // Auth registry also has four entries: use a syntactically valid private ID to hit process capacity.
    await expect(
      connectComputerGatewayViewer({
        socketPath: f.config.socketPath,
        viewerId: "80000000-0000-4000-8000-000000000008"
      })
    ).rejects.toThrow();
    expect(await viewer.snapshot()).toMatchObject({ viewerCount: 4 });
  });

  it("bounds unbound sockets and header bytes before any auth operation", async () => {
    const f = await setup();
    const sockets = Array.from({ length: 13 }, () => createConnection(f.config.socketPath));
    for (const socket of sockets) socket.on("error", () => {});
    cleanups.unshift(async () => {
      for (const socket of sockets) socket.destroy();
    });
    await once(sockets[12]!, "close");
    expect(f.auth.assertLive).not.toHaveBeenCalled();
    const closed = once(sockets[0]!, "close");
    sockets[0]!.write(Buffer.alloc(1025, 65));
    await closed;
    expect(f.auth.assertLive).not.toHaveBeenCalled();
  });

  it("preserves replacement private endpoints when the process closes", async () => {
    const f = await setup();
    await unlink(f.config.socketPath);
    const replacement = createServer((socket) => socket.destroy());
    replacement.listen(f.config.socketPath);
    await once(replacement, "listening");
    cleanups.unshift(() => new Promise<void>((resolve) => replacement.close(() => resolve())));
    const ino = (await lstat(f.config.socketPath)).ino;
    await f.stop();
    expect((await lstat(f.config.socketPath)).ino).toBe(ino);
    const client = createConnection(f.config.socketPath);
    await once(client, "close");
    await tick();
  });
  it("rejects a wrong private request sequence and fences that connection's controller", async () => {
    const f = await setup();
    const id = f.auth.server.issue(binding());
    const raw = createConnection(f.config.socketPath);
    raw.on("error", () => {});
    raw.write(JSON.stringify({ type: "open", requestId: 1, viewerId: id }) + "\n");
    await once(raw, "data");
    const closed = once(raw, "close");
    raw.write(JSON.stringify({ type: "takeOver", requestId: 3 }) + "\n");
    await closed;
    const observer = await f.open(binding("40000000-0000-4000-8000-000000000004"));
    expect(await observer.viewer.snapshot()).toMatchObject({ mode: "paused", viewerCount: 1 });
  });
  it("exclusive startup refuses a duplicate before any second guest accept and preserves the first service", async () => {
    const f = await setup();
    const before = await lstat(f.config.socketPath);
    let failure: unknown;
    let duplicate: Awaited<ReturnType<typeof serveComputerGateway>> | undefined;
    try {
      duplicate = await serveComputerGateway(f.config);
    } catch (error) {
      failure = error;
    } finally {
      await duplicate?.close();
    }
    expect(failure).toMatchObject({ code: "EEXIST" });
    expect(f.connections).toBe(1);
    expect((await lstat(f.config.socketPath)).ino).toBe(before.ino);
    const { viewer } = await f.open();
    expect(await viewer.snapshot()).toMatchObject({ closed: false });
  });

  it("failed guest startup removes only its reserved IPC endpoint and private bind directory", async () => {
    const f = await setup();
    await f.stop();
    await expect(
      serveComputerGateway({ ...f.config, guestSocketPath: f.config.guestSocketPath + "-missing" })
    ).rejects.toThrow();
    await expect(lstat(f.config.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(f.auth.root)).filter((name) => name.startsWith(".gateway-"))).toEqual([]);
  });
  it("control-channel loss without any parser still retires owner authority", async () => {
    const f = await setup();
    const observer = await f.open(binding("40000000-0000-4000-8000-000000000004"));
    const id = f.auth.server.issue(binding());
    const raw = createConnection(f.config.socketPath);
    raw.on("error", () => {});
    raw.write(JSON.stringify({ type: "open", requestId: 1, viewerId: id }) + "\n");
    await once(raw, "data");
    raw.write(JSON.stringify({ type: "takeOver", requestId: 2 }) + "\n");
    await once(raw, "data");
    expect(await observer.viewer.snapshot()).toMatchObject({ mode: "owner" });
    raw.destroy();
    await settle();
    expect(await observer.viewer.snapshot()).toMatchObject({ mode: "paused", viewerCount: 1 });
  });

  it("TERM during a stalled startup closes the exact reserved endpoint and process", async () => {
    const auth = await authFixture();
    cleanups.push(() => auth.close());
    const peers = new Set<Socket>();
    const guest = createServer((socket) => {
      peers.add(socket);
      socket.on("error", () => {});
    });
    const guestPath = join(auth.root, "stall.sock");
    await new Promise<void>((resolve) => guest.listen(guestPath, resolve));
    cleanups.unshift(async () => {
      for (const peer of peers) peer.destroy();
      await new Promise<void>((resolve) => guest.close(() => resolve()));
    });
    const configPath = join(auth.root, "gateway.json");
    const endpoint = join(auth.root, "gateway.sock");
    await writeFile(
      configPath,
      JSON.stringify({
        ownerUserId: OWNER,
        guestSocketPath: guestPath,
        authSocketPath: auth.socketPath,
        socketPath: endpoint
      }),
      { mode: 0o600 }
    );
    const accepted = once(guest, "connection");
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "scripts/computer-gateway.ts", configPath],
      { stdio: "ignore" }
    );
    const exited = once(child, "exit");
    cleanups.unshift(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exited;
      }
    });
    await accepted;
    expect((await lstat(endpoint)).isSocket()).toBe(true);
    child.kill("SIGTERM");
    expect((await exited)[0]).toBe(1);
    await expect(lstat(endpoint)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(auth.root)).filter((name) => name.startsWith(".gateway-"))).toEqual([]);
  });
});
