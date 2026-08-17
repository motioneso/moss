import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  AssistantToolGateway,
  ConfirmationRegistry,
  InvalidSessionTokenError,
  resolvePolicy,
  SessionTokenRegistry,
  type ActionPolicyLookup
} from "@moss/ai";
import type {
  ModuleAssistantToolManifest,
  MossModuleManifest,
  ToolContext,
  ToolResult
} from "@moss/module-sdk";

describe("module-sdk tool contract", () => {
  it("lets a module declare a tool with an execute handler", async () => {
    const ctx: ToolContext = { actorUserId: "u1", requestId: "r1", chatSessionId: "s1" };
    const tool: ModuleAssistantToolManifest = {
      name: "example.read",
      description: "Echo back a value.",
      permissionId: "example.view",
      risk: "read",
      inputSchema: { type: "object", properties: { value: { type: "string" } } },
      execute: async (_scopedDb, input): Promise<ToolResult> => ({ data: { echo: input.value } })
    };

    const result = await tool.execute!({} as never, { value: "hi" }, ctx);
    expect(result.data).toEqual({ echo: "hi" });
  });
});

describe("gateway policy", () => {
  const tool = (risk: ModuleAssistantToolManifest["risk"]) =>
    ({
      name: `example.${risk}`,
      description: "Fixture.",
      permissionId: "example.use",
      risk
    }) satisfies ModuleAssistantToolManifest;

  const dummyLookup: ActionPolicyLookup = {
    getFamilyTier: async () => null,
    getFamilyManifest: async () => null
  };

  it("runs reads and always confirms destructive tools", async () => {
    await expect(resolvePolicy(tool("read"), "example", false, dummyLookup)).resolves.toBe("run");
    await expect(
      resolvePolicy(
        { ...tool("destructive"), executionPolicy: "auto" },
        "example",
        false,
        dummyLookup
      )
    ).resolves.toBe("confirm");
  });
});

describe("session token registry", () => {
  it("mints a token that resolves to its identity, and fails after revoke", () => {
    const registry = new SessionTokenRegistry();
    const token = registry.mint({ actorUserId: "u1", chatSessionId: "s1", allowedToolNames: null });

    expect(registry.verify(token)).toEqual({
      actorUserId: "u1",
      chatSessionId: "s1",
      allowedToolNames: null
    });

    registry.revoke(token);
    expect(() => registry.verify(token)).toThrow(InvalidSessionTokenError);
    expect(() => registry.verify("never-minted")).toThrow(InvalidSessionTokenError);
  });

  it("expires a token once its TTL elapses with no activity", () => {
    let nowMs = 1_000;
    const registry = new SessionTokenRegistry({ clock: { now: () => nowMs }, ttlMs: 10_000 });
    const token = registry.mint({ actorUserId: "u1", chatSessionId: "s1", allowedToolNames: null });

    nowMs += 9_999;
    expect(registry.verify(token).actorUserId).toBe("u1"); // still inside window

    // verify() slid the window forward; advance past the *new* expiry.
    nowMs += 10_000;
    expect(() => registry.verify(token)).toThrow(InvalidSessionTokenError);
    // A second verify on the same (now-deleted) token still fails.
    expect(() => registry.verify(token)).toThrow(InvalidSessionTokenError);
  });

  it("verify() slides the TTL so an in-use token never expires mid-flight", () => {
    let nowMs = 0;
    const registry = new SessionTokenRegistry({ clock: { now: () => nowMs }, ttlMs: 10_000 });
    const token = registry.mint({ actorUserId: "u1", chatSessionId: "s1", allowedToolNames: null });

    // Verify every 9s for a "long turn" well past one TTL window — it stays valid.
    for (let i = 0; i < 20; i++) {
      nowMs += 9_000;
      expect(registry.verify(token).actorUserId).toBe("u1");
    }
  });

  it("touchBySessionId refreshes the TTL for an active-but-tool-idle session", () => {
    let nowMs = 0;
    const registry = new SessionTokenRegistry({ clock: { now: () => nowMs }, ttlMs: 10_000 });
    const token = registry.mint({ actorUserId: "u1", chatSessionId: "s1", allowedToolNames: null });

    nowMs += 9_000;
    registry.touchBySessionId("s1"); // chat activity, no tool call
    nowMs += 9_000; // 18s since mint, but only 9s since touch
    expect(registry.verify(token).actorUserId).toBe("u1");

    // touch only affects the matching session.
    nowMs += 9_000;
    registry.touchBySessionId("other-session");
    nowMs += 2_000;
    expect(() => registry.verify(token)).toThrow(InvalidSessionTokenError);
  });

  it("sweeps expired entries on mint so orphaned tokens cannot accumulate", () => {
    let nowMs = 0;
    const registry = new SessionTokenRegistry({ clock: { now: () => nowMs }, ttlMs: 10_000 });
    const orphan = registry.mint({
      actorUserId: "u1",
      chatSessionId: "s1",
      allowedToolNames: null
    });

    nowMs += 20_000; // orphan now expired, never revoked
    // A fresh mint sweeps the expired orphan; verifying it confirms it is gone.
    registry.mint({ actorUserId: "u2", chatSessionId: "s2", allowedToolNames: null });
    expect(() => registry.verify(orphan)).toThrow(InvalidSessionTokenError);
  });
});

