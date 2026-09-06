import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import Fastify from "fastify";
import {
  acceptsEventStream,
  gatewayResponseToMcp,
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
    const res: GatewayToolResponse = {
      ok: false,
      denied: true,
      reason: "This action was not approved. Do not retry; tell the user."
    };
    const mcp = gatewayResponseToMcp(res);
    expect(mcp.isError).toBe(true);
    expect(mcp.content[0]).toEqual({
      type: "text",
      text: "This action was not approved. Do not retry; tell the user."
    });
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
  return raw.frames.map((frame) => JSON.parse(frame.replace(/^data: /, "")) as StreamFrame);
}

describe("streamToolCallWithProgress", () => {
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
    resolveCall({ ok: false, denied: true, reason: "This action was not approved." });
    await done;

    const messages = frameMessages(raw);
    const beats = messages.filter((msg) => msg.method === "notifications/progress");
    expect(beats.length).toBeGreaterThanOrEqual(3);
    for (const beat of beats) {
      expect(beat.params.progressToken).toBe("tok-1");
    }
    expect(messages.at(-1)).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: {
        content: [{ type: "text", text: "This action was not approved." }],
        isError: true
      }
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
        requestNativeToolPermission: async (rawToken: string, request: unknown) => {
          expect(rawToken).toBe(token);
          expect(request).toEqual({ toolName: "Bash", toolInput: { command: "echo hi" } });
          return {
            decision: "deny",
            reason: "This action was not approved. Do not retry; tell the user."
          };
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
      expect(res.json()).toEqual({
        decision: "deny",
        reason: "This action was not approved. Do not retry; tell the user."
      });
    } finally {
      await app.close();
    }
  });
});
