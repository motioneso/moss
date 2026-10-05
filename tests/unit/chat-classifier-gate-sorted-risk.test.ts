import { describe, expect, it, vi } from "vitest";

import type { ClassifierDeps } from "@moss/ai";
import type { DataContextDb, DataContextRunner } from "@moss/db";
import type { ModuleAssistantToolRisk, MossModuleManifest } from "@moss/module-sdk";

import { meetsConfidenceBar } from "../../packages/chat/src/live/classifier-gate-arguments.js";
import { createClassifierGatePortsFactory } from "../../packages/chat/src/live/classifier-gate-wiring.js";

/**
 * #2984 R2.3, spec 8.3: a connected tool's sorted group sets the gate's confidence bar. The
 * synthetic manifest risk stays `outbound`; only an external tool's declared `sortedRisk` counts.
 */

const fakeDb = {} as DataContextDb;
const dataContext = {
  withDataContext: (_access: unknown, work: (db: DataContextDb) => Promise<unknown>) => work(fakeDb)
} as unknown as DataContextRunner;

function connectedTool(
  name: string,
  sortedRisk: ModuleAssistantToolRisk | undefined,
  isExternal = true
) {
  return {
    name,
    description: name,
    permissionId: "integrations.tool",
    risk: isExternal ? "outbound" : "write",
    isExternal,
    inputSchema: { type: "object", properties: {} },
    outputSchema: { type: "object", properties: { summary: { type: "string" } } },
    classifier: {
      description: name,
      replyTemplate: "{summary}",
      ...(sortedRisk ? { sortedRisk } : {})
    },
    execute: vi.fn()
  };
}

async function gateRisks(tools: ReturnType<typeof connectedTool>[]) {
  const manifest = {
    id: "integration-home",
    name: "Home",
    assistantTools: tools
  } as unknown as MossModuleManifest;
  const factory = createClassifierGatePortsFactory({
    resolveActiveModules: async () => [manifest],
    dataContext,
    gateway: { callToolForGate: vi.fn() } as never,
    classifierDeps: {
      repository: {
        resolveSortingModel: vi.fn(async () => null),
        resolveModelForService: vi.fn(),
        selectProviderWithCredential: vi.fn()
      },
      cipher: { decryptJson: vi.fn() }
    } as unknown as ClassifierDeps,
    now: () => 0
  });
  const listed = await factory("actor-1", "jst_gate").listTools();
  return Object.fromEntries(listed.map((tool) => [tool.name, tool.risk]));
}

describe("gate risk for a sorted connected tool", () => {
  it("uses the sorted group as the gate risk", async () => {
    expect(
      await gateRisks([
        connectedTool("home.change", "write"),
        connectedTool("home.send", "outbound"),
        connectedTool("home.sensitive", "destructive"),
        connectedTool("home.unsorted", undefined)
      ])
    ).toEqual({
      "home.change": "write",
      "home.send": "outbound",
      "home.sensitive": "destructive",
      "home.unsorted": "outbound"
    });
  });

  it("gives a Changes things tool and a Sensitive tool the 0.95 bar and refuses either below it", async () => {
    const risks = await gateRisks([
      connectedTool("home.change", "write"),
      connectedTool("home.sensitive", "destructive")
    ]);
    expect(meetsConfidenceBar(0.95, risks["home.change"]!)).toBe(true);
    expect(meetsConfidenceBar(0.94, risks["home.sensitive"]!)).toBe(false);
    expect(meetsConfidenceBar(0.95, risks["home.sensitive"]!)).toBe(true);
    expect(meetsConfidenceBar(0.94, risks["home.change"]!)).toBe(false);
  });

  it("never lowers a tool to the read bar", async () => {
    expect(await gateRisks([connectedTool("home.lookup", "read")])).toEqual({
      "home.lookup": "outbound"
    });
  });

  it("ignores a sorted group on a first-party tool", async () => {
    expect(await gateRisks([connectedTool("calendar.create", "destructive", false)])).toEqual({
      "calendar.create": "write"
    });
  });
});
