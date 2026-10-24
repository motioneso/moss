import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmod, lstat } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serveComputerAuth } from "../../apps/api/src/computer/auth-server.js";
import { connectComputerAuth } from "../../apps/api/src/computer/auth-client.js";
import { ComputerInputControl } from "../../apps/api/src/computer/input-control.js";
import { ComputerAuthChannel } from "../../apps/api/src/computer/auth-channel.js";
import { isRecord } from "../../apps/api/src/computer/host-contract.js";
import {
  authFixture,
  bindFrame,
  binding,
  deferred,
  fakeAuthServer,
  FOREIGN,
  liveFrame,
  OWNER,
  SESSION,
  tick
} from "./computer-auth-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("Computer private auth IPC", () => {
  it("issues owner metadata once and freshly checks each operation over a real Unix socket", async () => {
    const f = await authFixture();
    cleanups.push(() => f.close());
    const b = binding();
    const client = await f.connect(b);
    expect(client.binding).toEqual(b);
    expect((await lstat(f.socketPath)).mode & 0o777).toBe(0o600);
    await client.assertLive({ actorUserId: OWNER, sessionId: SESSION });
    expect(f.assertLive).toHaveBeenCalledTimes(2);
    expect(f.assertLive).toHaveBeenLastCalledWith({ actorUserId: OWNER, sessionId: SESSION });
    // Caller changes to the exposed Date cannot extend the private deadline.
    client.binding.expiresAt.setFullYear(2040);
    expect(client.binding).toEqual(b);
    expect(() => f.server.issue({ ...b, actorUserId: FOREIGN })).toThrow();
    expect(() => f.server.issue({ ...b, expiresAt: new Date(Date.now()) })).toThrow();
  });

  it("pushes revocation to an idle active policy and fences its old lease", async () => {
    const f = await authFixture();
    cleanups.push(() => f.close());
    const invalidated = vi.fn();
    const control = new ComputerInputControl({
      ownerUserId: OWNER,
      sessions: { assertLive: (input) => client.assertLive(input) },
      now: () => new Date()
    });
    const client = await f.connect(
      binding(),
      vi.fn(() => {
        control.invalidateSession(SESSION);
        invalidated();
      })
    );
    const viewer = await control.connect(client.binding);
    await control.returnToMoss(viewer);
    const lease = control.acquireAgentLease(OWNER);
    const writes = vi.fn<() => undefined>(() => undefined);
    f.invalidations.invalidate({ actorUserId: OWNER, sessionId: SESSION });
    await vi.waitFor(() => expect(invalidated).toHaveBeenCalledTimes(1), { timeout: 200 });
    expect(control.snapshot().mode).toBe("paused");
    await expect(control.dispatchAgent(lease, writes)).rejects.toThrow();
    expect(writes).not.toHaveBeenCalled();
    await expect(client.assertLive({ actorUserId: OWNER, sessionId: SESSION })).rejects.toThrow();
  });

  it("preserves unrelated sessions and the revokeOthers exception", async () => {
    const f = await authFixture();
    cleanups.push(() => f.close());
    const firstEnded = vi.fn();
    const secondEnded = deferred();
    const first = await f.connect(binding(), firstEnded);
    const secondSession = randomUUID();
    await f.connect(binding(secondSession), vi.fn(secondEnded.resolve));
    f.invalidations.invalidate({ actorUserId: FOREIGN });
    f.invalidations.invalidate({ actorUserId: OWNER, sessionId: randomUUID() });
    await first.assertLive({ actorUserId: OWNER, sessionId: SESSION });
    expect(firstEnded).not.toHaveBeenCalled();
    f.invalidations.invalidate({ actorUserId: OWNER, exceptSessionId: SESSION });
    await secondEnded.promise;
    await first.assertLive({ actorUserId: OWNER, sessionId: SESSION });
    expect(firstEnded).not.toHaveBeenCalled();
  });

  it("never accepts a delayed authorization after server-side retirement", async () => {
    const f = await authFixture();
    cleanups.push(() => f.close());
    const held = deferred();
    const started = deferred();
    f.assertLive.mockImplementationOnce(() => {
      started.resolve();
      return held.promise;
    });
    const id = f.server.issue(binding());
    const lost = vi.fn();
    const result = connectComputerAuth({
      socketPath: f.socketPath,
      viewerId: id,
      ownerUserId: OWNER,
      onInvalidate: lost
    });
    const assertion = expect(result).rejects.toThrow();
    await started.promise;
    f.invalidations.invalidate({ actorUserId: OWNER, sessionId: SESSION });
    await assertion;
    held.resolve();
    await tick();
    expect(lost).toHaveBeenCalledTimes(1);
    await expect(
      connectComputerAuth({
        socketPath: f.socketPath,
        viewerId: id,
        ownerUserId: OWNER,
        onInvalidate: vi.fn()
      })
    ).rejects.toThrow();
  });

  it("fails closed on fresh denial, substituted identity and auth shutdown", async () => {
    const f = await authFixture();
    cleanups.push(() => f.close());
    const lost = vi.fn();
    const client = await f.connect(binding(), lost);
    f.assertLive.mockRejectedValueOnce(new Error("private database details"));
    await expect(client.assertLive({ actorUserId: OWNER, sessionId: SESSION })).rejects.toThrow(
      "Computer auth unavailable"
    );
    expect(lost).toHaveBeenCalledTimes(1);
    const other = await f.connect();
    await expect(other.assertLive({ actorUserId: FOREIGN, sessionId: SESSION })).rejects.toThrow();
    const ended = deferred();
    await f.connect(binding(), vi.fn(ended.resolve));
    f.invalidations.close();
    await ended.promise;
    expect(() => f.server.issue(binding())).toThrow();
  });

  it("bounds issued bindings, all unbound sockets and their server bind lifetime", async () => {
    const f = await authFixture();
    cleanups.push(() => f.close());
    for (let i = 0; i < 4; i++) f.server.issue(binding());
    expect(() => f.server.issue(binding())).toThrow();
    const sockets = [];
    for (let i = 0; i < 4; i++) sockets.push(await f.raw());
    const extra = await f.raw();
    await once(extra, "close");
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"]
    });
    const closures = sockets.map((socket) => once(socket, "close"));
    // Timers for existing sockets are real; only newly accepted sockets get fake timers below.
    for (const socket of sockets) socket.destroy();
    await Promise.all(closures);
    const unbound = await f.raw();
    const closed = once(unbound, "close");
    await tick();
    await vi.advanceTimersByTimeAsync(2000);
    await closed;
    expect(f.assertLive).not.toHaveBeenCalled();
  });

  it("retains the global actual auth-work bound after sockets retire and reissue", async () => {
    const f = await authFixture();
    cleanups.push(() => f.close());
    const raw = await f.raw();
    const id = f.server.issue(binding());
    raw.write(JSON.stringify(bindFrame(id)) + "\n");
    await once(raw, "data");
    const held = deferred();
    const saturated = deferred();
    let count = 0;
    f.assertLive.mockImplementation(() => {
      if (++count === 32) saturated.resolve();
      return held.promise;
    });
    raw.write(
      Array.from({ length: 32 }, () =>
        JSON.stringify({ type: "check", requestId: randomUUID() })
      ).join("\n") + "\n"
    );
    await saturated.promise;
    const closed = once(raw, "close");
    raw.destroy();
    await closed;
    await tick();
    await expect(f.connect()).rejects.toThrow();
    expect(count).toBe(32);
    held.resolve();
    await tick();
    f.assertLive.mockImplementation(async () => {});
    const recovered = await f.connect();
    await recovered.assertLive({ actorUserId: OWNER, sessionId: SESSION });
  });

  it.each(["correlation", "identity", "expiry", "unknown field"])(
    "rejects hostile %s replies",
    async (fault) => {
      const b = binding();
      const server = await fakeAuthServer((value, channel) => {
        if (!isRecord(value)) return;
        const frame = liveFrame(fault === "correlation" ? randomUUID() : value.requestId, b);
        if (fault === "identity") frame.binding.actorUserId = FOREIGN;
        if (fault === "expiry") frame.binding.expiresAt = Date.now() - 1;
        channel.send(fault === "unknown field" ? { ...frame, cookie: "forbidden" } : frame);
      });
      cleanups.push(() => server.close());
      const lost = vi.fn();
      await expect(
        connectComputerAuth({
          socketPath: server.socketPath,
          viewerId: randomUUID(),
          ownerUserId: OWNER,
          onInvalidate: lost
        })
      ).rejects.toThrow();
      expect(lost).toHaveBeenCalledTimes(1);
    }
  );

  it("rejects malformed, oversized, duplicate and replayed request frames", async () => {
    const f = await authFixture();
    cleanups.push(() => f.close());
    for (const message of [
      "not json\n",
      "x".repeat(4097),
      JSON.stringify({ ...bindFrame(randomUUID()), cookie: "forbidden" }) + "\n"
    ]) {
      const raw = await f.raw();
      const closed = once(raw, "close");
      raw.write(message);
      await closed;
    }
    const raw = await f.raw();
    const id = f.server.issue(binding());
    const frame = JSON.stringify(bindFrame(id)) + "\n";
    raw.write(frame);
    await once(raw, "data");
    const closed = once(raw, "close");
    raw.write(frame);
    await closed;
    await expect(
      connectComputerAuth({
        socketPath: f.socketPath,
        viewerId: id,
        ownerUserId: OWNER,
        onInvalidate: vi.fn()
      })
    ).rejects.toThrow();
  });

  it("bounds real corked writable backlog and fragmented framing", async () => {
    const f = await authFixture();
    cleanups.push(() => f.close());
    const raw = await f.raw();
    const received = vi.fn();
    const channel = new ComputerAuthChannel(raw, received, () => raw.destroy());
    const frame = bindFrame(f.server.issue(binding()));
    const data = JSON.stringify(frame) + "\n";
    raw.write(data.slice(0, 5));
    raw.write(data.slice(5));
    await once(raw, "data");
    expect(received).toHaveBeenCalledWith(expect.objectContaining({ type: "live" }));
    raw.cork();
    expect(() => {
      for (let i = 0; i < 30; i++) channel.send({ padding: "x".repeat(3000) });
    }).toThrow();
    expect(raw.writableLength).toBeLessThanOrEqual(65_536);
    raw.destroy();
  });

  it("refuses unsafe private parents and an existing listener", async () => {
    const f = await authFixture();
    cleanups.push(() => f.close());
    const deps = {
      socketPath: f.socketPath,
      ownerUserId: OWNER,
      invalidations: f.invalidations,
      sessions: { assertLive: f.assertLive }
    };
    await expect(serveComputerAuth(deps)).rejects.toThrow();
    const client = await f.connect();
    await client.assertLive({ actorUserId: OWNER, sessionId: SESSION });
    await chmod(f.root, 0o755);
    await expect(
      serveComputerAuth({ ...deps, socketPath: f.root + "/other.sock" })
    ).rejects.toThrow();
    await chmod(f.root, 0o700);
  });
});
