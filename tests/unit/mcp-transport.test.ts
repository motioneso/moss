import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import Fastify from "fastify";
import {
  acceptsEventStream,
  gatewayResponseToMcp,
  MCP_SSE_HEADERS,
  registerNativePermissionRoute,
  streamToolCallWithProgress
} from "../../packages/chat/src/mcp-transport.js";
import type { GatewayToolResponse } from "@moss/ai";
import { SessionTokenRegistry } from "@moss/ai";

describe("gatewayResponseToMcp", () => {
  it("maps ok=true response to non-error content (reads pre-rendered .text)", () => {
    const res: GatewayToolResponse = { ok: true, data: { text: '{"result":"hello"}' } };
    const mcp = gatewayResponseToMcp(res);
    expect(mcp.isError).toBe(false);
    // #1133 widened content blocks to a text|image union — assert the whole block shape.
    expect(mcp.content[0]).toEqual({ type: "text", text: '{"result":"hello"}' });
  });

  it("maps denied response to isError=true with reason", () => {
    // A neutral sentence: this test covers the mapping, not the gateway's
    // wording, so it must not depend on what the gateway says.
    const res: GatewayToolResponse = { ok: false, denied: true, reason: "Example refused." };
    const mcp = gatewayResponseToMcp(res);
    expect(mcp.isError).toBe(true);
    expect(mcp.content[0]).toEqual({ type: "text", text: "Example refused." });
  });

  it("maps error response to isError=true with error message", () => {
    const res: GatewayToolResponse = { ok: false, error: "Tool failed" };
    const mcp = gatewayResponseToMcp(res);
    expect(mcp.isError).toBe(true);
    expect(mcp.content[0]).toEqual({ type: "text", text: "Tool failed" });
  });
});

describe("acceptsEventStream", () => {
  it("reads the caller's Accept header", () => {
    expect(acceptsEventStream("text/event-stream")).toBe(true);
    expect(acceptsEventStream("application/json, text/event-stream")).toBe(true);
    expect(acceptsEventStream("application/json")).toBe(false);
    expect(acceptsEventStream(undefined)).toBe(false);
  });
});

class FakeRaw extends EventEmitter {
  readonly frames: string[] = [];
  ended = false;

  write(chunk: string): boolean {
    this.frames.push(chunk);
    return true;
  }

  end(): this {
    this.ended = true;
    this.emit("close");
    return this;
  }
}

interface StreamFrame {
  readonly method?: string;
  readonly params?: { readonly progressToken?: unknown };
}

function frameMessages(raw: FakeRaw): StreamFrame[] {
  return raw.frames
    .filter((frame) => frame.startsWith("data:"))
    .map((frame) => JSON.parse(frame.replace(/^data: /, "")) as StreamFrame);
}

describe("stream headers", () => {
  it("keeps the security headers hijacking would otherwise drop", () => {
    // Mirrors the @fastify/helmet setup in apps/api/src/server.ts.
    expect(MCP_SSE_HEADERS["content-type"]).toBe("text/event-stream");
    expect(MCP_SSE_HEADERS["content-security-policy"]).toContain("default-src 'none'");
    expect(MCP_SSE_HEADERS["x-frame-options"]).toBe("DENY");
    expect(MCP_SSE_HEADERS["x-content-type-options"]).toBe("nosniff");
    expect(MCP_SSE_HEADERS["referrer-policy"]).toBe("no-referrer");
  });
});

