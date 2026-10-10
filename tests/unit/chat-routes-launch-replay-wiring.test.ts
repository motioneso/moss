import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as RuntimeModule from "../../packages/chat/src/live/runtime.js";

// #3335: the launch replay hooks are optional, so a dropped wiring line would switch the guard off
// in production with every behaviour test still green. This pins routes.ts to the real registry.

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

describe("registerChatRoutes launch replay wiring (#3335)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    capturedDeps.length = 0;
  });

  it("binds begin and end to the real token registry", () => {
    const begin = vi.spyOn(SessionTokenRegistry.prototype, "beginLaunchReplay");
    const end = vi.spyOn(SessionTokenRegistry.prototype, "endLaunchReplay");
    registerChatRoutes(Fastify(), {
      rootDb: {} as never,
      dataContext: {} as never,
      resolveAccessContext: async () => ({ actorUserId: "user-1", requestId: "req-1" }),
      chatEngineFactory: (() => {
        throw new Error("not exercised in this test");
      }) as never,
      resolveActiveModules: async () => [],
      mcpServerUrl: "http://mcp.example.test/api/mcp"
    });

    const lifecycle = (
      capturedDeps.at(-1) as {
        mcpTokenLifecycle?: {
          beginLaunchReplay?: (token: string) => void;
          endLaunchReplay?: (token: string) => void;
        };
      }
    ).mcpTokenLifecycle;
    lifecycle?.beginLaunchReplay?.("jst_probe");
    lifecycle?.endLaunchReplay?.("jst_probe");

    expect(begin).toHaveBeenCalledWith("jst_probe");
    expect(end).toHaveBeenCalledWith("jst_probe");
  });
});
