import { describe, expect, it, vi } from "vitest";

import { AssistantToolGateway, ConfirmationRegistry, SessionTokenRegistry } from "@moss/ai";

describe("first-party Moss MCP transport", () => {
  it("auto-allows transport without consulting action policy", async () => {
    const tokens = new SessionTokenRegistry();
    const createPendingAssistantAction = vi.fn();
    const emit = vi.fn();
    const resolveLocalTimezone = vi.fn();
    const yoloMode = vi.fn();
    const gateway = new AssistantToolGateway({
      resolveActiveModules: async () => [],
      repository: { createPendingAssistantAction } as never,
      runner: { withDataContext: vi.fn() } as never,
      tokens,
      confirmations: new ConfirmationRegistry(),
      notifier: { emit },
      confirmTimeoutMs: 5,
      resolveLocalTimezone,
      yoloMode
    });
    const token = tokens.mint({ actorUserId: "u1", chatSessionId: "s1", allowedToolNames: null });

    await expect(
      gateway.requestNativeToolPermission(token, {
        toolName: "  mcp__jarvis__demo_module_resume_import  ",
        toolInput: { attachmentId: "attachment-1" }
      })
    ).resolves.toEqual({ decision: "allow", reason: "First-party Moss MCP transport." });
    expect(createPendingAssistantAction).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    expect(resolveLocalTimezone).not.toHaveBeenCalled();
    expect(yoloMode).not.toHaveBeenCalled();
  });

  it.each([
    "mcp__jarvis__",
    "mcp__jarviss__demo_module_resume_import",
    "mcp__github__get_issue",
    "Bash"
  ])("keeps non-Jarvis transport name %j behind native confirmation", async (toolName) => {
    const tokens = new SessionTokenRegistry();
    const createPendingAssistantAction = vi.fn(async () => ({ id: "native-not-transport" }));
    const resolveLocalTimezone = vi.fn(async () => null);
    const gateway = new AssistantToolGateway({
      resolveActiveModules: async () => [],
      repository: { createPendingAssistantAction } as never,
      runner: {
        withDataContext: async (_access: unknown, work: (db: unknown) => Promise<unknown>) =>
          work({})
      } as never,
      tokens,
      confirmations: new ConfirmationRegistry(),
      notifier: { emit: () => undefined },
      confirmTimeoutMs: 1,
      resolveLocalTimezone
    });
    const token = tokens.mint({ actorUserId: "u1", chatSessionId: "s1", allowedToolNames: null });

    await expect(
      gateway.requestNativeToolPermission(token, { toolName, toolInput: {} })
    ).resolves.toEqual({ decision: "deny", reason: "Timed out awaiting confirmation." });
    expect(createPendingAssistantAction).toHaveBeenCalledOnce();
    expect(resolveLocalTimezone).toHaveBeenCalledOnce();
  });
});

