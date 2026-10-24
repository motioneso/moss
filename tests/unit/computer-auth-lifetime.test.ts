import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectComputerAuth } from "../../apps/api/src/computer/auth-client.js";
import { isRecord } from "../../apps/api/src/computer/host-contract.js";
import {
  authFixture,
  binding,
  deferred,
  fakeAuthServer,
  liveFrame,
  OWNER,
  SESSION,
  tick
} from "./computer-auth-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const close of cleanups.splice(0)) await close();
});

describe("Computer auth active lifetime", () => {
  it("polls while idle and closes at the two-second outstanding-check deadline", async () => {
    const checked = vi.fn();
    const invalidated = vi.fn();
    const server = await fakeAuthServer((value, channel) => {
      if (!isRecord(value)) return;
      if (value.type === "bind") channel.send(liveFrame(value.requestId));
      else checked();
    });
    cleanups.push(() => server.close());
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"]
    });
    const client = await connectComputerAuth({
      socketPath: server.socketPath,
      viewerId: randomUUID(),
      ownerUserId: OWNER,
      onInvalidate: invalidated
    });
    await vi.advanceTimersByTimeAsync(2000);
    await vi.waitFor(() => expect(checked).toHaveBeenCalledTimes(1), { timeout: 200 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(invalidated).toHaveBeenCalledTimes(1);
    await expect(client.assertLive({ actorUserId: OWNER, sessionId: SESSION })).rejects.toThrow();
  });

  it("expires idle clients absolutely even with successful fresh replies", async () => {
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"]
    });
    const b = binding(SESSION, Date.now() + 1000);
    const server = await fakeAuthServer((value, channel) => {
      if (isRecord(value)) channel.send(liveFrame(value.requestId, b));
    });
    cleanups.push(() => server.close());
    const lost = vi.fn();
    const client = await connectComputerAuth({
      socketPath: server.socketPath,
      viewerId: randomUUID(),
      ownerUserId: OWNER,
      onInvalidate: lost
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(lost).toHaveBeenCalledTimes(1);
    await expect(client.assertLive({ actorUserId: OWNER, sessionId: SESSION })).rejects.toThrow();
  });

  it("bounds initial bind authorization and never accepts its late completion", async () => {
    const f = await authFixture();
    cleanups.push(() => f.close());
    const started = deferred();
    const held = deferred();
    f.assertLive.mockImplementation(() => {
      started.resolve();
      return held.promise;
    });
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"]
    });
    const result = f.connect();
    const assertion = expect(result).rejects.toThrow();
    await started.promise;
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
    held.resolve();
    await tick();
    expect(f.assertLive).toHaveBeenCalledTimes(1);
  });

  it("rechecks the lifetime after a correlated success immediately followed by invalidation", async () => {
    const b = binding();
    const lost = vi.fn();
    const server = await fakeAuthServer((value, channel) => {
      if (!isRecord(value)) return;
      if (value.type === "bind") channel.send(liveFrame(value.requestId, b));
      else
        channel.socket.write(
          JSON.stringify(liveFrame(value.requestId, b)) +
            "\n" +
            JSON.stringify({ type: "ended" }) +
            "\n"
        );
    });
    cleanups.push(() => server.close());
    const client = await connectComputerAuth({
      socketPath: server.socketPath,
      viewerId: randomUUID(),
      ownerUserId: OWNER,
      onInvalidate: lost
    });
    await expect(client.assertLive({ actorUserId: OWNER, sessionId: SESSION })).rejects.toThrow();
    expect(lost).toHaveBeenCalledTimes(1);
  });

  it("retires after service disconnect with no automatic reconnect", async () => {
    const f = await authFixture();
    cleanups.push(() => f.close());
    const lost = deferred();
    const client = await f.connect(binding(), vi.fn(lost.resolve));
    await f.server.close();
    await lost.promise;
    await expect(client.assertLive({ actorUserId: OWNER, sessionId: SESSION })).rejects.toThrow();
    expect(f.assertLive).toHaveBeenCalledTimes(1);
  });

  it("bounds concurrent client checks and permanently rejects overflow", async () => {
    const server = await fakeAuthServer((value, channel) => {
      if (isRecord(value) && value.type === "bind") channel.send(liveFrame(value.requestId));
    });
    cleanups.push(() => server.close());
    const lost = vi.fn();
    const client = await connectComputerAuth({
      socketPath: server.socketPath,
      viewerId: randomUUID(),
      ownerUserId: OWNER,
      onInvalidate: lost
    });
    const results = Array.from({ length: 33 }, () =>
      client.assertLive({ actorUserId: OWNER, sessionId: SESSION })
    );
    const settled = await Promise.allSettled(results);
    expect(settled.every((result) => result.status === "rejected")).toBe(true);
    expect(lost).toHaveBeenCalledTimes(1);
  });
});
