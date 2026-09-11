import { describe, expect, it } from "vitest";

import { createTunnelStream } from "./stream.js";
import type { AcpTunnel } from "./tunnel.js";

describe("createTunnelStream", () => {
  it("drains all retained lines after the agent exits", async () => {
    const message = (id: number) => JSON.stringify({ jsonrpc: "2.0", id, result: {} });
    const batches = [
      { lines: [message(1)], firstSeq: 1, nextSeq: 2, exited: true, truncated: false },
      { lines: [message(2)], firstSeq: 2, nextSeq: 2, exited: true, truncated: false }
    ];
    const tunnel = {
      read: async () => batches.shift()!
    } as unknown as AcpTunnel;
    const stream = createTunnelStream(tunnel, "session", { pollMs: 0 });
    const reader = stream.readable.getReader();

    await expect(reader.read()).resolves.toMatchObject({
      value: { jsonrpc: "2.0", id: 1 },
      done: false
    });
    await expect(reader.read()).resolves.toMatchObject({
      value: { jsonrpc: "2.0", id: 2 },
      done: false
    });
    await expect(reader.read()).resolves.toMatchObject({ done: true });
    await stream.stop();
  });
});
