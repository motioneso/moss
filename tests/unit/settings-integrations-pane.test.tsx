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
  deleteIntegration: vi.fn()
}));

vi.mock("../../apps/web/src/settings/settings-feedback.js", () => ({
  useFeedback: () => ({ toast: vi.fn(), confirm: vi.fn() })
}));

import { SettingsIntegrationsPane } from "../../apps/web/src/settings/settings-integrations-pane.js";

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

  it("renders a repeat-call switch for each tool in the flat (ungrouped) list", () => {
    currentDetail.value = baseDetail({
      groupOptIn: false,
      tools: [tool({ name: "ToolA" })]
    });

    const html = renderToString(createElement(SettingsIntegrationsPane));

    expect(html).toContain("Allow repeated identical calls to ToolA");
  });

  it("renders a repeat-call switch for each tool in the grouped list", () => {
    currentDetail.value = baseDetail({
      groupOptIn: true,
      enabledGroups: ["Group A"],
      tools: [tool({ name: "ToolA", group: "Group A" })]
    });

    const html = renderToString(createElement(SettingsIntegrationsPane));

    expect(html).toContain("Allow repeated identical calls to ToolA");
  });
});
