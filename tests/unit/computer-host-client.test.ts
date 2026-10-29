import { afterEach, describe, expect, it, vi } from "vitest";
import { ComputerHostClient } from "../../apps/api/src/computer/host-client.js";
import { binding, FOREIGN, hostFixture, NOW, OWNER } from "./computer-host-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const close of cleanups.splice(0)) await close();
});

describe("Computer host trusted API client", () => {
  it("freshly checks owner session for status and every mutation, never forwards credentials", async () => {
    const f = await hostFixture();
    cleanups.push(() => f.close());
    await f.client.request(binding(), "status", 0);
    await f.client.request(binding(), "enable", 0);
    expect(f.assertLive).toHaveBeenCalledTimes(2);
    expect(f.assertLive).toHaveBeenLastCalledWith({
      actorUserId: OWNER,
      sessionId: binding().sessionId
    });
    expect(f.store.state.generation).toBe(1);
    await expect(f.client.request(binding(FOREIGN), "disable", 1)).rejects.toThrow();
    expect(f.assertLive).toHaveBeenCalledTimes(2);
    expect(f.store.state.generation).toBe(1);
  });

  it("denied/expired session never reaches host control", async () => {
    const f = await hostFixture();
    cleanups.push(() => f.close());
    f.assertLive.mockRejectedValueOnce(new Error("revoked"));
    await expect(f.client.request(binding(), "enable", 0)).rejects.toThrow();
    await expect(
      f.client.request({ ...binding(), expiresAt: new Date(NOW) }, "enable", 0)
    ).rejects.toThrow();
    expect(f.store.state.generation).toBe(0);
    expect(f.calls).toHaveLength(0);
  });

  it("bounds auth waits and a late result cannot dispatch a host operation", async () => {
    const f = await hostFixture();
    cleanups.push(() => f.close());
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sessions = { assertLive: () => pending };
    const client = new ComputerHostClient({
      socketPath: f.socketPath,
      ownerUserId: OWNER,
      sessions,
      now: () => new Date(NOW)
    });
    vi.useFakeTimers();
    const result = client.request(binding(), "enable", 0);
    const assertion = expect(result).rejects.toThrow("Computer owner session unavailable");
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
    release();
    await pending;
    expect(f.store.state.generation).toBe(0);
    expect(f.calls).toHaveLength(0);
  });

  it("expiry during fresh auth prevents sending the operation", async () => {
    const f = await hostFixture();
    cleanups.push(() => f.close());
    let now = NOW;
    const client = new ComputerHostClient({
      socketPath: f.socketPath,
      ownerUserId: OWNER,
      sessions: {
        async assertLive() {
          now += 60_000;
        }
      },
      now: () => new Date(now)
    });
    await expect(client.request(binding(), "enable", 0)).rejects.toThrow();
    expect(f.store.state.generation).toBe(0);
  });
});
