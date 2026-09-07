import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import {
  gatewayResponseToMcp,
  registerNativePermissionRoute
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
    const res: GatewayToolResponse = { ok: false, denied: true, reason: "Denied by user." };
    const mcp = gatewayResponseToMcp(res);
    expect(mcp.isError).toBe(true);
    expect(mcp.content[0]).toEqual({ type: "text", text: "Denied by user." });
  });

  it("maps error response to isError=true with error message", () => {
    const res: GatewayToolResponse = { ok: false, error: "Tool failed" };
    const mcp = gatewayResponseToMcp(res);
    expect(mcp.isError).toBe(true);
    expect(mcp.content[0]).toEqual({ type: "text", text: "Tool failed" });
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
          return { decision: "deny", reason: "Denied by user." };
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
      expect(res.json()).toEqual({ decision: "deny", reason: "Denied by user." });
    } finally {
      await app.close();
    }
  });
});
