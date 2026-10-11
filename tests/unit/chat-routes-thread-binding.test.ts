import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as RuntimeModule from "../../packages/chat/src/live/runtime.js";
import type * as ShadowModule from "../../packages/chat/src/live/classifier-gate-shadow.js";

type RuntimeDeps = Parameters<typeof RuntimeModule.createChatSessionRuntime>[0];
const captured = vi.hoisted(() => ({
  runtime: undefined as RuntimeDeps | undefined,
  shadow: undefined as ShadowModule.ClassifierGateShadowRunnerDeps | undefined
}));

vi.mock("../../packages/chat/src/live/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeModule>()),
  createChatSessionRuntime: (deps: RuntimeDeps) => {
    captured.runtime = deps;
    return {
      manager: { dropSessionsForProvider: vi.fn() },
      connection: undefined,
      shutdown: vi.fn()
    };
  }
}));
vi.mock("../../packages/chat/src/live/classifier-gate-shadow.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ShadowModule>()),
  createClassifierGateShadowRunner: (deps: ShadowModule.ClassifierGateShadowRunnerDeps) => {
    captured.shadow = deps;
    return { start: vi.fn(), observeModelTool: vi.fn(), noModelTool: vi.fn(), cancelTurn: vi.fn() };
  }
}));

import { AssistantToolGateway, SessionTokenRegistry } from "@moss/ai";
import { registerChatRoutes } from "../../packages/chat/src/routes.js";

afterEach(() => {
  vi.restoreAllMocks();
  captured.runtime = undefined;
  captured.shadow = undefined;
});

function routes() {
  const mint = vi.spyOn(SessionTokenRegistry.prototype, "mint");
  const server = Fastify();
  registerChatRoutes(server, {
    rootDb: {} as never,
    dataContext: {} as never,
    resolveAccessContext: async () => ({ actorUserId: "user-1", requestId: "request-1" }),
    chatEngineFactory: vi.fn(),
    resolveActiveModules: async () => [],
    mcpServerUrl: "http://mcp.test/api/mcp"
  });
  return mint;
}

describe("route token minters preserve captured conversation bindings", () => {
  it.each(["thread-A", null])(
    "passes live binding %s through the tool-menu await",
    async (threadId) => {
      const mint = routes();
      let release!: (tools: never[]) => void;
      vi.spyOn(AssistantToolGateway.prototype, "listToolsForActor").mockImplementation(
        () =>
          new Promise((resolve) => {
            release = resolve;
          })
      );
      const pending = captured.runtime!.mcpTokenLifecycle!.mint("user-1", "chat-1", threadId);
      release([]);
      const { token } = await pending;
      expect(mint).toHaveBeenCalledWith(
        expect.objectContaining({ actorUserId: "user-1", chatSessionId: "chat-1", threadId })
      );
      const registry = mint.mock.contexts[0] as SessionTokenRegistry;
      expect(registry.verify(token).threadId).toBe(threadId);
    }
  );

  it.each(["thread-A", null])(
    "passes shadow binding %s into the fixed-expiry token",
    (threadId) => {
      const mint = routes();
      const token = captured.shadow!.tokens.mint(
        "user-1",
        "turn-1",
        threadId,
        new Set(["calendar.list"])
      );
      expect(mint).toHaveBeenCalledWith(
        expect.objectContaining({
          actorUserId: "user-1",
          chatSessionId: "classifier-gate:turn-1",
          threadId
        }),
        expect.objectContaining({ fixedExpiry: true })
      );
      const registry = mint.mock.contexts[0] as SessionTokenRegistry;
      expect(registry.verify(token).threadId).toBe(threadId);
    }
  );
});
