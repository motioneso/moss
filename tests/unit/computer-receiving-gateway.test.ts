import { afterEach, describe, expect, it, vi } from "vitest";
import { gatewayFixture, pixels, tick } from "./computer-gateway-fixture.js";
import { binding, deferred, SESSION } from "./computer-auth-fixture.js";
import { ComputerRfbInput } from "../../apps/api/src/computer/rfb-input.js";

let fixture: Awaited<ReturnType<typeof gatewayFixture>> | undefined;
afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
  vi.restoreAllMocks();
});

describe("Computer terminating receiving core", () => {
  it("fans actual Raw pixels out to watchers with bgrx and noVNC rgbx", async () => {
    const f = (fixture = await gatewayFixture());
    const a = await f.attach(await f.open());
    const b = await f.attach(await f.open(), false, "rgbx");
    const frameA = await f.frame(a);
    const frameB = await f.frame(b);
    expect(frameA.rects[0].data).toEqual(pixels);
    expect(frameB.rects[0].data.subarray(0, 4)).toEqual(Buffer.from([204, 34, 17, 0]));
    a.keyEvent(65, true);
    b.keyEvent(66, true);
    await tick();
    expect(f.events).toEqual([]);
    expect(f.gateway.snapshot()).toMatchObject({ mode: "paused", frameReady: true });
  });

  it("uses the sole receiver for takeover, key release, return and fresh agent leases", async () => {
    const f = (fixture = await gatewayFixture());
    const viewer = await f.open();
    await f.gateway.takeOver(viewer);
    const client = await f.attach(viewer, true);
    client.keyEvent(65, true);
    await vi.waitFor(() => expect(f.events).toContainEqual(["key", 65, true]));
    await f.gateway.returnToMoss(viewer);
    expect(f.events).toContainEqual(["key", 65, false]);
    const lease = f.gateway.acquireAgentLease();
    await f.gateway.dispatchAgent(lease, { type: "key", keysym: 66, down: true });
    await vi.waitFor(() => expect(f.events).toContainEqual(["key", 66, true]));
    await f.gateway.takeOver(viewer);
    await expect(
      f.gateway.dispatchAgent(lease, { type: "key", keysym: 67, down: true })
    ).rejects.toThrow();
  });

  it("intentional controlling close returns with an actively monitored agent grant", async () => {
    const f = (fixture = await gatewayFixture());
    const viewer = await f.open();
    await f.gateway.takeOver(viewer);
    await f.attach(viewer, true);
    await f.gateway.closeViewer(viewer);
    expect(f.gateway.snapshot()).toMatchObject({ mode: "moss", viewerCount: 0 });
    const lease = f.gateway.acquireAgentLease();
    await f.gateway.dispatchAgent(lease, { type: "key", keysym: 65, down: true });
    f.auth.invalidations.invalidate({ actorUserId: binding().actorUserId, sessionId: SESSION });
    await vi.waitFor(() => expect(f.gateway.snapshot().mode).toBe("paused"));
    await expect(
      f.gateway.dispatchAgent(lease, { type: "key", keysym: 66, down: true })
    ).rejects.toThrow();
  });

  it("closing a watcher preserves a same-session controller", async () => {
    const f = (fixture = await gatewayFixture());
    const owner = await f.open();
    const watcher = await f.open();
    await f.gateway.takeOver(owner);
    const client = await f.attach(owner, true);
    await f.attach(watcher);
    await f.gateway.closeViewer(watcher);
    expect(f.gateway.snapshot().mode).toBe("owner");
    client.keyEvent(65, true);
    await vi.waitFor(() => expect(f.events).toContainEqual(["key", 65, true]));
  });

  it("old monitor cleanup preserves a new same-session grant", async () => {
    const f = (fixture = await gatewayFixture());
    const first = await f.open();
    await f.gateway.takeOver(first);
    await f.gateway.closeViewer(first);
    const next = await f.open();
    await f.gateway.takeOver(next);
    await f.gateway.returnToMoss(next);
    expect(f.gateway.snapshot().mode).toBe("moss");
    await f.gateway.dispatchAgent(f.gateway.acquireAgentLease(), {
      type: "key",
      keysym: 65,
      down: true
    });
    await vi.waitFor(() => expect(f.events).toContainEqual(["key", 65, true]));
  });

  it("push retirement destroys all affected viewers and releases pressed input", async () => {
    const f = (fixture = await gatewayFixture());
    const viewer = await f.open();
    await f.gateway.takeOver(viewer);
    const client = await f.attach(viewer, true);
    client.keyEvent(65, true);
    await vi.waitFor(() => expect(f.events).toContainEqual(["key", 65, true]));
    f.auth.invalidations.invalidate({ actorUserId: binding().actorUserId, sessionId: SESSION });
    await vi.waitFor(() => expect(client.connected).toBe(false));
    expect(f.gateway.snapshot().mode).toBe("paused");
    await vi.waitFor(() => expect(f.events).toContainEqual(["key", 65, false]));
    await expect(f.gateway.takeOver(viewer)).rejects.toThrow();
  });

  it("unexpected controller loss pauses instead of returning authority", async () => {
    const f = (fixture = await gatewayFixture());
    const viewer = await f.open();
    await f.gateway.takeOver(viewer);
    const client = await f.attach(viewer, true);
    client.destroy();
    await vi.waitFor(() => expect(f.gateway.snapshot().mode).toBe("paused"));
    expect(() => f.gateway.acquireAgentLease()).toThrow();
  });

  it("counts pending auth opens and fences their late completion on shutdown", async () => {
    const f = (fixture = await gatewayFixture());
    let release = () => {};
    f.auth.assertLive.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const opening = f.open();
    const rejected = expect(opening).rejects.toThrow();
    await vi.waitFor(() => expect(f.auth.assertLive).toHaveBeenCalled());
    await f.gateway.close();
    release();
    await rejected;
    expect(f.gateway.snapshot()).toMatchObject({ closed: true, viewerCount: 0 });
  });

  it("bounds viewer lifetimes including retained grant monitors", async () => {
    const f = (fixture = await gatewayFixture());
    const first = await f.open();
    await f.gateway.takeOver(first);
    await f.gateway.closeViewer(first);
    await f.open();
    await f.open();
    await f.open();
    await expect(f.gateway.openViewer("10000000-0000-4000-8000-000000000001")).rejects.toThrow();
  });

  it("rejects a viewer completed after its gateway lifetime ended", async () => {
    const f = (fixture = await gatewayFixture());
    const entered = deferred();
    const release = deferred();
    const connect = ComputerRfbInput.prototype.connect;
    vi.spyOn(ComputerRfbInput.prototype, "connect").mockImplementation(async function (binding) {
      const viewer = await connect.call(this, binding);
      entered.resolve();
      await release.promise; // Delay completion only; real receiver and Unix auth still run.
      return viewer;
    });
    const opening = f.open();
    const rejected = expect(opening).rejects.toThrow();
    await entered.promise;
    await f.gateway.close();
    release.resolve();
    await rejected;
  });

  it("bounds pending viewer opens before their first auth bind finishes", async () => {
    const f = (fixture = await gatewayFixture());
    const held = deferred();
    f.auth.assertLive.mockImplementation(() => held.promise);
    const openings = Array.from({ length: 4 }, () => f.open());
    const rejections = openings.map((opening) => expect(opening).rejects.toThrow());
    await vi.waitFor(() => expect(f.auth.assertLive).toHaveBeenCalledTimes(4));
    await expect(f.gateway.openViewer("10000000-0000-4000-8000-000000000001")).rejects.toThrow();
    await f.gateway.close();
    held.resolve();
    await Promise.all(rejections);
  });

  it("destroys a stalled viewer when parser plus raw output exceed the frame budget", async () => {
    const f = (fixture = await gatewayFixture());
    const client = await f.attach(await f.open());
    await f.frame(client);
    f.stallOutput(client);
    for (let index = 0; index < 4; index++) {
      client.requestUpdate(false);
      await new Promise((resolve) => setTimeout(resolve, 220));
    }
    expect(client.connected).toBe(false);
    expect(f.gateway.snapshot().closed).toBe(false);
  });

  it("retires a lost auth service while idle and rejects the old agent lease", async () => {
    const f = (fixture = await gatewayFixture());
    const viewer = await f.open();
    await f.gateway.returnToMoss(viewer);
    const client = await f.attach(viewer);
    const lease = f.gateway.acquireAgentLease();
    await f.auth.server.close();
    await vi.waitFor(() => expect(client.connected).toBe(false));
    expect(f.gateway.snapshot().mode).toBe("paused");
    await expect(
      f.gateway.dispatchAgent(lease, { type: "key", keysym: 65, down: true })
    ).rejects.toThrow();
    expect(f.events).toEqual([]);
  });

  it("fences queued input immediately when active auth is revoked", async () => {
    const f = (fixture = await gatewayFixture());
    const viewer = await f.open();
    await f.gateway.takeOver(viewer);
    const client = await f.attach(viewer, true);
    const held = deferred();
    f.auth.assertLive.mockImplementation(() => held.promise);
    f.auth.assertLive.mockClear();
    client.keyEvent(65, true);
    await vi.waitFor(() => expect(f.auth.assertLive).toHaveBeenCalled());
    f.auth.invalidations.invalidate({ actorUserId: binding().actorUserId, sessionId: SESSION });
    await vi.waitFor(() => expect(f.gateway.snapshot().mode).toBe("paused"));
    held.resolve();
    await tick();
    expect(f.events).toEqual([]);
  });

  it("closes the core when a frame response misses its deadline", async () => {
    const f = (fixture = await gatewayFixture());
    await vi.waitFor(() => expect(f.gateway.snapshot().frameReady).toBe(true));
    f.noFrames();
    await vi.waitFor(() => expect(f.gateway.snapshot().closed).toBe(true), { timeout: 2700 });
  });

  it("requires a complete first frame before reporting readiness", async () => {
    const f = (fixture = await gatewayFixture({ partialFirstFrame: true }));
    await vi.waitFor(() => expect(f.gateway.snapshot().closed).toBe(true));
    expect(f.gateway.snapshot().frameReady).toBe(false);
  });

  it("rejects an unsolicited guest frame between its own requests", async () => {
    const f = (fixture = await gatewayFixture());
    await vi.waitFor(() => expect(f.gateway.snapshot().frameReady).toBe(true));
    f.noFrames();
    f.sendFrame();
    await vi.waitFor(() => expect(f.gateway.snapshot().closed).toBe(true));
  });

  it("rejects unsupported viewer formats and closes on guest loss", async () => {
    const f = (fixture = await gatewayFixture());
    const viewer = await f.open();
    const client = await f.attach(viewer);
    const format = Buffer.alloc(20); // Standard SetPixelFormat, RGB565.
    format.set([16, 16, 0, 1, 0, 31, 0, 63, 0, 31, 11, 5, 0], 4);
    client.stream!.write(format);
    await vi.waitFor(() => expect(client.connected).toBe(false));
    f.upstream.destroy();
    await vi.waitFor(() => expect(f.gateway.snapshot().closed).toBe(true));
  });
});
