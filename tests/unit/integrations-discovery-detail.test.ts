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

  // QA round 1, #2175 comment 5515241034, blocking finding 3: the derived Other bucket must never
  // report enabled from a stale/irrelevant enabledGroups entry, but a service's own group literally
  // named Other (OpenAPI's untagged-operation fallback) is an ordinary group and must report its
  // real enabled state.
  it("groups[].enabled is false for the derived Other bucket even if enabledGroups names it, and true for a service-supplied Other group that's actually enabled", () => {
    const lightActions = ["TurnOn", "TurnOff", "SetBrightness", "SetColor", "SetTemp"];
    const fanActions = ["TurnOn", "TurnOff", "SetSpeed", "Oscillate", "Reset"];
    const light = lightActions.map((a) => `HassLight${a}`);
    const fan = fanActions.map((a) => `HassFan${a}`);
    const oneOffs = Array.from({ length: 22 }, (_, i) => `standalone_oddball_${i}`);
    const names = [...light, ...fan, ...oneOffs];
    const tools = names.map(mcpTool);
    const derivedRow = connection({ discoveredTools: tools, enabledGroups: [OTHER_GROUP] });

    const derivedDetail = toDetail(derivedRow, tools);
    const derivedOther = derivedDetail.groups.find((g) => g.name === OTHER_GROUP);
    expect(derivedOther?.enabled).toBe(false);

    const namedTools = [
      ...Array.from({ length: 20 }, (_, i) => ({
        name: `named_${i}`,
        description: `named_${i}`,
        group: "Named",
        inputSchema: null
      })),
      ...Array.from({ length: 11 }, (_, i) => ({
        name: `other_${i}`,
        description: `other_${i}`,
        group: OTHER_GROUP,
        inputSchema: null
      }))
    ];
    const namedRow = connection({ discoveredTools: namedTools, enabledGroups: [OTHER_GROUP] });
    const namedDetail = toDetail(namedRow, namedTools);
    const namedOther = namedDetail.groups.find((g) => g.name === OTHER_GROUP);
    expect(namedOther?.enabled).toBe(true);
  });
});
