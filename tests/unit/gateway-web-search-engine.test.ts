import { describe, expect, it, vi } from "vitest";

import { AssistantToolGateway } from "@moss/ai";
import type { MossModuleManifest } from "@moss/module-sdk";

// #2228 fix round 1, finding 2: chat turns only ever run through a CLI engine whose own search
// is blocked by the permission hook, so the web.search tool (backed by Brave or by the actor's
// model-native provider) is the ONLY chat search path. It must be offered whenever any engine is
// active and hidden only when the actor has no engine at all.

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

const webResearchModule = {
  id: "web-research",
  name: "Web research",
  version: "1.0.0",
  description: "",
  assistantTools: [
    {
      name: "web.search",
      description: "Search the web",
      risk: "read" as const,
      inputSchema: { type: "object", properties: { query: { type: "string" } } },
      execute: vi.fn(async () => ({ data: { results: [] } }))
    },
    {
      name: "web.read",
      description: "Read a page",
      risk: "read" as const,
      inputSchema: { type: "object", properties: { url: { type: "string" } } },
      execute: vi.fn(async () => ({ data: { text: "" } }))
    }
  ]
} as unknown as MossModuleManifest;

async function toolNames(engine: "brave" | "model-native" | "none" | undefined) {
  const gw = new AssistantToolGateway(
    makeDeps({
      resolveActiveModules: vi.fn().mockResolvedValue([webResearchModule]),
      ...(engine ? { webSearchEngineForActor: vi.fn().mockResolvedValue(engine) } : {})
    })
  );
  return (await gw.listToolsForActor("u1")).map((tool) => tool.name);
}

describe("AssistantToolGateway web.search listing per engine (#2228)", () => {
  it("offers web.search when Brave is the engine", async () => {
    expect(await toolNames("brave")).toEqual(["web.search", "web.read"]);
  });

  it("offers web.search when the actor's model-native provider is the engine", async () => {
    expect(await toolNames("model-native")).toEqual(["web.search", "web.read"]);
  });

  it("hides web.search only when the actor has no engine at all", async () => {
    expect(await toolNames("none")).toEqual(["web.read"]);
  });

  it("lists web.search when no engine resolver is injected (pre-#2228 behaviour)", async () => {
    expect(await toolNames(undefined)).toEqual(["web.search", "web.read"]);
  });
});
