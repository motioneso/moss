import { Duplex } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RpcConnection } from "../../packages/chat/src/live/chat-engine-rpc-client.js";
import { decodeFrame } from "../../packages/chat/src/live/rpc-contract.js";

// A hung byte transport exercises the real client framing and pending map without binding a
// socket (sandboxed CI may prohibit listen). Real Unix-socket coverage lives in chat-rpc-client.
function hungTransport() {
  const requests: { method: string; params: unknown }[] = [];
  const socket = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      const decoded = decodeFrame(chunk);
      if (decoded.kind !== "frame") throw new Error("Expected an encoded RPC frame");
      requests.push(JSON.parse(decoded.body.toString("utf8")));
      callback(); // Accept bytes, but never produce a response.
    }
  });
  const connection = new RpcConnection({
    socketPath: "/unused",
    rpcSecret: "fixture",
    callTimeoutMs: 0
  });
  Object.assign(connection, { state: "ready", socket });
  const pending = (connection as unknown as { pending: Map<number, unknown> }).pending;
  return { connection, requests, pending };
}

const params = { provider: "anthropic" as const, constrainedStructured: true };
describe("constrained probe deadlines on a hung RPC byte transport", () => {
  afterEach(() => vi.useRealTimers());

  it("defaults constrained probes to five seconds and cleans pending waiters", async () => {
    vi.useFakeTimers();
    const { connection, requests, pending } = hungTransport();
    try {
      const result = connection.probeProvider(params, "actor").catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(pending.size).toBe(1);
      expect(requests).toEqual([expect.objectContaining({ method: "probeProvider", params })]);
      await vi.advanceTimersByTimeAsync(1);
      expect(await result).toMatchObject({
        message: "cli-runner probeProvider timed out after 5000ms"
      });
      expect(pending.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      connection.close();
    }
  });

  it("removes the pending waiter, timer and abort listener on cancellation", async () => {
    vi.useFakeTimers();
    const { connection, pending } = hungTransport();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    try {
      const result = connection
        .probeProvider(params, "actor", {
          timeoutMs: 5_000,
          signal: controller.signal
        })
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      expect(pending.size).toBe(1);
      controller.abort();
      expect(await result).toMatchObject({ message: "cli-runner probeProvider cancelled" });
      expect(pending.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    } finally {
      connection.close();
    }
  });

  it("does not dispatch an expired probe after a delayed connection completes", async () => {
    vi.useFakeTimers();
    const { connection, pending, requests } = hungTransport();
    let resume!: () => void;
    vi.spyOn(connection, "ensureConnected").mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resume = resolve;
      })
    );
    try {
      const result = connection.probeProvider(params, "actor").catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await result).toMatchObject({
        message: "cli-runner probeProvider timed out after 5000ms"
      });
      resume();
      await vi.advanceTimersByTimeAsync(0);
      expect(requests).toEqual([]);
      expect(pending.size).toBe(0);
    } finally {
      connection.close();
    }
  });

  it("preserves the ordinary onboarding probe's server-owned deadline", async () => {
    vi.useFakeTimers();
    const { connection, pending } = hungTransport();
    const result = connection.probeProvider({ provider: "anthropic" }).catch(() => undefined);
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(pending.size).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      connection.close();
      await result;
    }
  });
});
