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

describe("logical action terminal results", () => {
  const createGateway = (input: {
    yolo: boolean;
    handlerError?: boolean;
    handlerThrownValue?: unknown;
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
                  throw input.handlerThrownValue ?? new Error("private handler detail");
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

  describe("handler throw logging (#1251)", () => {
    it.each([
      {
        label: "read",
        event: "read_tool_handler_threw",
        toolName: "demo-module.notes.search",
        invoke: async (thrown: unknown) => {
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
                      throw thrown;
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
          return gateway.runReadToolForActor("u1", "demo-module.notes.search", {});
        }
      },
      {
        label: "write",
        event: "tool_handler_threw",
        toolName: "demo-module.resume.import",
        invoke: async (thrown: unknown) => {
          const { gateway, token } = createGateway({
            yolo: true,
            handlerError: true,
            handlerThrownValue: thrown
          });
          return gateway.callTool(token, "demo-module.resume.import", {});
        }
      }
    ])(
      "fails closed without inspecting a hostile $label handler throw",
      async ({ event, toolName, invoke }) => {
        const sentinel = "handler-secret-sentinel";
        let trapCalls = 0;
        const thrown = new Proxy(
          { sentinel },
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
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

        try {
          const result = await invoke(thrown);

          expect(result).toEqual({ ok: false, error: `Tool ${toolName} failed` });
          expect(trapCalls).toBe(0);
          expect(errorSpy).toHaveBeenCalledExactlyOnceWith(expect.any(String));
          const payload = JSON.parse(errorSpy.mock.calls[0]![0] as string);
          expect(payload).toEqual({
            event,
            toolName,
            requestId: expect.any(String),
            errorClass: "handler_error"
          });
          expect(JSON.stringify({ result, logged: errorSpy.mock.calls })).not.toContain(sentinel);
        } finally {
          errorSpy.mockRestore();
        }
      }
    );
  });
});
