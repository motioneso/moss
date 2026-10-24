import { afterEach, describe, expect, it, vi } from "vitest";
import { ComputerInputDenied } from "../../apps/api/src/computer/input-control.js";
import { ComputerRfbInputWriter } from "../../apps/api/src/computer/rfb-input-writer.js";
import { binding, deferred, fencePacket, rfbFixture, tick } from "./computer-rfb-fixture.js";

const fixtures: Awaited<ReturnType<typeof rfbFixture>>[] = [];
async function fixture(timeoutMs?: number) {
  const result = await rfbFixture(timeoutMs);
  fixtures.push(result);
  return result;
}
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.dispose()));
});
const key = (keysym: number, down = true) => ({ type: "key" as const, keysym, down });

describe("Computer RFB receiving input", () => {
  it("never upgrades a watcher parser, and sends owner input through the sole guest writer", async () => {
    const f = await fixture();
    const viewer = await f.receiver.connect(binding());
    const watcher = await f.attach(viewer);
    watcher.keyEvent(65, true);
    await tick();
    expect(f.events).toEqual([]);
    await f.receiver.takeOver(viewer);
    watcher.keyEvent(66, true);
    const owner = await f.attach(viewer, true);
    owner.keyEvent(67, true);
    owner.pointerEvent(10, 20, 1);
    owner.updateClipboard("must not reach guest");
    await tick();
    expect(f.events.filter((e) => e[0] !== "fence")).toEqual([
      ["key", 67, true],
      ["pointer", 10, 20, 1]
    ]);
    await f.receiver.returnToMoss(viewer);
    expect(f.events.slice(-3).map((e) => e.slice(0, 4))).toEqual([
      ["key", 67, false],
      ["pointer", 10, 20, 0],
      ["fence", f.fences.at(-1)?.toString("hex")]
    ]);
    expect(owner.closed).toBe(true);
  });

  it("fences old agent leases and resumes only a fresh lease after intentional controlling close", async () => {
    const f = await fixture();
    const viewer = await f.receiver.connect(binding());
    await f.receiver.returnToMoss(viewer);
    const stale = f.receiver.acquireAgentLease("owner");
    await f.receiver.dispatchAgent(stale, key(65));
    await f.receiver.takeOver(viewer);
    const client = await f.attach(viewer, true);
    client.keyEvent(66, true);
    await tick();
    await f.receiver.closeViewer(viewer);
    await expect(f.receiver.dispatchAgent(stale, key(67))).rejects.toThrow();
    await f.receiver.dispatchAgent(f.receiver.acquireAgentLease("owner"), key(68));
    await tick();
    expect(f.events.filter((e) => e[0] === "key")).toEqual([
      ["key", 65, true],
      ["key", 65, false],
      ["key", 66, true],
      ["key", 66, false],
      ["key", 68, true]
    ]);
  });

  it("invalidates delayed and queued input even if authority later returns to Moss", async () => {
    const f = await fixture();
    const viewer = await f.receiver.connect(binding());
    await f.receiver.returnToMoss(viewer);
    const lease = f.receiver.acquireAgentLease("owner");
    const gate = deferred();
    f.assertLive.mockImplementationOnce(() => gate.promise);
    const delayed = f.receiver.dispatchAgent(lease, key(70)).catch((e: unknown) => e);
    const queued = f.receiver.dispatchAgent(lease, key(71)).catch((e: unknown) => e);
    await tick();
    await f.receiver.takeOver(viewer);
    await f.receiver.returnToMoss(viewer);
    gate.resolve();
    expect(await delayed).toBeInstanceOf(ComputerInputDenied);
    expect(await queued).toBeInstanceOf(ComputerInputDenied);
    expect(f.events.some((e) => e[0] === "key")).toBe(false);
  });

  it("keeps admission closed when an older post-barrier authorization finishes during a newer handoff", async () => {
    const f = await fixture();
    const viewer = await f.receiver.connect(binding());
    const gate = deferred();
    const entered = deferred();
    f.assertLive
      .mockImplementationOnce(async () => undefined)
      .mockImplementationOnce(() => {
        entered.resolve();
        return gate.promise;
      });
    const old = f.receiver.takeOver(viewer).catch((e: unknown) => e);
    await entered.promise;
    expect(f.assertLive).toHaveBeenCalledTimes(3);
    f.holdFences();
    const newer = f.receiver.returnToMoss(viewer);
    await tick();
    gate.resolve();
    expect(await old).toBeInstanceOf(ComputerInputDenied);
    expect(f.receiver.snapshot().receivingReady).toBe(false);
    f.acknowledge(f.fences.at(-1)!);
    await newer;
    expect(f.receiver.snapshot().receivingReady).toBe(true);
  });

  it("keeps an old completion closed across receiver-only parser replacement", async () => {
    const f = await fixture();
    const viewer = await f.receiver.connect(binding());
    await f.receiver.takeOver(viewer);
    await f.attach(viewer, true);
    const gate = deferred();
    const entered = deferred();
    f.assertLive
      .mockImplementationOnce(async () => undefined)
      .mockImplementationOnce(() => {
        entered.resolve();
        return gate.promise;
      });
    // Reaffirming the same owner leaves the policy generation unchanged.
    const old = f.receiver.takeOver(viewer).catch((e: unknown) => e);
    await entered.promise;
    f.holdFences();
    const replacement = f.attach(viewer, true);
    await tick();
    gate.resolve();
    const oldResult = await old;
    expect(f.receiver.snapshot().receivingReady).toBe(false);
    expect(oldResult).toBeInstanceOf(ComputerInputDenied);
    f.acknowledge(f.fences.at(-1)!);
    await replacement;
    expect(f.receiver.snapshot().receivingReady).toBe(true);
  });

  it("rejects a fresh post-Fence session denial before opening admission", async () => {
    const f = await fixture(80);
    const viewer = await f.receiver.connect(binding());
    f.holdFences();
    const takeover = f.receiver.takeOver(viewer).catch((e: unknown) => e);
    await tick();
    f.assertLive.mockRejectedValueOnce(new Error("revoked after Fence request"));
    f.acknowledge(f.fences.at(-1)!);
    expect(await takeover).toBeInstanceOf(Error);
    expect(f.receiver.snapshot()).toMatchObject({ mode: "paused", receivingReady: false });
  });

  it("rejects owner events queued before the same viewer later regains control", async () => {
    const f = await fixture();
    const viewer = await f.receiver.connect(binding());
    await f.receiver.takeOver(viewer);
    const client = await f.attach(viewer, true);
    const gate = deferred();
    const entered = deferred();
    f.assertLive.mockImplementationOnce(() => {
      entered.resolve();
      return gate.promise;
    });
    client.keyEvent(70, true);
    client.keyEvent(71, true);
    await entered.promise;
    await tick();
    await f.receiver.returnToMoss(viewer);
    await f.receiver.takeOver(viewer);
    gate.resolve();
    await tick();
    expect(f.events.some((e) => e[0] === "key")).toBe(false);
  });

  it("fences queued input and releases keys when replacing a controller parser", async () => {
    const f = await fixture();
    const viewer = await f.receiver.connect(binding());
    await f.receiver.takeOver(viewer);
    const previous = await f.attach(viewer, true);
    previous.keyEvent(65, true);
    await tick();
    const gate = deferred();
    const entered = deferred();
    f.assertLive.mockImplementationOnce(() => {
      entered.resolve();
      return gate.promise;
    });
    previous.keyEvent(70, true);
    await entered.promise;
    const replacement = await f.attach(viewer, true);
    expect(previous.closed).toBe(true);
    expect(f.events).toContainEqual(["key", 65, false]);
    gate.resolve();
    await tick();
    expect(f.events).not.toContainEqual(["key", 70, true]);
    replacement.keyEvent(71, true);
    await tick();
    expect(f.events).toContainEqual(["key", 71, true]);
  });

  it("does not admit input before remote acknowledgement", async () => {
    const f = await fixture();
    const viewer = await f.receiver.connect(binding());
    f.holdFences();
    const takeover = f.receiver.takeOver(viewer);
    await tick();
    expect(f.receiver.snapshot().receivingReady).toBe(false);
    await expect(f.attach(viewer, true)).rejects.toThrow();
    f.acknowledge(f.fences.at(-1)!);
    await takeover;
    expect(f.receiver.snapshot().receivingReady).toBe(true);
  });

  it("waits for the remote fence, releases keys on loss, and reconnects watching", async () => {
    const f = await fixture();
    const viewer = await f.receiver.connect(binding());
    await f.receiver.takeOver(viewer);
    const owner = await f.attach(viewer, true);
    owner.keyEvent(70, true);
    await tick();
    owner.destroy();
    await tick();
    expect(f.receiver.snapshot()).toMatchObject({ mode: "paused", receivingReady: false });
    expect(f.events).toContainEqual(["key", 70, false]);
    const replacement = await f.receiver.connect(binding());
    const watching = await f.attach(replacement);
    watching.keyEvent(71, true);
    await tick();
    expect(f.events).not.toContainEqual(["key", 71, true]);
  });

  it("does not interrupt active control when an unrelated watcher closes", async () => {
    const f = await fixture();
    const owner = await f.receiver.connect(binding());
    const watcher = await f.receiver.connect(binding("other"));
    await f.receiver.takeOver(owner);
    const client = await f.attach(owner, true);
    const fences = f.fences.length;
    await f.receiver.closeViewer(watcher);
    client.keyEvent(71, true);
    await tick();
    expect(f.fences).toHaveLength(fences);
    expect(f.events).toContainEqual(["key", 71, true]);
    expect(f.receiver.snapshot().receivingReady).toBe(true);
  });

  it("fails foreign/expired identity and revokes retained agent authority", async () => {
    const f = await fixture();
    await expect(f.receiver.connect(binding("foreign", "foreign"))).rejects.toThrow();
    await expect(
      f.receiver.connect({ ...binding(), expiresAt: new Date("2020-01-01") })
    ).rejects.toThrow();
    const viewer = await f.receiver.connect(binding());
    await f.receiver.returnToMoss(viewer);
    const lease = f.receiver.acquireAgentLease("owner");
    f.receiver.disconnect(viewer);
    await f.receiver.dispatchAgent(lease, key(65));
    f.receiver.invalidateSession("session");
    await expect(f.receiver.dispatchAgent(lease, key(66))).rejects.toThrow();
    await tick();
    expect(f.events).toContainEqual(["key", 65, false]);
    expect(f.receiver.snapshot()).toMatchObject({ mode: "paused", receivingReady: false });
  });

  it("invalidates input on fresh liveness denial", async () => {
    const f = await fixture();
    const viewer = await f.receiver.connect(binding());
    await f.receiver.returnToMoss(viewer);
    const lease = f.receiver.acquireAgentLease("owner");
    await f.receiver.dispatchAgent(lease, key(65));
    f.assertLive.mockRejectedValueOnce(new Error("revoked"));
    await expect(f.receiver.dispatchAgent(lease, key(66))).rejects.toThrow();
    await tick();
    expect(f.receiver.snapshot().receivingReady).toBe(false);
    expect(f.events).not.toContainEqual(["key", 66, true]);
  });

  it.each(["payload", "flags", "timeout"])("fails closed on invalid Fence %s", async (fault) => {
    const f = await fixture(80);
    const viewer = await f.receiver.connect(binding());
    f.holdFences();
    const takeover = f.receiver.takeOver(viewer).catch((e: unknown) => e);
    await tick();
    if (fault === "payload") f.guest.write(fencePacket(1, Buffer.from("wrong")));
    if (fault === "flags") f.acknowledge(f.fences.at(-1)!, 0);
    expect(await takeover).toBeInstanceOf(Error);
    expect(f.receiver.snapshot()).toMatchObject({ closed: true, receivingReady: false });
  });

  it("requires upstream Fence support", async () => {
    const f = await fixture();
    f.upstream.supports.fence = false;
    expect(() => new ComputerRfbInputWriter(f.upstream, 100, vi.fn())).toThrow();
  });

  it.each([65536, 65537])("bounds actual stalled upstream backlog at %i bytes", async (bytes) => {
    const f = await fixture();
    const viewer = await f.receiver.connect(binding());
    await f.receiver.returnToMoss(viewer);
    const lease = f.receiver.acquireAgentLease("owner");
    f.stall();
    f.proxy.write(Buffer.alloc(bytes));
    await expect(f.receiver.dispatchAgent(lease, key(65))).rejects.toThrow();
    expect(f.receiver.snapshot().closed).toBe(true);
  });

  it("bounds queued work without later writes", async () => {
    const f = await fixture(80);
    const viewer = await f.receiver.connect(binding());
    await f.receiver.returnToMoss(viewer);
    const lease = f.receiver.acquireAgentLease("owner");
    const gate = deferred();
    f.assertLive.mockImplementationOnce(() => gate.promise);
    const pending = Array.from({ length: 33 }, () =>
      f.receiver.dispatchAgent(lease, key(65)).catch((e: unknown) => e)
    );
    expect(f.receiver.snapshot().closed).toBe(true);
    gate.resolve();
    expect((await Promise.all(pending)).every((e) => e instanceof Error)).toBe(true);
    expect(f.events.some((e) => e[0] === "key")).toBe(false);
  });

  it("bounds normalized key/pointer values and pressed-key count", async () => {
    const f = await fixture();
    const viewer = await f.receiver.connect(binding());
    await f.receiver.returnToMoss(viewer);
    const lease = f.receiver.acquireAgentLease("owner");
    for (let i = 1; i <= 64; i++) await f.receiver.dispatchAgent(lease, key(i));
    await expect(f.receiver.dispatchAgent(lease, key(65))).rejects.toThrow();
    expect(f.receiver.snapshot().closed).toBe(true);
  });

  it.each([
    key(0),
    key(Number.NaN),
    { type: "pointer" as const, x: -1, y: 0, buttons: 0 },
    { type: "pointer" as const, x: 1280, y: 0, buttons: 0 },
    { type: "pointer" as const, x: 0, y: 800, buttons: 0 },
    { type: "pointer" as const, x: 0, y: 0, buttons: 128 }
  ])("rejects out-of-contract normalized input %j", async (event) => {
    const f = await fixture();
    const viewer = await f.receiver.connect(binding());
    await f.receiver.returnToMoss(viewer);
    await expect(
      f.receiver.dispatchAgent(f.receiver.acquireAgentLease("owner"), event)
    ).rejects.toThrow();
    await tick();
    expect(f.events.some((e) => e[0] === "key" || e[0] === "pointer")).toBe(false);
  });

  it("bounds a stalled authorization and fences its late completion", async () => {
    const f = await fixture(80);
    const viewer = await f.receiver.connect(binding());
    await f.receiver.returnToMoss(viewer);
    const lease = f.receiver.acquireAgentLease("owner");
    const gate = deferred();
    f.assertLive.mockImplementationOnce(() => gate.promise);
    await expect(f.receiver.dispatchAgent(lease, key(65))).rejects.toThrow();
    gate.resolve();
    await tick();
    expect(f.receiver.snapshot().closed).toBe(true);
    expect(f.events.some((e) => e[0] === "key")).toBe(false);
  });

  it("bounds parser ingress and watcher count", async () => {
    const f = await fixture();
    const viewer = await f.receiver.connect(binding());
    const watching = await f.attach(viewer);
    for (let i = 0; i < 8300; i++) watching.keyEvent(65, true);
    await tick();
    expect(watching.closed).toBe(true);
    expect(f.events).toEqual([]);
    for (let i = 0; i < 4; i++) await f.attach(viewer);
    await expect(f.attach(viewer)).rejects.toThrow();
  });

  it("graceful shutdown releases keys before the final receiving barrier", async () => {
    const f = await fixture();
    const viewer = await f.receiver.connect(binding());
    await f.receiver.returnToMoss(viewer);
    await f.receiver.dispatchAgent(f.receiver.acquireAgentLease("owner"), key(65));
    await f.receiver.close();
    expect(f.events.slice(-2)).toEqual([
      ["key", 65, false],
      ["fence", f.fences.at(-1)?.toString("hex")]
    ]);
  });
});