describe("operator log receives real errors from swallowed catches (#1251)", () => {
  it("logs the real error for a read-tool handler throw, returns the sanitized string", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const gateway = new AssistantToolGateway({
        resolveActiveModules: async () => [
          {
            id: "demo-module",
            name: "Demo Module",
            version: "1.0.0",
            publisher: "Jarv1s",
            lifecycle: "optional",
            compatibility: { jarv1s: "*" },
            assistantTools: [
              {
                name: "demo-module.notes.search",
                description: "Search notes.",
                permissionId: "demo-module.notes.read",
                risk: "read",
                inputSchema: { type: "object", properties: {} },
                execute: async () => {
                  throw new Error("boom: db timeout");
                }
              }
            ]
          }
        ],
        repository: {} as never,
        runner: {
          withDataContext: async (_access: unknown, work: (db: unknown) => Promise<unknown>) =>
            work({})
        } as never,
        tokens: new SessionTokenRegistry(),
        confirmations: new ConfirmationRegistry(),
        notifier: { emit: () => undefined },
        confirmTimeoutMs: 5
      });

      const result = await gateway.runReadToolForActor("u1", "demo-module.notes.search", {});

      expect(result).toEqual({ ok: false, error: "Tool demo-module.notes.search failed" });
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const [logged] = errorSpy.mock.calls[0] as [string];
      const payload = JSON.parse(logged);
      expect(payload.event).toBe("read_tool_handler_threw");
      expect(payload.toolName).toBe("demo-module.notes.search");
      expect(payload.actorUserId).toBe("u1");
      expect(typeof payload.requestId).toBe("string");
      expect(payload.error).toContain("boom: db timeout");
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("logical action terminal results", () => {
  const createGateway = (input: {
    yolo: boolean;
    handlerError?: boolean;
    handlerErrorMessage?: string;
  }) => {
    const tokens = new SessionTokenRegistry();
    const emitted: Array<{
      kind: string;
      actionRequestId: string;
      toolName: string;
      outcome?: string;
    }> = [];
    const handlerRequestIds: string[] = [];
    const gateway = new AssistantToolGateway({
      resolveActiveModules: async () => [
        {
          id: "demo-module",
          name: "Demo Module",
          version: "1.0.0",
          publisher: "Jarv1s",
          lifecycle: "optional",
          compatibility: { jarv1s: "*" },
          assistantTools: [
            {
              name: "demo-module.resume.import",
              description: "Import a resume.",
              permissionId: "demo-module.resume.write",
              actionFamilyId: "resume_changes",
              risk: "write",
              executionPolicy: "auto",
              execute: async (_db, _toolInput, ctx) => {
                handlerRequestIds.push(ctx.requestId);
                if (input.handlerError) {
                  throw new Error(input.handlerErrorMessage ?? "private handler detail");
                }
                return { data: { imported: true } };
              }
            }
          ]
        }
      ],
      repository: { insertActionAuditLog: async () => undefined } as never,
      runner: {
        withDataContext: async (_access: unknown, work: (db: unknown) => Promise<unknown>) =>
          work({})
      } as never,
      tokens,
      confirmations: new ConfirmationRegistry(),
      notifier: { emit: (_chatSessionId, record) => emitted.push(record) },
      confirmTimeoutMs: 50,
      yoloMode: async () => input.yolo,
      actionPolicy: () => ({
        getFamilyTier: async () => "trusted_auto",
        getFamilyManifest: async () => ({
          id: "resume_changes",
          label: "Resume changes",
          description: "Changes to a Demo Module resume.",
          defaultTier: "ask_each_time",
          allowedTiers: ["ask_each_time", "trusted_auto"]
        })
      })
    });
    return {
      gateway,
      emitted,
      handlerRequestIds,
      token: tokens.mint({
        actorUserId: "u1",
        chatSessionId: "s1",
        allowedToolNames: null
      })
    };
  };

  it("emits one standalone executed result for a successful YOLO action", async () => {
    const { gateway, token, emitted, handlerRequestIds } = createGateway({ yolo: true });

    await expect(gateway.callTool(token, "demo-module.resume.import", {})).resolves.toMatchObject({
      ok: true
    });
    expect(emitted).toEqual([
      expect.objectContaining({
        kind: "action_result",
        actionRequestId: handlerRequestIds[0],
        toolName: "demo-module.resume.import",
        outcome: "executed",
        result: { text: expect.stringContaining('"imported": true') }
      })
    ]);
    expect(handlerRequestIds[0]).toMatch(/^mcp_/);
  });

  it("emits one standalone executed result for a successful trusted-auto action", async () => {
    const { gateway, token, emitted, handlerRequestIds } = createGateway({ yolo: false });

    await expect(gateway.callTool(token, "demo-module.resume.import", {})).resolves.toMatchObject({
      ok: true
    });
    expect(emitted).toEqual([
      expect.objectContaining({
        kind: "action_result",
        actionRequestId: handlerRequestIds[0],
        toolName: "demo-module.resume.import",
        outcome: "executed",
        result: { text: expect.stringContaining('"imported": true') }
      })
    ]);
  });

  it("emits one standalone error result when a trusted-auto handler fails", async () => {
    const { gateway, token, emitted, handlerRequestIds } = createGateway({
      yolo: false,
      handlerError: true
    });

    await expect(gateway.callTool(token, "demo-module.resume.import", {})).resolves.toMatchObject({
      ok: false
    });
    expect(emitted).toEqual([
      expect.objectContaining({
        kind: "action_result",
        actionRequestId: handlerRequestIds[0],
        toolName: "demo-module.resume.import",
        outcome: "error",
        reason: "Tool demo-module.resume.import failed"
      })
    ]);
  });

  it("logs the real error for a write-tool handler throw, returns the sanitized string (#1251)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { gateway, token, handlerRequestIds } = createGateway({
        yolo: true,
        handlerError: true,
        handlerErrorMessage: "boom: handler internals"
      });

      const result = await gateway.callTool(token, "demo-module.resume.import", {});

      expect(result).toEqual({ ok: false, error: "Tool demo-module.resume.import failed" });
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const [logged] = errorSpy.mock.calls[0] as [string];
      const payload = JSON.parse(logged);
      expect(payload.event).toBe("tool_handler_threw");
      expect(payload.toolName).toBe("demo-module.resume.import");
      expect(payload.actorUserId).toBe("u1");
      expect(payload.requestId).toBe(handlerRequestIds[0]);
      expect(payload.error).toContain("boom: handler internals");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("redacts a secret in the logged error while the returned string never carries it (#1251)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const secretUrl = "postgres://user:hunter2@db.internal/app";
      const { gateway, token } = createGateway({
        yolo: true,
        handlerError: true,
        handlerErrorMessage: `connect failed: ${secretUrl}`
      });

      const result = await gateway.callTool(token, "demo-module.resume.import", {});

      expect(result).toEqual({ ok: false, error: "Tool demo-module.resume.import failed" });
      expect(JSON.stringify(result)).not.toContain("hunter2");
      const [logged] = errorSpy.mock.calls[0] as [string];
      const payload = JSON.parse(logged);
      expect(payload.error).not.toContain("hunter2");
      expect(payload.error).not.toContain("user:hunter2@");
      expect(payload.error).toContain("[redacted]");
    } finally {
      errorSpy.mockRestore();
    }
  });
});