describe("confirmation registry", () => {
  it("settles an awaited id with the resolved status", async () => {
    const registry = new ConfirmationRegistry();
    const pending = registry.awaitResolution("a1", 1000);
    expect(registry.resolve("a1", "confirmed")).toBe(true);
    await expect(pending).resolves.toBe("confirmed");
  });

  it("returns 'timeout' when not resolved in time", async () => {
    const registry = new ConfirmationRegistry();
    await expect(registry.awaitResolution("a2", 10)).resolves.toBe("timeout");
  });

  it("ignores resolve for an unknown id", () => {
    const registry = new ConfirmationRegistry();
    expect(() => registry.resolve("nope", "confirmed")).not.toThrow();
    expect(registry.resolve("nope", "confirmed")).toBe(false);
  });

  it("reports isAwaiting only while a call is blocked", async () => {
    const registry = new ConfirmationRegistry();
    expect(registry.isAwaiting("a3")).toBe(false);

    const pending = registry.awaitResolution("a3", 1000);
    expect(registry.isAwaiting("a3")).toBe(true);

    registry.resolve("a3", "confirmed");
    await pending;
    // Once settled, the waiter is gone — a later Approve would be a no-op.
    expect(registry.isAwaiting("a3")).toBe(false);
  });

  it("resolve() returns false after the wait already timed out (confirm-after-timeout no-op)", async () => {
    const registry = new ConfirmationRegistry();
    // Wait expires; the waiter is deleted on timeout.
    await expect(registry.awaitResolution("a4", 5)).resolves.toBe("timeout");
    expect(registry.isAwaiting("a4")).toBe(false);
    // An Approve arriving after the timeout finds no live waiter → false (never executes).
    expect(registry.resolve("a4", "confirmed")).toBe(false);
  });
});