describe("streamToolCallWithProgress", () => {
  it("flushes a prelude frame at once, before the first beat", async () => {
    const raw = new FakeRaw();
    const call = new Promise<GatewayToolResponse>(() => {});
    const done = streamToolCallWithProgress(raw as never, call, {
      id: 7,
      progressToken: "tok-1",
      heartbeatMs: 60_000,
      maxDurationMs: 60_000
    });

    await vi.waitFor(() => expect(raw.frames.length).toBeGreaterThanOrEqual(1));
    // The head goes out with the prelude; the first beat would take a minute.
    expect(raw.frames[0]).toBe(": connected\n\n");
    expect(frameMessages(raw)).toHaveLength(0);
    raw.end();
    await done;
  });

  it("beats while the call is held, then closes with the result", async () => {
    const raw = new FakeRaw();
    let resolveCall!: (response: GatewayToolResponse) => void;
    const call = new Promise<GatewayToolResponse>((resolve) => {
      resolveCall = resolve;
    });
    const done = streamToolCallWithProgress(raw as never, call, {
      id: 7,
      progressToken: "tok-1",
      heartbeatMs: 20
    });

    await vi.waitFor(() => {
      const beats = frameMessages(raw).filter((msg) => msg.method === "notifications/progress");
      expect(beats.length).toBeGreaterThanOrEqual(3);
    });
    // A neutral sentence: this test covers framing, not the gateway's wording.
    resolveCall({ ok: false, denied: true, reason: "Example refused." });
    await done;

    const messages = frameMessages(raw);
    const beats = messages.filter((msg) => msg.method === "notifications/progress");
    expect(beats.length).toBeGreaterThanOrEqual(3);
    for (const beat of beats) {
      expect(beat.params?.progressToken).toBe("tok-1");
    }
    expect(messages.at(-1)).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: {
        content: [{ type: "text", text: "Example refused." }],
        isError: true
      }
    });
    expect(raw.ended).toBe(true);
  });

  it("closes a stuck call with a timeout frame instead of holding forever", async () => {
    const raw = new FakeRaw();
    const call = new Promise<GatewayToolResponse>(() => {});
    await streamToolCallWithProgress(raw as never, call, {
      id: 9,
      progressToken: "tok-9",
      heartbeatMs: 10,
      maxDurationMs: 40
    });

    expect(frameMessages(raw).at(-1)).toEqual({
      jsonrpc: "2.0",
      id: 9,
      error: { code: -32603, message: "Tool call timed out." }
    });
    expect(raw.ended).toBe(true);
  });

  it("sends no beat when the call is already done", async () => {
    const raw = new FakeRaw();
    await streamToolCallWithProgress(raw as never, Promise.resolve({ ok: false, error: "boom" }), {
      id: 1,
      progressToken: 0,
      heartbeatMs: 10
    });
    expect(frameMessages(raw)).toHaveLength(1);
    expect(raw.ended).toBe(true);
  });

  it("closes with an error frame when the call throws", async () => {
    const raw = new FakeRaw();
    await streamToolCallWithProgress(raw as never, Promise.resolve(null), {
      id: 2,
      progressToken: "tok-2",
      heartbeatMs: 10
    });
    expect(frameMessages(raw)).toEqual([
      { jsonrpc: "2.0", id: 2, error: { code: -32603, message: "Internal error" } }
    ]);
    expect(raw.ended).toBe(true);
  });
});

describe("registerNativePermissionRoute", () => {
  it("rejects missing or forged bearer tokens before reaching the gateway", async () => {
    const app = Fastify({ logger: false });
    const tokens = new SessionTokenRegistry();
    let calls = 0;
    registerNativePermissionRoute(app, {
      tokens,
      gateway: {
        requestNativeToolPermission: async () => {
          calls += 1;
          return { decision: "allow", reason: "ok" };
        }
      } as never
    });
    await app.ready();
    try {
      const missing = await app.inject({
        method: "POST",
        url: "/internal/permission",
        body: { tool_name: "Bash", tool_input: { command: "echo hi" } }
      });
      const forged = await app.inject({
        method: "POST",
        url: "/internal/permission",
        headers: { authorization: "Bearer jst_forged" },
        body: { tool_name: "Bash", tool_input: { command: "echo hi" } }
      });
      expect(missing.statusCode).toBe(401);
      expect(forged.statusCode).toBe(401);
      expect(calls).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("returns the gateway allow/deny decision for a valid session token", async () => {
    const app = Fastify({ logger: false });
    const tokens = new SessionTokenRegistry();
    const token = tokens.mint({ actorUserId: "u1", chatSessionId: "s1", allowedToolNames: null });
    registerNativePermissionRoute(app, {
      tokens,
      gateway: {
        // A neutral sentence: this test covers route passthrough, not the
        // gateway's wording, so the stand-in must not speak for the gateway.
        requestNativeToolPermission: async (rawToken: string, request: unknown) => {
          expect(rawToken).toBe(token);
          expect(request).toEqual({ toolName: "Bash", toolInput: { command: "echo hi" } });
          return { decision: "deny", reason: "Example refused." };
        }
      } as never
    });
    await app.ready();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/internal/permission",
        headers: { authorization: `Bearer ${token}` },
        body: { tool_name: "Bash", tool_input: { command: "echo hi" } }
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ decision: "deny", reason: "Example refused." });
    } finally {
      await app.close();
    }
  });
});
