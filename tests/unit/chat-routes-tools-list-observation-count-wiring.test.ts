/**
 * #2164 r21 — `registerChatRoutes`'s `wiring` closure must bind `mcpTokenLifecycle.getToolsListObservationCount`
 * to the wiring closure's real `SessionTokenRegistry.getToolsListObservationCount`, the same
 * registry-binding pattern already proved for `waitForReady` → `waitForToolsListObserved` (#2159) and
 * for `adoptMcpTokenRevoke` → `revokeBySessionId` (`chat-routes-mcp-token-revoke-adopt.test.ts`, whose
 * approach this mirrors).
 *
 * `createChatSessionRuntime` is mocked so the `mcpTokenLifecycle` object routes.ts builds can be
 * captured directly, without constructing a real `ChatSessionManager` or touching a DB — matching
 * `chat-runtime-tools-list-observation-wiring.test.ts`'s approach one layer up.
 */
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as RuntimeModule from "../../packages/chat/src/live/runtime.js";

const capturedDeps: unknown[] = [];

vi.mock("../../packages/chat/src/live/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimeModule>();
  return {
    ...actual,
    createChatSessionRuntime: vi.fn().mockImplementation((deps: unknown) => {
      capturedDeps.push(deps);
      return {
        manager: { dropSessionsForProvider: vi.fn() } as never,
        connection: undefined,
        shutdown: vi.fn()
      };
    })
  };
});

import { SessionTokenRegistry } from "@moss/ai";
import { registerChatRoutes } from "../../packages/chat/src/routes.js";

describe("registerChatRoutes — getToolsListObservationCount wiring (#2164 r21)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    capturedDeps.length = 0;
  });

  it("wires mcpTokenLifecycle.getToolsListObservationCount to the wiring closure's real SessionTokenRegistry", () => {
    const getToolsListObservationCount = vi.spyOn(
      SessionTokenRegistry.prototype,
      "getToolsListObservationCount"
    );
    const server = Fastify();

    registerChatRoutes(server, {
      rootDb: {} as never,
      dataContext: {} as never,
      resolveAccessContext: async () => ({ actorUserId: "user-1", requestId: "req-1" }),
      chatEngineFactory: (() => {
        throw new Error("not exercised in this test");
      }) as never,
      resolveActiveModules: async () => [],
      mcpServerUrl: "http://mcp.example.test/api/mcp"
    });

    const deps = capturedDeps.at(-1) as {
      mcpTokenLifecycle?: { getToolsListObservationCount?: (token: string) => number };
    };
    const readCount = deps.mcpTokenLifecycle?.getToolsListObservationCount;
    expect(readCount).toBeTypeOf("function");

    readCount!("jst_probe-token");

    expect(getToolsListObservationCount).toHaveBeenCalledWith("jst_probe-token");
  });

  it("never wires getToolsListObservationCount when no gateway is wired (resolveActiveModules/mcpServerUrl absent)", () => {
    const server = Fastify();

    registerChatRoutes(server, {
      rootDb: {} as never,
      dataContext: {} as never,
      resolveAccessContext: async () => ({ actorUserId: "user-1", requestId: "req-1" }),
      chatEngineFactory: (() => {
        throw new Error("not exercised in this test");
      }) as never
    });

    const deps = capturedDeps.at(-1) as { mcpTokenLifecycle?: unknown };
    expect(deps.mcpTokenLifecycle).toBeUndefined();
  });
});
