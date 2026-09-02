import { describe, expect, it } from "vitest";

import { OTHER_GROUP, toDetail } from "@moss/integrations";
import type { ConnectionRow, DiscoveredTool } from "@moss/integrations";

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

function mcpTool(name: string): DiscoveredTool {
  return { name, description: name, group: "", inputSchema: null };
}

describe("toDetail derived groups", () => {
  it("over-threshold MCP tools (blank groups) get derived groups in the response, with Other last and tool names unchanged", () => {
    const lightActions = ["TurnOn", "TurnOff", "SetBrightness", "SetColor", "SetTemp"];
    const fanActions = ["TurnOn", "TurnOff", "SetSpeed", "Oscillate", "Reset"];
    const light = lightActions.map((a) => `HassLight${a}`);
    const fan = fanActions.map((a) => `HassFan${a}`);
    const oneOffs = Array.from({ length: 22 }, (_, i) => `standalone_oddball_${i}`);
    const names = [...light, ...fan, ...oneOffs];
    const tools = names.map(mcpTool);
    const row = connection({ discoveredTools: tools });

    const detail = toDetail(row, tools);

    expect(detail.tools.map((t) => t.name)).toEqual(names);
    expect(detail.tools.every((t) => t.group !== "")).toBe(true);
    expect(detail.groups.length).toBeGreaterThan(1);
    expect(detail.groups.at(-1)?.name).toBe(OTHER_GROUP);
    expect(detail.groups.filter((g) => g.name === OTHER_GROUP)).toHaveLength(1);
  });
});
