import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { IntegrationDetail, IntegrationToolDescriptor } from "@moss/shared";

vi.mock("react-router", () => ({
  useSearchParams: () => [new URLSearchParams({ integration: "conn-1" }), vi.fn()]
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn(() => ({
    data: currentDetail.value,
    isLoading: false,
    isError: false,
    error: null
  })),
  useMutation: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useQueryClient: vi.fn(() => ({ invalidateQueries: vi.fn() }))
}));

vi.mock("../../apps/web/src/api/client.js", () => ({
  ApiError: class ApiError extends Error {
    status = 500;
  },
  getIntegration: vi.fn(),
  listIntegrations: vi.fn(),
  createIntegration: vi.fn(),
  updateIntegration: vi.fn(),
  refreshIntegration: vi.fn(),
  deleteIntegration: vi.fn(),
  prepareIntegrationClassifierTools: vi.fn(),
  saveIntegrationClassifierTool: vi.fn(),
  removeIntegrationClassifierTool: vi.fn()
}));

vi.mock("../../apps/web/src/settings/settings-feedback.js", () => ({
  useFeedback: () => ({ toast: vi.fn(), confirm: vi.fn() })
}));

import { SettingsIntegrationsPane } from "../../apps/web/src/settings/settings-integrations-pane.js";

function switchState(html: string, label: string): "on" | "off" | undefined {
  const match = new RegExp(`<input[^>]*aria-label="${label}"[^>]*>`).exec(html);
  if (!match) return undefined;
  return / checked(=|\s|\/|>)/.test(match[0]) ? "on" : "off";
}

const currentDetail: { value: IntegrationDetail | undefined } = { value: undefined };

function tool(overrides: Partial<IntegrationToolDescriptor> = {}): IntegrationToolDescriptor {
  return {
    name: "SomeTool",
    description: "Does a thing",
    group: "Group A",
    inputSchema: null,
    ...overrides
  };
}

function baseDetail(overrides: Partial<IntegrationDetail> = {}): IntegrationDetail {
  return {
    id: "conn-1",
    name: "Home Assistant",
    kind: "mcp",
    url: "http://homeassistant.local:8123",
    enabled: true,
    hasCredential: true,
    toolCount: 2,
    enabledToolCount: 2,
    lastDiscoveryAt: null,
    lastError: null,
    credentialPlacement: null,
    tools: [tool({ name: "ToolA" }), tool({ name: "ToolB" })],
    groups: [{ name: "Group A", toolCount: 2, enabled: true }],
    enabledGroups: [],
    enabledTools: [],
    mutedTools: [],
    unsuppressedTools: [],
    groupOptIn: false,
    specPasted: false,
    classifierEnabled: false,
    classifierPreparation: [],
    classifierTools: [],
    ...overrides
  };
}

describe("SettingsIntegrationsPane connection detail (#2175 Task 6)", () => {
  it("shows the fresh-opt-in note when grouping just turned on and nothing is enabled yet", () => {
    currentDetail.value = baseDetail({
      groupOptIn: true,
      enabledGroups: [],
      enabledTools: [],
      tools: [tool({ readOnly: true })]
    });

    const html = renderToString(createElement(SettingsIntegrationsPane));

    expect(html).toContain("Groups start off. Turn on the ones Moss should use.");
    expect(html).not.toContain("kept everything enabled before grouping existed");
  });

  it("shows the grandfathered note instead when the connection was already fully enabled", () => {
    currentDetail.value = baseDetail({
      groupOptIn: true,
      enabledGroups: [],
      enabledTools: ["ToolA", "ToolB"],
      tools: [tool({ readOnly: true })]
    });

    const html = renderToString(createElement(SettingsIntegrationsPane));

    expect(html).toContain("kept everything enabled before grouping existed");
    expect(html).not.toContain("Groups start off. Turn on the ones Moss should use.");
  });

  it("shows the refresh-for-hints note when every tool predates read/repeat hints", () => {
    currentDetail.value = baseDetail({
      tools: [tool({ readOnly: undefined, idempotent: undefined, destructive: undefined })]
    });

    const html = renderToString(createElement(SettingsIntegrationsPane));

    expect(html).toContain("Refresh tools rereads what");
    expect(html).toContain("says about each tool");
  });

  it("does not show the refresh-for-hints note once any tool has a hint", () => {
    currentDetail.value = baseDetail({
      tools: [tool({ readOnly: true })]
    });

    const html = renderToString(createElement(SettingsIntegrationsPane));

    expect(html).not.toContain("Refresh tools rereads");
  });

  it("renders only the on/off switch, no repeat-call switch, for each tool in the flat (ungrouped) list", () => {
    currentDetail.value = baseDetail({
      groupOptIn: false,
      tools: [tool({ name: "ToolA" })]
    });

    const html = renderToString(createElement(SettingsIntegrationsPane));

    expect(html).toContain("Enable ToolA");
    expect(html).not.toContain("repeated");
  });

  it("renders only the on/off switch, no repeat-call switch, for each tool in the grouped list", () => {
    currentDetail.value = baseDetail({
      groupOptIn: true,
      enabledGroups: ["Group A"],
      tools: [tool({ name: "ToolA", group: "Group A" })]
    });

    const html = renderToString(createElement(SettingsIntegrationsPane));

    expect(html).toContain("Enable ToolA");
    expect(html).not.toContain("repeated");
  });

  it("shows the Other group switch off when every tool in it is off, and on when every tool is on (#2986)", () => {
    const tools = [
      tool({ name: "send", group: "Other" }),
      tool({ name: "reply", group: "Other" }),
      tool({ name: "list_a", group: "list" })
    ];
    // Agentmail shape: the server lists Other in enabledGroups but reports it not enabled.
    currentDetail.value = baseDetail({
      groupOptIn: true,
      tools,
      groups: [
        { name: "list", toolCount: 1, enabled: true },
        { name: "Other", toolCount: 2, enabled: false }
      ],
      enabledGroups: ["list", "Other"],
      enabledTools: [],
      mutedTools: []
    });
    const off = renderToString(createElement(SettingsIntegrationsPane));
    expect(switchState(off, "Enable group Other")).toBe("off");
    expect(switchState(off, "Enable send")).toBe("off");
    expect(switchState(off, "Enable group list")).toBe("on");

    // Home Assistant shape: every tool picked explicitly, no group enabled.
    currentDetail.value = baseDetail({
      groupOptIn: true,
      tools,
      groups: [
        { name: "list", toolCount: 1, enabled: false },
        { name: "Other", toolCount: 2, enabled: false }
      ],
      enabledGroups: [],
      enabledTools: ["send", "reply", "list_a"],
      mutedTools: []
    });
    const on = renderToString(createElement(SettingsIntegrationsPane));
    expect(switchState(on, "Enable group Other")).toBe("on");
    expect(switchState(on, "Enable group list")).toBe("on");
  });

  it("mounts the classifier section without changing the ordinary tool controls (#2899)", () => {
    currentDetail.value = baseDetail({
      tools: [tool({ name: "ToolA" })]
    });

    const html = renderToString(createElement(SettingsIntegrationsPane));

    expect(html).toContain("Let the classifier use this connection");
    expect(html).toContain("Enable ToolA");
    expect(html).not.toContain("repeated");
  });
});
