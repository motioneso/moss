import { describe, expect, it, vi } from "vitest";

import { createMcpConnectionCache } from "@moss/integrations";

function clock(startMs = 0) {
  let ms = startMs;
  return { now: () => ms, advance: (deltaMs: number) => (ms += deltaMs) };
}

function fakeClient(overrides?: { call?: () => Promise<string> }) {
  const close = vi.fn(async () => {});
  const call = vi.fn(overrides?.call ?? (async () => "ok"));
  return { close, call };
}

/**
 * A client shaped like the SDK's: `transport` is set while connected and becomes undefined once
 * the socket has dropped under it. `drop()` simulates that happening between calls.
 */
function fakeClientWithTransport() {
  const close = vi.fn(async () => {});
  const call = vi.fn(async () => "ok");
  const client = { close, call, transport: {} as unknown, drop: () => {} };
  client.drop = () => {
    client.transport = undefined;
  };
  return client;
}

/** A client that answers fine once (so it gets held), then fails mid-call on the next reuse. */
function fakeClientThatFailsMidCallOnSecondUse() {
  const close = vi.fn(async () => {});
  const call = vi.fn(async () => {
    if (call.mock.calls.length > 1) throw new Error("connection reset mid-call");
    return "ok";
  });
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

  it("reconnects when a held client is found dead BEFORE the call is sent", async () => {
    const cache = createMcpConnectionCache();
    const dropped = fakeClientWithTransport();
    const healthy = fakeClientWithTransport();
    const connect = vi
      .fn(async () => dropped)
      .mockResolvedValueOnce(dropped)
      .mockResolvedValueOnce(healthy);

    // First call succeeds and the client is held. The socket then drops while idle. The second
    // call must notice before sending anything and reconnect transparently.
    await cache.withClient("user-1", "conn-1", connect, (c) => c.call());
    dropped.drop();
    const result = await cache.withClient("user-1", "conn-1", connect, (c) => c.call());

    expect(result).toBe("ok");
    expect(connect).toHaveBeenCalledTimes(2);
    expect(dropped.call).toHaveBeenCalledTimes(1); // nothing was sent on the dead client
    expect(healthy.call).toHaveBeenCalledTimes(1);
    expect(dropped.close).toHaveBeenCalledTimes(1);
  });

  it("surfaces a failure DURING a reused call as an error and never re-runs the tool call", async () => {
    const cache = createMcpConnectionCache();
    const held = fakeClientThatFailsMidCallOnSecondUse();
    const healthy = fakeClient();
    const connect = vi
      .fn(async () => held)
      .mockResolvedValueOnce(held)
      .mockResolvedValueOnce(healthy);

    // The remote may already have acted (email sent, ticket created) before the reply was lost.
    // A hidden retry on a fresh connection would run that action a second time.
    await cache.withClient("user-1", "conn-1", connect, (c) => c.call());
    await expect(cache.withClient("user-1", "conn-1", connect, (c) => c.call())).rejects.toThrow(
      "connection reset mid-call"
    );

    expect(held.call).toHaveBeenCalledTimes(2); // once per withClient — the failing call ran exactly once
    expect(connect).toHaveBeenCalledTimes(1); // no fresh connection was opened for a retry
    expect(held.close).toHaveBeenCalledTimes(1); // the dead connection was evicted

    // The next call starts clean on a new connection rather than reusing the evicted one.
    await cache.withClient("user-1", "conn-1", connect, (c) => c.call());
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("lets a genuinely fresh connection's call error propagate without a hidden retry", async () => {
    const cache = createMcpConnectionCache();
    const client = fakeClient({
      call: async () => {
        throw new Error("bad tool arguments");
      }
    });
    const connect = vi.fn(async () => client);

    await expect(cache.withClient("user-1", "conn-1", connect, (c) => c.call())).rejects.toThrow(
      "bad tool arguments"
    );
    expect(connect).toHaveBeenCalledTimes(1);
  });
});
