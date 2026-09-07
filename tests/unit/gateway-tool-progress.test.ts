import { describe, expect, it, vi } from "vitest";

import { AssistantToolGateway } from "@moss/ai";
import type { ModuleAssistantToolManifest, ToolContext } from "@moss/module-sdk";
import { createProgressSink } from "../../packages/chat/src/mcp-transport.js";

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

function progressTool(seen: ToolContext[]) {
  return {
    id: "test-module",
    name: "Test",
    version: "0.1.0",
    publisher: "jarv1s",
    lifecycle: "required" as const,
    compatibility: { jarv1s: ">=0.0.0" },
    availability: { defaultEnabled: true, required: true },
    database: { migrations: [], migrationDirectories: [], ownedTables: [] as string[] },
    assistantTools: [
      {
        name: "example.streamingRead",
        description: "A read tool that streams partial output.",
        permissionId: "test.view",
        risk: "read" as const,
        inputSchema: { type: "object", properties: {} },
        execute: async (_scopedDb: unknown, _input: unknown, ctx: ToolContext) => {
          seen.push(ctx);
          ctx.reportProgress?.({ message: "first chunk" });
          ctx.reportProgress?.({ message: "second chunk" });
          return { data: { done: true } };
        }
      } as ModuleAssistantToolManifest
    ]
  };
}

describe("gateway tool progress", () => {
  it("hands the transport sink to the tool through ctx.reportProgress", async () => {
    const seen: ToolContext[] = [];
    const module = progressTool(seen);
    const messages: string[] = [];
    const deps = makeDeps({
      resolveActiveModules: vi.fn().mockResolvedValue([module]),
      tokens: {
        verify: vi.fn().mockReturnValue({
          actorUserId: "u1",
          chatSessionId: "s1",
          allowedToolNames: null
        }),
        mint: vi.fn()
      } as never
    });
    const gw = new AssistantToolGateway(deps);

    const result = await gw.callTool("tok", "example.streamingRead", {}, {
      onProgress: (message) => messages.push(message)
    });

    expect(result.ok).toBe(true);
    expect(messages).toEqual(["first chunk", "second chunk"]);
    expect(typeof seen[0]?.reportProgress).toBe("function");
  });

  it("leaves reportProgress absent without a sink, so the tool sends nowhere", async () => {
    const seen: ToolContext[] = [];
    const module = progressTool(seen);
    const deps = makeDeps({
      resolveActiveModules: vi.fn().mockResolvedValue([module]),
      tokens: {
        verify: vi.fn().mockReturnValue({
          actorUserId: "u1",
          chatSessionId: "s1",
          allowedToolNames: null
        }),
        mint: vi.fn()
      } as never
    });
    const gw = new AssistantToolGateway(deps);

    const result = await gw.callTool("tok", "example.streamingRead", {});

    expect(result.ok).toBe(true);
    expect(seen[0]?.reportProgress).toBeUndefined();
  });
});

describe("createProgressSink", () => {
  function framesOf(chunks: string[]) {
    return chunks.map((chunk) => JSON.parse(chunk.replace(/^data: /, "")));
  }

  it("queues messages before attach and flushes them in order with the token", () => {
    const sink = createProgressSink("tok-1");
    sink.onProgress("early one");
    sink.onProgress("early two");

    const written: string[] = [];
    const raw = { write: (chunk: string) => written.push(chunk) } as never;
    sink.attach(raw);
    sink.onProgress("live three");

    const frames = framesOf(written);
    expect(frames).toHaveLength(3);
    expect(frames.map((frame) => frame.method)).toEqual([
      "notifications/progress",
      "notifications/progress",
      "notifications/progress"
    ]);
    expect(frames.map((frame) => frame.params.progressToken)).toEqual(["tok-1", "tok-1", "tok-1"]);
    expect(frames.map((frame) => frame.params.message)).toEqual([
      "early one",
      "early two",
      "live three"
    ]);
    expect(frames.map((frame) => frame.params.progress)).toEqual([1, 2, 3]);
  });

  it("stops writing after the stream errors instead of throwing", () => {
    const sink = createProgressSink(7);
    let calls = 0;
    const raw = {
      write: () => {
        calls += 1;
        throw new Error("closed");
      }
    } as never;
    sink.attach(raw);

    expect(() => sink.onProgress("lost")).not.toThrow();
    expect(calls).toBe(1);
    expect(() => sink.onProgress("also lost")).not.toThrow();
    expect(calls).toBe(1);
  });
});
