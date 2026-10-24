import { afterEach, describe, expect, it, vi } from "vitest";
import { lstat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as guest from "../../apps/api/src/computer/guest-websocket.js";
import * as receiving from "../../apps/api/src/computer/receiving-gateway.js";
import * as protocol from "../../apps/api/src/computer/lifetime-protocol.js";
import { serveComputerGateway } from "../../apps/api/src/computer/gateway-server.js";
import { ComputerRootLifetime } from "../../scripts/computer-watchdog/lifetime.js";
import { connectComputerGatewayViewer } from "../../apps/api/src/computer/gateway-client.js";
import { processFixture } from "./computer-process-fixture.js";

vi.mock("../../apps/api/src/computer/guest-websocket.js", async (original) => ({
  ...(await original<typeof guest>())
}));
vi.mock("../../apps/api/src/computer/receiving-gateway.js", async (original) => ({
  ...(await original<typeof receiving>())
}));
vi.mock("../../apps/api/src/computer/lifetime-protocol.js", async (original) => ({
  ...(await original<typeof protocol>())
}));
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function fixture() {
  const f = await processFixture();
  cleanups.push(() => f.close());
  await f.stop();
  return { ...f.config, socketPath: join(f.auth.root, "next.sock") };
}
async function absent(path: string) {
  await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
}
async function activate(config: Awaited<ReturnType<typeof fixture>>) {
  const active = deferred<void>();
  const root = new ComputerRootLifetime({
    configuration: config.lifetime,
    socketPath: protocol.lifetimePath(config.socketPath),
    healthy: () => true,
    now: protocol.lifetimeNow,
    failed: () => {},
    activated: () => active.resolve()
  });
  cleanups.push(() => root.stop());
  root.start();
  await active.promise;
  return root;
}

describe("native gateway startup races with disclosed held async completions", () => {
  it.each(["guest", "core"])(
    "lifetime loss while %s completion is held destroys the late resource and never admits API",
    async (stage) => {
      const config = await fixture();
      const held = deferred<void>();
      cleanups.push(async () => held.resolve());
      const seen = deferred<void>();
      let upstream: Awaited<ReturnType<typeof guest.connectComputerGuestWebSocket>> | undefined;
      let core: receiving.ComputerReceivingGateway | undefined;
      const connectGuest = guest.connectComputerGuestWebSocket;
      const connectCore = receiving.connectComputerReceivingGateway;
      vi.spyOn(guest, "connectComputerGuestWebSocket").mockImplementation(async (path) => {
        upstream = await connectGuest(path);
        if (stage === "guest") {
          seen.resolve();
          await held.promise;
        }
        return upstream;
      });
      const makeCore = vi
        .spyOn(receiving, "connectComputerReceivingGateway")
        .mockImplementation(async (deps) => {
          core = await connectCore(deps);
          if (stage === "core") {
            seen.resolve();
            await held.promise;
          }
          return core;
        });
      const pending = serveComputerGateway(config);
      void pending.catch(() => {});
      await seen.promise;
      const root = await activate(config);
      await expect(
        connectComputerGatewayViewer({
          socketPath: config.socketPath,
          viewerId: config.ownerUserId
        })
      ).rejects.toThrow();
      expect(await root.stop()).toBe(true);
      held.resolve();
      await expect(pending).rejects.toThrow();
      expect(upstream?.destroyed).toBe(true);
      if (stage === "guest") expect(makeCore).not.toHaveBeenCalled();
      else expect(core?.snapshot().closed).toBe(true);
      await absent(config.socketPath);
      await absent(protocol.lifetimePath(config.socketPath));
    }
  );
  it("startup equality rejects a late guest completion before its timer callback", async () => {
    const config = await fixture();
    let clock = 0;
    vi.spyOn(protocol, "lifetimeNow").mockImplementation(() => clock);
    const held = deferred<void>();
    cleanups.push(async () => held.resolve());
    const seen = deferred<void>();
    const connect = guest.connectComputerGuestWebSocket;
    let upstream: Awaited<ReturnType<typeof connect>> | undefined;
    vi.spyOn(guest, "connectComputerGuestWebSocket").mockImplementation(async (path) => {
      upstream = await connect(path);
      seen.resolve();
      await held.promise;
      return upstream;
    });
    const pending = serveComputerGateway(config);
    void pending.catch(() => {});
    await seen.promise;
    clock = 5000;
    held.resolve();
    await expect(pending).rejects.toThrow();
    expect(upstream?.destroyed).toBe(true);
    await absent(config.socketPath);
    await absent(protocol.lifetimePath(config.socketPath));
  });
  it("requires both exclusive endpoints before guest connection and preserves an occupied lifetime path", async () => {
    const config = await fixture();
    const connect = vi.spyOn(guest, "connectComputerGuestWebSocket");
    const path = protocol.lifetimePath(config.socketPath);
    await writeFile(path, "occupied", { mode: 0o600 });
    await expect(serveComputerGateway(config)).rejects.toThrow();
    expect(connect).not.toHaveBeenCalled();
    expect((await lstat(path)).isFile()).toBe(true);
    await absent(config.socketPath);
  });
  it("a held initialization cannot extend the absolute startup timer", async () => {
    const config = await fixture();
    const held = deferred<void>();
    cleanups.push(async () => held.resolve());
    const connect = guest.connectComputerGuestWebSocket;
    const seen = deferred<void>();
    vi.spyOn(guest, "connectComputerGuestWebSocket").mockImplementation(async (path) => {
      const upstream = await connect(path);
      seen.resolve();
      await held.promise;
      return upstream;
    });
    const pending = serveComputerGateway(config);
    void pending.catch(() => {});
    await seen.promise;
    await new Promise((resolve) => setTimeout(resolve, 5050));
    held.resolve();
    await expect(pending).rejects.toThrow();
    await absent(config.socketPath);
    await absent(protocol.lifetimePath(config.socketPath));
  });
});