describe("native Claude tool permission bridge", () => {
  it("stores a reserved native-tool action request and resolves approval through ConfirmationRegistry", async () => {
    const tokens = new SessionTokenRegistry();
    const confirmations = new ConfirmationRegistry();
    const emitted: unknown[] = [];
    const created: unknown[] = [];
    const gateway = new AssistantToolGateway({
      resolveActiveModules: async () => [],
      repository: {
        createPendingAssistantAction: async (_db: unknown, input: unknown) => {
          created.push(input);
          return { id: "native-action-1" };
        }
      } as never,
      runner: {
        withDataContext: async (_access: unknown, work: (db: unknown) => Promise<unknown>) =>
          work({})
      } as never,
      tokens,
      confirmations,
      notifier: { emit: (_chatSessionId, record) => emitted.push(record) },
      confirmTimeoutMs: 1000
    });
    const token = tokens.mint({ actorUserId: "u1", chatSessionId: "s1", allowedToolNames: null });

    const pending = gateway.requestNativeToolPermission(token, {
      toolName: "Bash",
      toolInput: { command: "echo hi" }
    });
    await vi.waitFor(() => expect(emitted).toHaveLength(1));
    expect(created[0]).toMatchObject({
      toolModuleId: "claude-native",
      toolModuleName: "Claude Native Tools",
      toolName: "Bash",
      permissionId: "claude-native.Bash",
      risk: "destructive"
    });
    expect(emitted[0]).toMatchObject({
      kind: "action_request",
      actionRequestId: "native-action-1",
      toolName: "Bash"
    });

    confirmations.resolve("native-action-1", "confirmed");

    await expect(pending).resolves.toEqual({
      decision: "allow",
      reason: "Approved by user."
    });

    // #1661: this used to be "executed". The method decides PERMISSION and returns
    // `decision: "allow"`; the tool then runs outside the gateway, which never learns the result.
    // So "executed" announced a completion on the strength of the user's own click. The YOLO
    // branch already reported "allowed" for exactly this reason; this branch did not.
    await vi.waitFor(() => expect(emitted).toHaveLength(2));
    expect(emitted[1]).toMatchObject({
      kind: "action_result",
      actionRequestId: "native-action-1",
      toolName: "Bash",
      outcome: "allowed"
    });
  });

  it("denies native tool permission on confirmation timeout", async () => {
    const tokens = new SessionTokenRegistry();
    const emitted: unknown[] = [];
    const gateway = new AssistantToolGateway({
      resolveActiveModules: async () => [],
      repository: {
        createPendingAssistantAction: async () => ({ id: "native-action-timeout" })
      } as never,
      runner: {
        withDataContext: async (_access: unknown, work: (db: unknown) => Promise<unknown>) =>
          work({})
      } as never,
      tokens,
      confirmations: new ConfirmationRegistry(),
      notifier: { emit: (_chatSessionId, record) => emitted.push(record) },
      confirmTimeoutMs: 5
    });
    const token = tokens.mint({ actorUserId: "u1", chatSessionId: "s1", allowedToolNames: null });

    await expect(
      gateway.requestNativeToolPermission(token, {
        toolName: "Write",
        toolInput: { file_path: "/x" }
      })
    ).resolves.toEqual({
      decision: "deny",
      reason: "Timed out awaiting confirmation."
    });
    expect(emitted.at(-1)).toMatchObject({
      kind: "action_result",
      actionRequestId: "native-action-timeout",
      toolName: "Write",
      outcome: "denied"
    });
  });

  it("auto-allows read-only native meta-tools without a pending action or notifier event (#1158)", async () => {
    // #1158: claude MUST call ToolSearch to load deferred MCP tool schemas before it can use
    // any jarvis tool. Routing it through the confirm flow deadlocked prod (150s confirm wait
    // == 150s hook deadline → fail-closed deny → retry stall → watchdog kill).
    const tokens = new SessionTokenRegistry();
    const emitted: unknown[] = [];
    const created: unknown[] = [];
    const gateway = new AssistantToolGateway({
      resolveActiveModules: async () => [],
      repository: {
        createPendingAssistantAction: async (_db: unknown, input: unknown) => {
          created.push(input);
          return { id: "native-action-x" };
        }
      } as never,
      runner: {
        withDataContext: async (_access: unknown, work: (db: unknown) => Promise<unknown>) =>
          work({})
      } as never,
      tokens,
      confirmations: new ConfirmationRegistry(),
      notifier: { emit: (_chatSessionId, record) => emitted.push(record) },
      confirmTimeoutMs: 5
    });
    const token = tokens.mint({ actorUserId: "u1", chatSessionId: "s1", allowedToolNames: null });

    await expect(
      gateway.requestNativeToolPermission(token, {
        toolName: "ToolSearch",
        toolInput: { query: "select:mcp__jarvis__calendar_listVisibleEvents" }
      })
    ).resolves.toEqual({ decision: "allow", reason: "Read-only native tool." });

    // No pending action row (ToolSearch fires many times per conversation — a row per call
    // is audit spam for a tool that cannot mutate anything) and no notifier traffic.
    expect(created).toHaveLength(0);
    expect(emitted).toHaveLength(0);
  });

  it("still routes unlisted native tools through the confirm flow (#1158)", async () => {
    // "Grep" is read-only in claude but intentionally NOT in NATIVE_READONLY_AUTO_ALLOW —
    // the allowlist stays minimal; anything unlisted keeps the confirm path (here: timeout→deny).
    const tokens = new SessionTokenRegistry();
    const gateway = new AssistantToolGateway({
      resolveActiveModules: async () => [],
      repository: {
        createPendingAssistantAction: async () => ({ id: "native-action-grep" })
      } as never,
      runner: {
        withDataContext: async (_access: unknown, work: (db: unknown) => Promise<unknown>) =>
          work({})
      } as never,
      tokens,
      confirmations: new ConfirmationRegistry(),
      notifier: { emit: () => undefined },
      confirmTimeoutMs: 5
    });
    const token = tokens.mint({ actorUserId: "u1", chatSessionId: "s1", allowedToolNames: null });

    await expect(
      gateway.requestNativeToolPermission(token, { toolName: "Grep", toolInput: {} })
    ).resolves.toEqual({ decision: "deny", reason: "Timed out awaiting confirmation." });
  });

  it.each([
    ["Edit", { file_path: "src/a.ts", old_string: "a", new_string: "b" }],
    ["Write", { file_path: "src/a.ts", content: "hello" }],
    ["NotebookEdit", { notebook_path: "notes/a.ipynb", new_source: "hello" }]
  ])("auto-grants allowlisted %s when yoloMode is true", async (toolName, toolInput) => {
    const workingDirectory = await mkdtemp(join(tmpdir(), "jarvis-native-yolo-"));
    const tokens = new SessionTokenRegistry();
    const emitted: unknown[] = [];
    const created: unknown[] = [];
    const resolved: unknown[] = [];
    let createPendingCalled = false;
    const gateway = new AssistantToolGateway({
      resolveActiveModules: async () => [],
      repository: {
        createPendingAssistantAction: async (_db: unknown, input: unknown) => {
          createPendingCalled = true;
          created.push(input);
          return { id: "native-yolo-1" };
        },
        resolveAssistantAction: async (_db: unknown, id: string, input: unknown) => {
          resolved.push({ id, input });
          return { id };
        }
      } as never,
      runner: {
        withDataContext: async (_access: unknown, work: (db: unknown) => Promise<unknown>) =>
          work({})
      } as never,
      tokens,
      confirmations: new ConfirmationRegistry(),
      notifier: { emit: (_chatSessionId, record) => emitted.push(record) },
      confirmTimeoutMs: 50,
      yoloMode: async () => true
    });
    const token = tokens.mint({ actorUserId: "u1", chatSessionId: "c1", allowedToolNames: null });

    const result = await gateway.requestNativeToolPermission(token, {
      toolName,
      toolInput,
      workingDirectory
    });

    expect(result).toEqual({ decision: "allow", reason: "Allowed by YOLO." });
    expect(createPendingCalled).toBe(true);
    expect(emitted).toEqual([
      expect.objectContaining({
        kind: "action_result",
        actionRequestId: "native-yolo-1",
        toolName,
        outcome: "allowed"
      })
    ]);
    // #1085 F4: the awaited confirmed action records the grant without claiming the native tool
    // completed successfully; returning before these writes would recreate the audit gap.
    expect(created[0]).toMatchObject({
      inputSummary: {
        inputKeys: Object.keys(toolInput).sort(),
        inputKeyCount: Object.keys(toolInput).length,
        truncated: false
      }
    });
    expect(resolved).toEqual([{ id: "native-yolo-1", input: { status: "confirmed" } }]);
    await rm(workingDirectory, { recursive: true, force: true });
  });

  it.each(["Bash", "Task", "Read", "Grep", "Glob", "FutureTool", "", "   "])(
    "keeps %j behind confirmation under YOLO",
    async (toolName) => {
      const tokens = new SessionTokenRegistry();
      const confirmations = new ConfirmationRegistry();
      const emitted: unknown[] = [];
      const gateway = new AssistantToolGateway({
        resolveActiveModules: async () => [],
        repository: {
          createPendingAssistantAction: async () => ({ id: "pending_gated" }),
          insertActionAuditLog: async () => {}
        } as never,
        runner: {
          withDataContext: async (_access: unknown, work: (db: unknown) => Promise<unknown>) =>
            work({})
        } as never,
        tokens,
        confirmations,
        notifier: { emit: (_chatSessionId, record) => emitted.push(record) },
        confirmTimeoutMs: 50,
        yoloMode: async () => true
      });
      const token = tokens.mint({ actorUserId: "u1", chatSessionId: "c1", allowedToolNames: null });

      const pending = gateway.requestNativeToolPermission(token, {
        toolName,
        toolInput: { file_path: "src/a.ts", command: "echo hi" },
        workingDirectory: "/workspace"
      });
      await vi.waitFor(() =>
        expect(emitted).toContainEqual(
          expect.objectContaining({
            kind: "action_request",
            toolName: toolName.trim() || "Unknown"
          })
        )
      );
      confirmations.resolve("pending_gated", "rejected");
      await expect(pending).resolves.toMatchObject({ decision: "deny" });
    }
  );

  it.each([
    ".claude/settings.json",
    "nested/../CLAUDE.md",
    ".mcp.json",
    "settings.local.json",
    "keybindings.json",
    // #1085 F2: these files are the permission hook/config/token boundary even without a
    // .claude path segment, so each basename must remain behind confirmation.
    ".jarvis-claude-permission-hook.mjs",
    ".jarvis-claude-settings.json",
    ".jarvis-claude-permission-token",
    ".claude.json"
  ])("keeps config target %s behind confirmation under YOLO", async (filePath) => {
    const workingDirectory = await mkdtemp(join(tmpdir(), "jarvis-native-yolo-"));
    const tokens = new SessionTokenRegistry();
    const confirmations = new ConfirmationRegistry();
    const emitted: unknown[] = [];
    const gateway = new AssistantToolGateway({
      resolveActiveModules: async () => [],
      repository: {
        createPendingAssistantAction: async () => ({ id: "pending_config" }),
        insertActionAuditLog: async () => {}
      } as never,
      runner: {
        withDataContext: async (_access: unknown, work: (db: unknown) => Promise<unknown>) =>
          work({})
      } as never,
      tokens,
      confirmations,
      notifier: { emit: (_chatSessionId, record) => emitted.push(record) },
      confirmTimeoutMs: 50,
      yoloMode: async () => true
    });
    const token = tokens.mint({ actorUserId: "u1", chatSessionId: "c1", allowedToolNames: null });

    const pending = gateway.requestNativeToolPermission(token, {
      toolName: "Write",
      toolInput: { file_path: filePath, content: "unsafe" },
      workingDirectory
    });
    await vi.waitFor(() =>
      expect(emitted).toContainEqual(expect.objectContaining({ kind: "action_request" }))
    );
    confirmations.resolve("pending_config", "rejected");
    await expect(pending).resolves.toMatchObject({ decision: "deny" });
    await rm(workingDirectory, { recursive: true, force: true });
  });

  it("keeps outside-cwd and symlinked .claude writes behind confirmation under YOLO", async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), "jarvis-native-yolo-"));
    await mkdir(join(workingDirectory, ".claude"));
    await symlink(join(workingDirectory, ".claude"), join(workingDirectory, "safe-looking"));

    const tokens = new SessionTokenRegistry();
    const confirmations = new ConfirmationRegistry();
    const emitted: Array<{ kind: string; actionRequestId?: string }> = [];
    let actionNumber = 0;
    const gateway = new AssistantToolGateway({
      resolveActiveModules: async () => [],
      repository: {
        createPendingAssistantAction: async () => ({ id: `pending_path_${++actionNumber}` }),
        insertActionAuditLog: async () => {}
      } as never,
      runner: {
        withDataContext: async (_access: unknown, work: (db: unknown) => Promise<unknown>) =>
          work({})
      } as never,
      tokens,
      confirmations,
      notifier: { emit: (_chatSessionId, record) => emitted.push(record) },
      confirmTimeoutMs: 50,
      yoloMode: async () => true
    });
    const token = tokens.mint({ actorUserId: "u1", chatSessionId: "c1", allowedToolNames: null });

    const expectGated = async (filePath: string) => {
      const pending = gateway.requestNativeToolPermission(token, {
        toolName: "Write",
        toolInput: { file_path: filePath, content: "unsafe" },
        workingDirectory
      });
      await vi.waitFor(() => expect(emitted.at(-1)).toMatchObject({ kind: "action_request" }));
      const actionRequestId = emitted.at(-1)?.actionRequestId;
      if (!actionRequestId) throw new Error("expected action request id");
      confirmations.resolve(actionRequestId, "rejected");
      await expect(pending).resolves.toMatchObject({ decision: "deny" });
    };

    // #1085 F3: both lexical workspace escape and realpath-resolved .claude escape must remain
    // gated; either route can turn a nominal Write into deferred command execution.
    await expectGated(join(dirname(workingDirectory), ".bashrc"));
    await expectGated("safe-looking/innocent.ts");
    await rm(workingDirectory, { recursive: true, force: true });
  });

  it.each([
    ["false", async () => false],
    ["missing resolver", undefined],
    [
      "resolver throws",
      async () => {
        throw new Error("boom");
      }
    ]
  ])("falls back to normal confirmation when yoloMode is %s", async (_label, yoloMode) => {
    const tokens = new SessionTokenRegistry();
    const confirmations = new ConfirmationRegistry();
    const emitted: unknown[] = [];
    const gateway = new AssistantToolGateway({
      resolveActiveModules: async () => [],
      repository: {
        createPendingAssistantAction: async () => ({ id: "pending_1" }),
        insertActionAuditLog: async () => {}
      } as never,
      runner: {
        withDataContext: async (_access: unknown, work: (db: unknown) => Promise<unknown>) =>
          work({})
      } as never,
      tokens,
      confirmations,
      notifier: { emit: (_chatSessionId, record) => emitted.push(record) },
      confirmTimeoutMs: 50,
      yoloMode
    });
    const token = tokens.mint({ actorUserId: "u1", chatSessionId: "c1", allowedToolNames: null });

    const pending = gateway.requestNativeToolPermission(token, {
      toolName: "Write",
      toolInput: { file_path: "src/a.ts" },
      workingDirectory: "/workspace"
    });

    await vi.waitFor(() => expect(emitted).toHaveLength(1));
    const requestRecord = emitted.find(
      (r): r is { actionRequestId: string } =>
        typeof r === "object" && r !== null && (r as { kind?: string }).kind === "action_request"
    );
    expect(requestRecord).toBeDefined();
    confirmations.resolve(requestRecord!.actionRequestId, "confirmed");
    const result = await pending;
    expect(result.decision).toBe("allow");
    // #1661: was "executed". What this test is really checking is that the non-YOLO path still
    // reaches a normal confirmation and is allowed — and "allowed" is the honest word for it,
    // since the gateway grants permission here and never sees the tool run.
    expect(emitted).toContainEqual(
      expect.objectContaining({ kind: "action_result", outcome: "allowed" })
    );
  });
});

