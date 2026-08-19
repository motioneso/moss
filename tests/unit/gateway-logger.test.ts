import { describe, expect, it } from "vitest";

import { AssistantToolGateway, ConfirmationRegistry, SessionTokenRegistry } from "@moss/ai";
import type { MossModuleManifest, ModuleAssistantActionFamilyManifest } from "@moss/module-sdk";

/**
 * Phase 1d — gateway.ts's handler-throw catch sites route through an injectable GatewayLogger
 * instead of a hardcoded console.error literal, carrying actorUserId/errorClass/message (and,
 * write path only, statusCode) instead of the old fixed "handler_error" string.
 */
describe("gateway logger", () => {
  const familyManifest: ModuleAssistantActionFamilyManifest = {
    id: "mock_family",
    label: "Mock Family",
    description: "Mock Family Description",
    defaultTier: "ask_each_time",
    allowedTiers: ["ask_each_time", "trusted_auto"]
  };

  const moduleWith = (
    tool: MossModuleManifest["assistantTools"] extends readonly (infer T)[] ? T : never
  ): MossModuleManifest => ({
    id: "mock_module",
    name: "Mock Module",
    version: "1.0.0",
    publisher: "Jarv1s",
    lifecycle: "optional",
    compatibility: { jarv1s: "*" },
    assistantTools: [tool]
  });

  const buildGateway = (module: MossModuleManifest, logCalls: unknown[]) => {
    const tokens = new SessionTokenRegistry();
    const confirmations = new ConfirmationRegistry();
    const gateway = new AssistantToolGateway({
      resolveActiveModules: async () => [module],
      repository: {
        createPendingAssistantAction: async () => ({ id: "action-1" })
      } as never,
      runner: {
        withDataContext: async (_access: unknown, work: (db: unknown) => Promise<unknown>) =>
          work({})
      } as never,
      tokens,
      confirmations,
      notifier: { emit: () => {} },
      confirmTimeoutMs: 1000,
      actionPolicy: () => ({
        getFamilyTier: async () => "trusted_auto",
        getFamilyManifest: async () => familyManifest
      }),
      logger: {
        error: (event, fields) => logCalls.push({ event, ...fields })
      }
    });
    const token = tokens.mint({ actorUserId: "u1", chatSessionId: "s1", allowedToolNames: null });
    return { gateway, token };
  };

  const throwingWriteTool = (execute: () => Promise<never>) => ({
    name: "mock.write",
    description: "Mock write tool that throws.",
    permissionId: "mock.write",
    actionFamilyId: "mock_family",
    risk: "write" as const,
    executionPolicy: "auto" as const,
    inputSchema: { type: "object", properties: {} },
    execute
  });

  it("logs a plain Error thrown by a write handler with actorUserId/errorClass/message", async () => {
    const logCalls: unknown[] = [];
    const module = moduleWith(
      throwingWriteTool(async () => {
        throw new Error("boom");
      }) as never
    );
    const { gateway, token } = buildGateway(module, logCalls);

    const result = await gateway.callTool(token, "mock.write", {});

    expect(result.ok).toBe(false);
    expect(logCalls).toHaveLength(1);
    expect(logCalls[0]).toMatchObject({
      event: "tool_handler_threw",
      toolName: "mock.write",
      actorUserId: "u1",
      errorClass: "Error",
      message: "boom"
    });
    expect((logCalls[0] as { requestId: unknown }).requestId).toBeTruthy();
  });

  it("logs statusCode when a write handler throws a statusCode-bearing error", async () => {
    class GoogleApiError extends Error {
      constructor(
        message: string,
        readonly statusCode: number
      ) {
        super(message);
        this.name = "GoogleApiError";
      }
    }

    const logCalls: unknown[] = [];
    const module = moduleWith(
      throwingWriteTool(async () => {
        throw new GoogleApiError("quota exceeded", 429);
      }) as never
    );
    const { gateway, token } = buildGateway(module, logCalls);

    await gateway.callTool(token, "mock.write", {});

    expect(logCalls).toHaveLength(1);
    expect(logCalls[0]).toMatchObject({
      event: "tool_handler_threw",
      errorClass: "GoogleApiError",
      message: "quota exceeded",
      statusCode: 429
    });
  });

  it("logs a plain Error thrown by a read handler with actorUserId/errorClass/message", async () => {
    const logCalls: unknown[] = [];
    const module = moduleWith({
      name: "mock.read",
      description: "Mock read tool that throws.",
      permissionId: "mock.read",
      risk: "read" as const,
      inputSchema: { type: "object", properties: {} },
      execute: async () => {
        throw new Error("boom");
      }
    } as never);
    const { gateway } = buildGateway(module, logCalls);

    const result = await gateway.runReadToolForActor("u1", "mock.read", {});

    expect(result.ok).toBe(false);
    expect(logCalls).toHaveLength(1);
    expect(logCalls[0]).toMatchObject({
      event: "read_tool_handler_threw",
      toolName: "mock.read",
      actorUserId: "u1",
      errorClass: "Error",
      message: "boom"
    });
  });
});
