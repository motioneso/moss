import { describe, expect, it } from "vitest";

import { AssistantToolGateway, ConfirmationRegistry, SessionTokenRegistry } from "@moss/ai";
import { HttpError } from "@moss/module-sdk";
import type { MossModuleManifest, ModuleAssistantToolManifest } from "@moss/module-sdk";

const TOOL_NAME = "notes.search";

function manifestWithTool(
  execute: ModuleAssistantToolManifest["execute"],
  isExternal = false
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
        isExternal,
        execute
      }
    ]
  };
}

async function callWithThrow(
  thrown: unknown,
  isExternal = false
): Promise<Awaited<ReturnType<AssistantToolGateway["callTool"]>>> {
  const tokens = new SessionTokenRegistry();
  const gateway = new AssistantToolGateway({
    resolveActiveModules: async () => [
      manifestWithTool(async () => {
        throw thrown;
      }, isExternal)
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
    expect(result).toEqual({
      ok: false,
      error: `Tool ${TOOL_NAME} failed: could not connect to a service it needs.`
    });
  });

  it("classifies an HttpError by statusCode", async () => {
    const thrown = new HttpError(503, "Service Unavailable");
    const result = await callWithThrow(thrown);
    expect(result).toEqual({
      ok: false,
      error: `Tool ${TOOL_NAME} failed: a service it needs returned an error.`
    });
  });

  it("classifies an AbortError as a timeout", async () => {
    const thrown = Object.assign(new Error("aborted"), { name: "AbortError" });
    const result = await callWithThrow(thrown);
    expect(result).toEqual({
      ok: false,
      error: `Tool ${TOOL_NAME} failed: a service it needs did not respond in time.`
    });
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
  describe("the other side of the first-party gate", () => {
    // The classification only ever runs for isExternal === false. Nothing tested the inverse, so
    // an inverted condition would have shipped silently and started handing third-party module
    // error detail to users. These pin the external path to the unchanged generic message.
    it("gives a third-party (isExternal: true) tool the plain generic message", async () => {
      const thrown = Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })
      });
      const result = await callWithThrow(thrown, true);
      expect(result).toEqual({ ok: false, error: `Tool ${TOOL_NAME} failed` });
      expect(JSON.stringify(result)).not.toContain("could not connect");
    });

    it("gives a third-party tool the generic message for an HTTP status failure too", async () => {
      const result = await callWithThrow(new HttpError(503, "Service Unavailable"), true);
      expect(result).toEqual({ ok: false, error: `Tool ${TOOL_NAME} failed` });
    });
  });

  describe("an error subclass that runs code when its fields are read", () => {
    // isNativeError() accepts a subclass of Error, and a subclass can define `code` as a getter.
    // Trusting a first-party dependency that far is deliberate, but it was untested. These pin
    // what actually happens: the getter runs, it runs a bounded number of times, and whatever it
    // does cannot crash the request or push its own text into the reply.
    class SideEffectError extends Error {
      static reads = 0;
      get code(): string {
        SideEffectError.reads += 1;
        return "ECONNREFUSED";
      }
    }

    class ThrowingFieldError extends Error {
      get code(): string {
        throw new Error("side-effect-secret-sentinel");
      }
    }

    it("reads a getter-backed code at most twice and still classifies it", async () => {
      SideEffectError.reads = 0;
      const result = await callWithThrow(new SideEffectError("boom"));
      expect(result).toEqual({
        ok: false,
        error: `Tool ${TOOL_NAME} failed: could not connect to a service it needs.`
      });
      // Once for the response classification, once for the safe-name/log read at most.
      expect(SideEffectError.reads).toBeLessThanOrEqual(2);
      expect(SideEffectError.reads).toBeGreaterThan(0);
    });

    it("contains a throwing getter: generic message, no crash, nothing of its text in the reply", async () => {
      const result = await callWithThrow(new ThrowingFieldError("boom"));
      expect(result).toEqual({ ok: false, error: `Tool ${TOOL_NAME} failed` });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("side-effect-secret-sentinel");
      expect(serialized).not.toContain("boom");
    });
  });

  describe("odd and conflicting field shapes", () => {
    it("treats an absurdly large status number as an upstream HTTP error", async () => {
      const thrown = Object.assign(new Error("weird"), { statusCode: Number.MAX_SAFE_INTEGER });
      const result = await callWithThrow(thrown);
      expect(result).toEqual({
        ok: false,
        error: `Tool ${TOOL_NAME} failed: a service it needs returned an error.`
      });
    });

    it("ignores a status that is not a number", async () => {
      const thrown = Object.assign(new Error("weird"), { statusCode: "503", status: "503" });
      const result = await callWithThrow(thrown);
      expect(result).toEqual({ ok: false, error: `Tool ${TOOL_NAME} failed` });
    });

    it("ignores a sub-400 status", async () => {
      const thrown = Object.assign(new Error("weird"), { statusCode: 204 });
      const result = await callWithThrow(thrown);
      expect(result).toEqual({ ok: false, error: `Tool ${TOOL_NAME} failed` });
    });

    it("prefers the top-level code when it disagrees with the cause", async () => {
      const thrown = Object.assign(new Error("outer"), {
        code: "ETIMEDOUT",
        cause: Object.assign(new Error("inner"), { code: "ECONNREFUSED" })
      });
      const result = await callWithThrow(thrown);
      expect(result).toEqual({
        ok: false,
        error: `Tool ${TOOL_NAME} failed: a service it needs did not respond in time.`
      });
    });

    it("falls through to the cause when the top level classifies to nothing", async () => {
      const thrown = Object.assign(new Error("outer"), {
        code: "ENOENT",
        cause: Object.assign(new Error("inner"), { code: "ECONNREFUSED" })
      });
      const result = await callWithThrow(thrown);
      expect(result).toEqual({
        ok: false,
        error: `Tool ${TOOL_NAME} failed: could not connect to a service it needs.`
      });
    });

    it("does not look past the first cause", async () => {
      const thrown = Object.assign(new Error("outer"), {
        cause: Object.assign(new Error("middle"), {
          cause: Object.assign(new Error("inner"), { code: "ECONNREFUSED" })
        })
      });
      const result = await callWithThrow(thrown);
      expect(result).toEqual({ ok: false, error: `Tool ${TOOL_NAME} failed` });
    });
  });
});
