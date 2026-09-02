import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";
import Fastify from "fastify";

import { registerMcpTransportRoute } from "../../packages/chat/src/mcp-transport.js";
import { SessionTokenRegistry } from "@moss/ai";

describe("registerMcpTransportRoute — #2164 r21 tools/list observation log", () => {
  it("logs exactly one info line with only a token fingerprint + tool count on a successful tools/list", async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      }
    });
    const app = Fastify({ logger: { level: "info", stream } });
    const tokens = new SessionTokenRegistry();
    const token = tokens.mint({ actorUserId: "u1", chatSessionId: "s1", allowedToolNames: null });
    registerMcpTransportRoute(app, {
      tokens,
      gateway: {
        listToolsForActor: async () => [
          { name: "tool_a", description: "a", inputSchema: { type: "object" } }
        ]
      } as never
    });
    await app.ready();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/mcp",
        headers: { authorization: `Bearer ${token}` },
        body: { jsonrpc: "2.0", id: 1, method: "tools/list" }
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }

    const observed = lines
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.msg === "mcp tools/list observed");
    expect(observed).toHaveLength(1);
    expect(observed[0].toolCount).toBe(1);
    expect(typeof observed[0].tokenFingerprint).toBe("string");
    expect(observed[0].tokenFingerprint).not.toContain(token);
    expect(observed[0]).not.toHaveProperty("prompt");
    expect(observed[0]).not.toHaveProperty("reply");
    expect(observed[0]).not.toHaveProperty("actorUserId");
  });
});
