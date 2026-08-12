import { afterEach, describe, expect, it, vi } from "vitest";

const registerChatRoutes = vi.fn();

vi.mock("@moss/chat", () => ({
  CHAT_QUEUE_DEFINITIONS: [],
  CliChatUnavailableError: class CliChatUnavailableError extends Error {},
  chatModuleManifest: {
    id: "chat",
    name: "Chat",
    version: "0.0.0",
    publisher: "test",
    lifecycle: "required",
    compatibility: { jarv1s: ">=0.0.0" },
    availability: { defaultEnabled: true }
  },
  chatModuleSqlMigrationDirectory: "mock-chat-sql",
  registerChatJobWorkers: vi.fn(),
  registerChatRoutes
}));

describe("module-registry chat MCP URL wiring", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    registerChatRoutes.mockClear();
  });

  it("passes the composition-root MCP server URL instead of reading PORT", async () => {
    vi.stubEnv("PORT", "9999");
    const { getBuiltInModuleRegistrations } = await import("@moss/module-registry");
    const chatRegistration = getBuiltInModuleRegistrations().find(
      (registration) => registration.manifest.id === "chat"
    );

    chatRegistration?.registerRoutes?.({} as never, {
      boss: {} as never,
      dataContext: {} as never,
      focusSignals: undefined,
      listConfiguredAuthProviders: () => [],
      listModuleManifests: () => [],
      mcpServerUrl: "http://configured.example.test/api/mcp",
      resolveAccessContext: async () => ({ actorUserId: "user-1", requestId: "req-1" }),
      resolveActiveModules: async () => [],
      rootDb: {} as never
    });

    expect(registerChatRoutes).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        mcpServerUrl: "http://configured.example.test/api/mcp"
      })
    );
  });

  // #1554 task #6 — the chat module's registerRoutes must forward the composition root's
  // adoptMcpTokenRevoke late-bound "adopt" seam into registerChatRoutes, or the wiring closure's
  // SessionTokenRegistry.revokeBySessionId (built inside registerChatRoutes) can never reach
  // module-registry/src/index.ts's onPersistentReap wiring — the exact task #5 gap this closes.
  it("forwards adoptMcpTokenRevoke into registerChatRoutes", async () => {
    const { getBuiltInModuleRegistrations } = await import("@moss/module-registry");
    const chatRegistration = getBuiltInModuleRegistrations().find(
      (registration) => registration.manifest.id === "chat"
    );
    const adoptMcpTokenRevoke = vi.fn();

    chatRegistration?.registerRoutes?.({} as never, {
      boss: {} as never,
      dataContext: {} as never,
      focusSignals: undefined,
      listConfiguredAuthProviders: () => [],
      listModuleManifests: () => [],
      mcpServerUrl: "http://configured.example.test/api/mcp",
      resolveAccessContext: async () => ({ actorUserId: "user-1", requestId: "req-1" }),
      resolveActiveModules: async () => [],
      rootDb: {} as never,
      adoptMcpTokenRevoke
    });

    expect(registerChatRoutes).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ adoptMcpTokenRevoke })
    );
  });
});
