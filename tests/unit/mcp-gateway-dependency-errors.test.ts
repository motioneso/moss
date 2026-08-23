import { describe, expect, it } from "vitest";

import { AssistantToolGateway, ConfirmationRegistry, SessionTokenRegistry } from "@moss/ai";
import { HttpError } from "@moss/module-sdk";
import type { MossModuleManifest, ModuleAssistantToolManifest, ToolResult } from "@moss/module-sdk";

const TOOL_NAME = "notes.search";

function manifestWithFirstPartyTool(
  execute: ModuleAssistantToolManifest["execute"]
): MossModuleManifest {
  return {
    id: "notes",
    name: "Notes",
    version: "1.0.0",
    publisher: "Moss",
    lifecycle: "optional",
    compatibility: { jarv1s: ">=0.0.0" },
    assistantTools: [
      {
        name: TOOL_NAME,
        description: "Search notes.",
        permissionId: "notes.search",
        risk: "read",
        isExternal: false,
        execute
      }
    ]
  };
}

async function callWithThrow(thrown: unknown): Promise<Awaited<ReturnType<AssistantToolGateway["callTool"]>>> {
  const tokens = new SessionTokenRegistry();
  const gateway = new AssistantToolGateway({
    resolveActiveModules: async () => [
      manifestWithFirstPartyTool(async () => {
        throw thrown;
      })
    ],
    repository: { insertActionAuditLog: async () => undefined } as never,
    runner: {
      withDataContext: async (_access: unknown, work: (db: unknown) => Promise<unknown>) => work({})
    } as never,
    tokens,
    confirmations: new ConfirmationRegistry(),
    notifier: { emit: () => undefined },
    confirmTimeoutMs: 50,
    yoloMode: async () => true
  });
  const token = tokens.mint({ actorUserId: "u1", chatSessionId: "c1", allowedToolNames: null });
  return gateway.callTool(token, TOOL_NAME, {});
}

describe("first-party tool dependency-failure classification (#1883)", () => {
  it("classifies a connection-refused cause", async () => {
    const thrown = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })
    });
    const result = await callWithThrow(thrown);
    expect(result).toEqual({ ok: false, error: `Tool ${TOOL_NAME} failed (upstream_connection_refused)` });
  });

  it("classifies an HttpError by statusCode", async () => {
    const thrown = new HttpError(503, "Service Unavailable");
    const result = await callWithThrow(thrown);
    expect(result).toEqual({ ok: false, error: `Tool ${TOOL_NAME} failed (upstream_http_error)` });
  });

  it("classifies an AbortError as a timeout", async () => {
    const thrown = Object.assign(new Error("aborted"), { name: "AbortError" });
    const result = await callWithThrow(thrown);
    expect(result).toEqual({ ok: false, error: `Tool ${TOOL_NAME} failed (upstream_timeout)` });
  });

  it("leaves an unclassifiable error at the unchanged generic message", async () => {
    const thrown = new Error("boom");
    const result = await callWithThrow(thrown);
    expect(result).toEqual({ ok: false, error: `Tool ${TOOL_NAME} failed` });
    expect(JSON.stringify(result)).not.toContain("boom");
  });

  it("never leaks the thrown message text into the response", async () => {
    const thrown = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })
    });
    const result = await callWithThrow(thrown);
    expect(JSON.stringify(result)).not.toContain("fetch failed");
  });

  describe("hostile-shaped throw from a first-party (isExternal: false) tool", () => {
    function makeHostileProxy(): { proxy: unknown; getTrapCalls: () => number } {
      let trapCalls = 0;
      const proxy = new Proxy(
        { sentinel: "handler-secret-sentinel" },
        {
          get() {
            trapCalls += 1;
            throw new Error("handler throw was inspected");
          },
          getOwnPropertyDescriptor() {
            trapCalls += 1;
            throw new Error("handler throw was inspected");
          },
          getPrototypeOf() {
            trapCalls += 1;
            throw new Error("handler throw was inspected");
          },
          ownKeys() {
            trapCalls += 1;
            throw new Error("handler throw was inspected");
          }
        }
      );
      return { proxy, getTrapCalls: () => trapCalls };
    }

    it("takes the generic path with zero trap calls for a top-level hostile Proxy", async () => {
      const { proxy, getTrapCalls } = makeHostileProxy();
      const result = await callWithThrow(proxy);
      expect(result).toEqual({ ok: false, error: `Tool ${TOOL_NAME} failed` });
      expect(getTrapCalls()).toBe(0);
      expect(JSON.stringify(result)).not.toContain("handler-secret-sentinel");
    });

    it("takes the generic path with zero trap calls for an Error whose cause is a hostile Proxy", async () => {
      const { proxy, getTrapCalls } = makeHostileProxy();
      const thrown = Object.assign(new Error("boom"), { cause: proxy });
      const result = await callWithThrow(thrown);
      expect(result).toEqual({ ok: false, error: `Tool ${TOOL_NAME} failed` });
      expect(getTrapCalls()).toBe(0);
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("boom");
      expect(serialized).not.toContain("handler-secret-sentinel");
    });
  });
});
