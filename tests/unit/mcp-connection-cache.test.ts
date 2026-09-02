import { describe, expect, it, vi } from "vitest";

import { createMcpConnectionCache } from "@moss/integrations";

function clock(startMs = 0) {
  let ms = startMs;
  return { now: () => ms, advance: (deltaMs: number) => (ms += deltaMs) };
}

function fakeClient(overrides?: { call?: () => Promise<string> }) {
  const close = vi.fn(async () => {});
  const call = overrides?.call ?? (async () => "ok");
  return { close, call };
}

/** A client that answers fine once (so it gets held), then goes stale on the next reuse. */
function fakeClientThatGoesStaleAfterOneUse() {
  let uses = 0;
  const close = vi.fn(async () => {});
  const call = async () => {
    uses += 1;
    if (uses > 1) throw new Error("connection reset");
    return "ok";
  };
  return { close, call };
}

describe("createMcpConnectionCache", () => {
  it("reuses the same client across calls inside the quiet window", async () => {
    const cache = createMcpConnectionCache();
    const client = fakeClient();
    const connect = vi.fn(async () => client);

    await cache.withClient("user-1", "conn-1", connect, (c) => c.call());
    await cache.withClient("user-1", "conn-1", connect, (c) => c.call());

    expect(connect).toHaveBeenCalledTimes(1);
    expect(client.close).not.toHaveBeenCalled();
  });

  it("never shares a held client across two different users", async () => {
    const cache = createMcpConnectionCache();
    const clientA = fakeClient();
    const clientB = fakeClient();
    const connect = vi
      .fn(async () => clientA)
      .mockResolvedValueOnce(clientA)
      .mockResolvedValueOnce(clientB);

    await cache.withClient("user-a", "conn-1", connect, (c) => c.call());
    await cache.withClient("user-b", "conn-1", connect, (c) => c.call());

    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("reconnects once a held client has gone quiet past the window, and closes the old one", async () => {
    const time = clock();
    const cache = createMcpConnectionCache({ now: time.now, windowMs: 30_000 });
    const first = fakeClient();
    const second = fakeClient();
    const connect = vi
      .fn(async () => first)
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);

    await cache.withClient("user-1", "conn-1", connect, (c) => c.call());
    time.advance(30_001);
    await cache.withClient("user-1", "conn-1", connect, (c) => c.call());

    expect(connect).toHaveBeenCalledTimes(2);
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(second.close).not.toHaveBeenCalled();
  });

  it("never closes a client that is still mid-call, even once it has gone quiet", async () => {
    const time = clock();
    const cache = createMcpConnectionCache({ now: time.now, windowMs: 30_000 });
    const client = fakeClient();
    const connect = vi.fn(async () => client);

    let releaseFirstCall: () => void = () => {};
    const firstCallStarted = new Promise<void>((resolve) => {
      releaseFirstCall = resolve;
    });
    const first = cache.withClient("user-1", "conn-1", connect, async (c) => {
      await firstCallStarted;
      return c.call();
    });
    // Let the first call actually reach the "in flight" state (client held, fn started) before
    // the second call's expiry check can race it.
    await Promise.resolve();
    await Promise.resolve();

    // A second call for the same key arrives while the first is still in flight, and the window
    // has already gone quiet by the time it checks. The in-flight client must not be closed here.
    time.advance(30_001);
    const secondClient = fakeClient();
    connect.mockResolvedValueOnce(secondClient);
    const second = cache.withClient("user-1", "conn-1", connect, (c) => c.call());

    releaseFirstCall();
    await Promise.all([first, second]);

    expect(client.close).toHaveBeenCalledTimes(1); // closed only after the in-flight call returned
  });

  it("treats a broken held client as a reconnect, not an error", async () => {
    const cache = createMcpConnectionCache();
    const wentStale = fakeClientThatGoesStaleAfterOneUse();
    const healthy = fakeClient();
    const connect = vi
      .fn(async () => wentStale)
      .mockResolvedValueOnce(wentStale)
      .mockResolvedValueOnce(healthy);

    // First call succeeds and the client is held. Second call reuses it, finds it broken, and
    // must reconnect to a fresh client transparently rather than surfacing the failure.
    await cache.withClient("user-1", "conn-1", connect, (c) => c.call());
    const result = await cache.withClient("user-1", "conn-1", connect, (c) => c.call());

    expect(result).toBe("ok");
    expect(connect).toHaveBeenCalledTimes(2);
    expect(wentStale.close).toHaveBeenCalledTimes(1);
  });

  it("lets a genuinely fresh connection's call error propagate without a hidden retry", async () => {
    const cache = createMcpConnectionCache();
    const client = fakeClient({
      call: async () => {
        throw new Error("bad tool arguments");
      }
    });
    const connect = vi.fn(async () => client);

    await expect(
      cache.withClient("user-1", "conn-1", connect, (c) => c.call())
    ).rejects.toThrow("bad tool arguments");
    expect(connect).toHaveBeenCalledTimes(1);
  });
});
