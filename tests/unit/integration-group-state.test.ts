import { describe, expect, it } from "vitest";

import type { IntegrationToolDescriptor } from "@moss/shared";

import {
  groupTogglePatch,
  isGroupOn,
  isToolOn
} from "../../apps/web/src/settings/integration-group-state.js";

function tool(name: string, group: string): IntegrationToolDescriptor {
  return { name, description: "", group } as IntegrationToolDescriptor;
}

const tools = [tool("a1", "A"), tool("a2", "A"), tool("o1", "Other"), tool("o2", "Other")];

describe("integration group switch state", () => {
  it("shows a derived Other group off when every tool in it is off, even if it is listed in enabledGroups", () => {
    // Agentmail: server lists Other in enabledGroups but reports it not enabled.
    const detail = {
      tools,
      groups: [
        { name: "A", toolCount: 2, enabled: true },
        { name: "Other", toolCount: 2, enabled: false }
      ],
      enabledGroups: ["A", "Other"],
      enabledTools: [],
      mutedTools: []
    };
    expect(isToolOn(detail, "o1", "Other")).toBe(false);
    expect(isGroupOn(detail, "Other")).toBe(false);
    expect(isGroupOn(detail, "A")).toBe(true);
  });

  it("shows a group off when only some tools are on", () => {
    const detail = {
      tools,
      groups: [{ name: "A", toolCount: 2, enabled: true }],
      enabledGroups: ["A"],
      enabledTools: [],
      mutedTools: ["a2"]
    };
    expect(isGroupOn(detail, "A")).toBe(false);
  });

  it("turning a grandfathered group off turns every tool in it off", () => {
    // Home Assistant: every tool picked explicitly, no group enabled.
    const detail = {
      tools,
      groups: [
        { name: "A", toolCount: 2, enabled: false },
        { name: "Other", toolCount: 2, enabled: false }
      ],
      enabledGroups: [],
      enabledTools: ["a1", "a2", "o1", "o2"],
      mutedTools: []
    };
    expect(isGroupOn(detail, "Other")).toBe(true);
    const patch = groupTogglePatch(detail, "Other", false);
    expect(patch.enabledTools).toEqual(["a1", "a2"]);
    expect(isGroupOn({ ...detail, ...patch }, "Other")).toBe(false);
    expect(isGroupOn({ ...detail, ...patch }, "A")).toBe(true);
  });

  it("turning a derived Other group on turns every tool in it on and clears mutes", () => {
    const detail = {
      tools,
      groups: [{ name: "Other", toolCount: 2, enabled: false }],
      enabledGroups: ["Other"],
      enabledTools: [],
      mutedTools: ["o1"]
    };
    const patch = groupTogglePatch(detail, "Other", true);
    const after = { ...detail, ...patch };
    expect(patch.mutedTools).toEqual([]);
    expect(isToolOn(after, "o1", "Other")).toBe(true);
    expect(isToolOn(after, "o2", "Other")).toBe(true);
  });
});
