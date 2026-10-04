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
  removeIntegrationClassifierTool: vi.fn(),
  setIntegrationSendWithoutAsking: vi.fn()
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

describe("SettingsIntegrationsPane connection detail (#2984 R2.5)", () => {
  it("opens with Back to connections, the app's name and its host", () => {
    currentDetail.value = baseDetail();

    const html = renderToString(createElement(SettingsIntegrationsPane));

    expect(html).toContain("Back to connections");
    expect(html).toContain("Home Assistant");
    expect(html).toContain("homeassistant.local:8123");
  });

  it("shows the connection rail: use switch, status, how it connects and the tool count", () => {
    currentDetail.value = baseDetail();

    const html = renderToString(createElement(SettingsIntegrationsPane));

    expect(switchState(html, "Use Home Assistant")).toBe("on");
    expect(html).toContain("Connected");
    expect(html).toContain("Tool server");
    expect(html).toContain("Check for new tools");
    expect(html).toContain("Remove");
  });

  it("says it can't reach the app and offers Check again when discovery failed", () => {
    currentDetail.value = baseDetail({ lastError: "Connection refused" });

    const html = renderToString(createElement(SettingsIntegrationsPane));

    expect(html).toContain("Can&#x27;t reach it");
    expect(html).toContain("Connection refused");
    expect(html).toContain("Check again");
  });

  it("shows Off when the connection is switched off", () => {
    currentDetail.value = baseDetail({ enabled: false, lastError: "Connection refused" });

    const html = renderToString(createElement(SettingsIntegrationsPane));

    expect(switchState(html, "Use Home Assistant")).toBe("off");
    expect(html).not.toContain("Can&#x27;t reach it");
  });

  it("hides Check for new tools when the spec was pasted", () => {
    currentDetail.value = baseDetail({ kind: "openapi", specPasted: true });

    const html = renderToString(createElement(SettingsIntegrationsPane));

    expect(html).toContain("Web service");
    expect(html).not.toContain("Check for new tools");
  });

  it("tells a many-tool app that its tools start off", () => {
    currentDetail.value = baseDetail({ groupOptIn: true, tools: [tool({ readOnly: true })] });

    const html = renderToString(createElement(SettingsIntegrationsPane));

    expect(html).toContain("This app has a lot of tools, so they start off.");
    expect(html).not.toContain("Every tool starts on.");
  });

  it("shows the hints note when every tool predates read/repeat hints", () => {
    currentDetail.value = baseDetail({
      tools: [tool({ readOnly: undefined, idempotent: undefined, destructive: undefined })]
    });

    const html = renderToString(createElement(SettingsIntegrationsPane));

    expect(html).toContain("Check for new tools rereads what");
  });

  it("does not show the hints note once any tool has a hint", () => {
    currentDetail.value = baseDetail({ tools: [tool({ readOnly: true })] });

    const html = renderToString(createElement(SettingsIntegrationsPane));

    expect(html).not.toContain("rereads what");
  });

  it("reads a tool in an app group as on or off the way the server does (#2986)", () => {
    const tools = [tool({ name: "send", group: "Other" }), tool({ name: "list_a", group: "list" })];
    currentDetail.value = baseDetail({
      groupOptIn: true,
      tools,
      groups: [
        { name: "list", toolCount: 1, enabled: true },
        { name: "Other", toolCount: 1, enabled: false }
      ],
      enabledGroups: ["list", "Other"]
    });

    const html = renderToString(createElement(SettingsIntegrationsPane));

    expect(switchState(html, "Enable send")).toBe("off");
    expect(switchState(html, "Enable list_a")).toBe("on");
    expect(html).not.toContain("Enable group");
  });

  it("mounts the classifier section beside the tool controls (#2899)", () => {
    currentDetail.value = baseDetail({ tools: [tool({ name: "ToolA" })] });

    const html = renderToString(createElement(SettingsIntegrationsPane));

    expect(html).toContain("Let the classifier use this connection");
    expect(html).toContain("Enable ToolA");
    expect(html).not.toContain("repeated");
  });
});
