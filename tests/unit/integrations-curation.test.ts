import { describe, expect, it } from "vitest";
import { effectiveEnabledTools, isGroupOptIn, withDerivedGroups } from "@moss/integrations";
import type { IntegrationToolDescriptor } from "@moss/shared";

const tool = (name: string, group = ""): IntegrationToolDescriptor => ({
  name,
  description: name,
  group,
  inputSchema: null
});

describe("integration tool curation", () => {
  it("small sets are live minus mutes", () => {
    const tools = [tool("a"), tool("b"), tool("c")];
    const out = effectiveEnabledTools(tools, {
      enabledGroups: [],
      enabledTools: [],
      mutedTools: ["b"]
    });
    expect(out.map((t) => t.name)).toEqual(["a", "c"]);
  });

  it("over the threshold nothing is enabled until a group is flipped", () => {
    const tools = Array.from({ length: 31 }, (_, i) => tool(`t${i}`, i < 5 ? "Queue" : "Series"));
    expect(isGroupOptIn(tools)).toBe(true);
    expect(
      effectiveEnabledTools(tools, { enabledGroups: [], enabledTools: [], mutedTools: [] })
    ).toEqual([]);
    const queueOn = effectiveEnabledTools(tools, {
      enabledGroups: ["Queue"],
      enabledTools: [],
      mutedTools: []
    });
    expect(queueOn).toHaveLength(5);
  });

  it("per-tool override enables a tool inside a disabled group, mute wins over both", () => {
    const tools = Array.from({ length: 31 }, (_, i) => tool(`t${i}`, "Series"));
    const out = effectiveEnabledTools(tools, {
      enabledGroups: [],
      enabledTools: ["t3", "t4"],
      mutedTools: ["t4"]
    });
    expect(out.map((t) => t.name)).toEqual(["t3"]);
  });

  it("exactly at the threshold stays live", () => {
    const tools = Array.from({ length: 30 }, (_, i) => tool(`t${i}`, "Series"));
    expect(isGroupOptIn(tools)).toBe(false);
  });

  it("over the threshold with every tool blank now group-gates via derived groups", () => {
    const tools = Array.from({ length: 31 }, (_, i) => tool(`t${i}`, ""));
    expect(isGroupOptIn(tools)).toBe(true);
    const out = effectiveEnabledTools(tools, {
      enabledGroups: [],
      enabledTools: [],
      mutedTools: []
    });
    expect(out).toEqual([]);
  });

  it("returned tools carry derived group names, not the blank service-supplied ones", () => {
    const tools = Array.from({ length: 31 }, (_, i) => tool(`t${i}`, ""));
    const out = effectiveEnabledTools(tools, {
      enabledGroups: [],
      enabledTools: tools.map((t) => t.name),
      mutedTools: []
    });
    expect(out).toHaveLength(31);
    for (const t of out) expect(t.group).not.toBe("");
  });

  it("enabledGroups containing Other matches nothing -- Other only enables by explicit tool name", () => {
    const tools = Array.from({ length: 31 }, (_, i) => tool(`t${i}`, ""));
    const withOtherFlipped = effectiveEnabledTools(tools, {
      enabledGroups: ["Other"],
      enabledTools: [],
      mutedTools: []
    });
    expect(withOtherFlipped).toEqual([]);

    const withoutFlippedButNamed = effectiveEnabledTools(tools, {
      enabledGroups: ["Other"],
      enabledTools: ["t0"],
      mutedTools: []
    });
    const derivedGroupOfT0 = withDerivedGroups(tools).find((t) => t.name === "t0")?.group;
    expect(derivedGroupOfT0).toBe("Other");
    expect(withoutFlippedButNamed.map((t) => t.name)).toEqual(["t0"]);
  });

  // QA round 1, #2175 comment 5515241034, blocking finding 3: a service can name a group
  // "Other" itself (OpenAPI's untagged-operation fallback). That group never went through
  // derivation -- it must opt-in-gate like any other named group, not be treated as the
  // algorithm's display-only, non-opt-in-able bucket.
  it("a service-supplied group literally named Other opts in normally like any other group", () => {
    const tools = [
      ...Array.from({ length: 20 }, (_, i) => tool(`named_${i}`, "Named")),
      ...Array.from({ length: 11 }, (_, i) => tool(`other_${i}`, "Other"))
    ];
    const otherOff = effectiveEnabledTools(tools, {
      enabledGroups: ["Named"],
      enabledTools: [],
      mutedTools: []
    });
    expect(otherOff.map((t) => t.name)).toEqual(tools.slice(0, 20).map((t) => t.name));

    const otherOn = effectiveEnabledTools(tools, {
      enabledGroups: ["Named", "Other"],
      enabledTools: [],
      mutedTools: []
    });
    expect(otherOn).toHaveLength(31);
  });
});
