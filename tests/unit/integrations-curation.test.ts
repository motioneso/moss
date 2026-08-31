import { describe, expect, it } from "vitest";
import { effectiveEnabledTools, isGroupOptIn } from "@moss/integrations";
import type { IntegrationToolDescriptor } from "@moss/shared";

const tool = (name: string, group = ""): IntegrationToolDescriptor => ({
  name, description: name, group, inputSchema: null
});

describe("integration tool curation", () => {
  it("small sets are live minus mutes", () => {
    const tools = [tool("a"), tool("b"), tool("c")];
    const out = effectiveEnabledTools(tools, { enabledGroups: [], enabledTools: [], mutedTools: ["b"] });
    expect(out.map((t) => t.name)).toEqual(["a", "c"]);
  });

  it("over the threshold nothing is enabled until a group is flipped", () => {
    const tools = Array.from({ length: 31 }, (_, i) => tool(`t${i}`, i < 5 ? "Queue" : "Series"));
    expect(isGroupOptIn(tools.length)).toBe(true);
    expect(effectiveEnabledTools(tools, { enabledGroups: [], enabledTools: [], mutedTools: [] })).toEqual([]);
    const queueOn = effectiveEnabledTools(tools, { enabledGroups: ["Queue"], enabledTools: [], mutedTools: [] });
    expect(queueOn).toHaveLength(5);
  });

  it("per-tool override enables a tool inside a disabled group, mute wins over both", () => {
    const tools = Array.from({ length: 31 }, (_, i) => tool(`t${i}`, "Series"));
    const out = effectiveEnabledTools(tools, { enabledGroups: [], enabledTools: ["t3", "t4"], mutedTools: ["t4"] });
    expect(out.map((t) => t.name)).toEqual(["t3"]);
  });

  it("exactly at the threshold stays live", () => {
    expect(isGroupOptIn(30)).toBe(false);
  });
});