describe("gateway audit outcome truth (#1252)", () => {
  function manifestWithTool(
    toolOverrides: Partial<ModuleAssistantToolManifest> & {
      execute: ModuleAssistantToolManifest["execute"];
    }
  ): MossModuleManifest {
    return {
      id: "acme",
      name: "Acme",
      version: "1.0.0",
      publisher: "Acme",
      lifecycle: "optional",
      compatibility: { jarv1s: ">=0.0.0" },
      assistantTools: [
        {
          name: "acme.write",
          description: "Write",
          permissionId: "acme.write",
          risk: "write",
          ...toolOverrides
        }
      ]
    };
  }

  async function runYoloAndCaptureAudit(
    toolOverrides: Partial<ModuleAssistantToolManifest> & {
      execute: ModuleAssistantToolManifest["execute"];
    }
  ): Promise<{ outcome: string; errorClass: string | null }> {
    const audits: { outcome: string; errorClass: string | null }[] = [];
    const tokens = new SessionTokenRegistry();
    const confirmations = new ConfirmationRegistry();
    const gateway = new AssistantToolGateway({
      resolveActiveModules: async () => [manifestWithTool(toolOverrides)],
      repository: {
        insertActionAuditLog: async (
          _db: unknown,
          input: { outcome: string; errorClass: string | null }
        ) => {
          audits.push({ outcome: input.outcome, errorClass: input.errorClass });
        }
      } as never,
      runner: {
        withDataContext: async (_access: unknown, work: (db: unknown) => Promise<unknown>) =>
          work({})
      } as never,
      tokens,
      confirmations,
      notifier: { emit: () => {} },
      confirmTimeoutMs: 50,
      yoloMode: async () => true
    });
    const token = tokens.mint({ actorUserId: "u1", chatSessionId: "c1", allowedToolNames: null });
    await gateway.callTool(token, "acme.write", {});
    await vi.waitFor(() => expect(audits).toHaveLength(1));
    return audits[0]!;
  }

  it.each([
    ["status: error", { status: "error" }],
    ["ok: false", { ok: false }],
    ["error: <string>", { error: "boom" }]
  ])(
    "audits a %s handler payload as failed/module_reported (external tool)",
    async (_label, data) => {
      const audit = await runYoloAndCaptureAudit({
        execute: async (): Promise<ToolResult> => ({ data })
      });
      expect(audit).toEqual({ outcome: "failed", errorClass: "module_reported" });
    }
  );

  it("audits a normal success payload as success/null (external tool)", async () => {
    const audit = await runYoloAndCaptureAudit({
      execute: async (): Promise<ToolResult> => ({ data: { written: true } })
    });
    expect(audit).toEqual({ outcome: "success", errorClass: null });
  });

  it("does not apply module-reported detection to a first-party tool (isExternal: false)", async () => {
    const audit = await runYoloAndCaptureAudit({
      isExternal: false,
      execute: async (): Promise<ToolResult> => ({ data: { status: "error" } })
    });
    expect(audit).toEqual({ outcome: "success", errorClass: null });
  });

  it("still audits a handler throw as failed/handler_error", async () => {
    const audit = await runYoloAndCaptureAudit({
      execute: async (): Promise<ToolResult> => {
        throw new Error("boom");
      }
    });
    expect(audit).toEqual({ outcome: "failed", errorClass: "handler_error" });
  });
});
