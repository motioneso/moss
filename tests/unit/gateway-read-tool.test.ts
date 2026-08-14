import { describe, expect, it, vi } from "vitest";

import { AssistantToolGateway } from "@moss/ai";
import type { ModuleAssistantToolManifest } from "@moss/module-sdk";

function makeDeps(overrides: Partial<ConstructorParameters<typeof AssistantToolGateway>[0]> = {}) {
  return {
    resolveActiveModules: vi.fn().mockResolvedValue([]),
    repository: {
      resolveAssistantAction: vi.fn(),
      createPendingAssistantAction: vi.fn()
    } as never,
    runner: {
      rootDb: {} as never,
      withDataContext: vi.fn(async (_ctx: unknown, fn: (db: never) => unknown) => fn({} as never))
    } as never,
    tokens: { verify: vi.fn(), mint: vi.fn() } as never,
    confirmations: {
      awaitResolution: vi.fn(),
      isAwaiting: vi.fn(),
      resolve: vi.fn()
    } as never,
    notifier: { emit: vi.fn() } as never,
    confirmTimeoutMs: 5000,
    ...overrides
  };
}

function makeReadTool(name: string, executeResult: unknown = { data: {} }) {
  return {
    id: "test-module",
    name: "Test",
    version: "0.1.0",
    publisher: "jarv1s",
    lifecycle: "required" as const,
    compatibility: { jarv1s: ">=0.0.0" },
    availability: { defaultEnabled: true, required: true },
    database: {
      migrations: [],
      migrationDirectories: [],
      ownedTables: [] as string[]
    },
    assistantTools: [
      {
        name,
        description: "A test read tool",
        permissionId: "test.view",
        risk: "read" as const,
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
        execute: vi.fn().mockResolvedValue(executeResult)
      } as ModuleAssistantToolManifest
    ]
  };
}

describe("AssistantToolGateway.runReadToolForActor", () => {
  it("rejects a non-read tool (fail closed on write risk)", async () => {
    const writeTool = {
      ...makeReadTool("bad.write").assistantTools[0],
      risk: "write" as const
    };
    const module = { ...makeReadTool("bad.write"), assistantTools: [writeTool] };
    const deps = makeDeps({
      resolveActiveModules: vi.fn().mockResolvedValue([module])
    });
    const gw = new AssistantToolGateway(deps);

    const result = await gw.runReadToolForActor("u1", "bad.write", {});

    expect(result.ok).toBe(false);
    if (!result.ok && "error" in result) {
      expect(result.error).toMatch(/not a read tool/i);
    }
  });

  it("returns error when tool is not found", async () => {
    const deps = makeDeps({ resolveActiveModules: vi.fn().mockResolvedValue([]) });
    const gw = new AssistantToolGateway(deps);

    const result = await gw.runReadToolForActor("u1", "notes.search", { query: "hi" });

    expect(result.ok).toBe(false);
  });

  it("executes through withDataContext and returns ok data", async () => {
    const module = makeReadTool("notes.search", { data: { chunks: [] } });
    const deps = makeDeps({
      resolveActiveModules: vi.fn().mockResolvedValue([module])
    });
    const gw = new AssistantToolGateway(deps);

    const result = await gw.runReadToolForActor("u1", "notes.search", { q: "remodel" });

    expect(result.ok).toBe(true);
    expect(deps.runner.withDataContext).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: "u1" }),
      expect.any(Function)
    );
  });

  it("routes read execution through the shared trust boundary", async () => {
    const module = makeReadTool("notes.search", { data: { chunks: [{ text: "unsafe" }] } });
    const execute = module.assistantTools[0]!.execute as ReturnType<typeof vi.fn>;
    const readToolTrustBoundary = vi.fn(async () => ({ data: { chunks: [] } }));
    const deps = makeDeps({
      resolveActiveModules: vi.fn().mockResolvedValue([module]),
      readToolTrustBoundary
    } as never);
    const gw = new AssistantToolGateway(deps);

    const result = await gw.runReadToolForActor("u1", "notes.search", { q: "remodel" });

    expect(result.ok).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(readToolTrustBoundary).toHaveBeenCalledOnce();
  });

  it("sanitizes handler throws (never leaks internals)", async () => {
    const tool = {
      ...makeReadTool("notes.search").assistantTools[0],
      execute: vi.fn().mockRejectedValue(new Error("DB secret: password123"))
    };
    const module = { ...makeReadTool("notes.search"), assistantTools: [tool] };
    const deps = makeDeps({
      resolveActiveModules: vi.fn().mockResolvedValue([module])
    });
    const gw = new AssistantToolGateway(deps);

    const result = await gw.runReadToolForActor("u1", "notes.search", {});

    expect(result.ok).toBe(false);
    if (!result.ok && "error" in result) {
      expect(result.error).not.toContain("password123");
    }
  });

  it("passes empty services to the read tool handler (write→confirm floor)", async () => {
    const executeFn = vi.fn().mockResolvedValue({ data: {} });
    const tool = { ...makeReadTool("notes.search").assistantTools[0], execute: executeFn };
    const module = { ...makeReadTool("notes.search"), assistantTools: [tool] };
    const deps = makeDeps({
      resolveActiveModules: vi.fn().mockResolvedValue([module]),
      toolServices: { someWriteService: { doSomething: vi.fn() } } as never
    });
    const gw = new AssistantToolGateway(deps);

    await gw.runReadToolForActor("u1", "notes.search", {});

    // 4th arg (services) must be {} — never the registered toolServices
    expect(executeFn).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      {}
    );
  });

  it("caps and recursively allow-lists app.getMapSlice output", async () => {
    const execute = vi.fn().mockResolvedValue({
      data: { kind: "screen", items: [], build: { version: "1", buildId: "x", secret: "drop" } }
    });
    const module = makeReadTool("app.getMapSlice");
    module.assistantTools[0] = {
      ...module.assistantTools[0]!,
      outputSchema: {
        type: "object",
        required: ["kind", "items", "build"],
        properties: {
          kind: { type: "string" },
          items: { type: "array", items: { type: "object", properties: {} } },
          build: {
            type: "object",
            required: ["version", "buildId"],
            properties: { version: { type: "string" }, buildId: { type: "string" } }
          }
        }
      },
      execute
    };
    const gw = new AssistantToolGateway(
      makeDeps({ resolveActiveModules: vi.fn().mockResolvedValue([module]) })
    );
    const result = await gw.runReadToolForActor("u1", "app.getMapSlice", { query: "news" });
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});
