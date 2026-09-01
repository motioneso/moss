import { describe, expect, it } from "vitest";

import type { DataContextRunner } from "@moss/db";
import {
  createIntegrationsCipher,
  createIntegrationsActiveModulesResolver
} from "@moss/integrations";
import type { ConnectionRow } from "@moss/integrations";
import type { DiscoveredTool } from "@moss/integrations";

function tool(
  name: string,
  group: string,
  inputSchema: Record<string, unknown> | null = {}
): DiscoveredTool {
  return { name, description: name, group, inputSchema };
}

function connection(overrides: Partial<ConnectionRow>): ConnectionRow {
  return {
    id: "id",
    ownerUserId: "owner",
    name: "connection",
    kind: "mcp",
    transport: "http",
    url: "http://example.com",
    credentialPlacement: null,
    hasCredential: false,
    enabled: true,
    baseUrl: null,
    specPasted: false,
    enabledGroups: [],
    enabledTools: [],
    mutedTools: [],
    unsuppressedTools: [],
    discoveredTools: [],
    lastDiscoveryAt: null,
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides
  };
}

function fakeDataContext(): DataContextRunner {
  return {
    withDataContext: async (_ctx: unknown, work: (scopedDb: unknown) => unknown) => work({})
  } as unknown as DataContextRunner;
}

describe("createIntegrationsActiveModulesResolver", () => {
  it("appends synthetic modules for enabled connections without touching the base list", async () => {
    const warnings: { connection: unknown; tool: unknown }[] = [];
    const logger = {
      warn: (obj: Record<string, unknown>) =>
        warnings.push({ connection: obj.connection, tool: obj.tool })
    };

    const largeGroupTools = Array.from({ length: 31 }, (_, i) =>
      tool(`t${i}`, i < 4 ? "Live" : "Other")
    );

    const connections: ConnectionRow[] = [
      connection({
        id: "conn-home-assistant",
        name: "Home Assistant",
        kind: "mcp",
        discoveredTools: [
          tool("turn_on", ""),
          tool("turn_off", ""),
          tool("bad_schema", "", { anyOf: [{ type: "string" }] })
        ]
      }),
      connection({
        id: "conn-disabled",
        name: "Disabled Thing",
        enabled: false,
        discoveredTools: [tool("should_not_appear", "")]
      }),
      connection({
        id: "conn-large",
        name: "Large API",
        kind: "openapi",
        baseUrl: "http://large.example.com",
        discoveredTools: largeGroupTools,
        enabledGroups: ["Live"]
      })
    ];

    const baseModule = { id: "base", name: "Base" } as never;
    const resolver = createIntegrationsActiveModulesResolver(async () => [baseModule], {
      dataContext: fakeDataContext(),
      cipher: createIntegrationsCipher(),
      logger,
      repository: { listConnections: async () => connections } as never
    });

    const modules = await resolver("actor-1");

    expect(modules[0]).toBe(baseModule);
    expect(modules).toHaveLength(3); // base + home-assistant + large-api (disabled contributes nothing)

    const homeAssistant = modules.find((m) => m.id === "integration-home-assistant")!;
    const toolNames = (homeAssistant.assistantTools ?? []).map((t) => t.name);
    expect(toolNames).toEqual(["home-assistant.turn_on", "home-assistant.turn_off"]);
    expect(toolNames).not.toContain("home-assistant.bad_schema");
    expect(warnings).toEqual([{ connection: "Home Assistant", tool: "bad_schema" }]);

    for (const t of homeAssistant.assistantTools ?? []) {
      expect(t.isExternal).toBe(true);
      expect(t.externalContent).toBe(true);
      expect(t.risk).toBe("outbound");
      expect(typeof t.execute).toBe("function");
    }

    expect(modules.some((m) => m.id === "integration-disabled-thing")).toBe(false);

    const largeApi = modules.find((m) => m.id === "integration-large-api")!;
    expect((largeApi.assistantTools ?? []).map((t) => t.name)).toEqual([
      "large-api.t0",
      "large-api.t1",
      "large-api.t2",
      "large-api.t3"
    ]);
  });

  it("contributes nothing for a connection with no curated tools", async () => {
    const resolver = createIntegrationsActiveModulesResolver(async () => [], {
      dataContext: fakeDataContext(),
      cipher: createIntegrationsCipher(),
      logger: { warn: () => {} },
      repository: {
        listConnections: async () => [
          connection({ id: "empty", name: "Empty", discoveredTools: [] })
        ]
      } as never
    });

    expect(await resolver("actor-1")).toEqual([]);
  });
});
