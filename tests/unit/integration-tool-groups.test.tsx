// @vitest-environment jsdom
// Connection page tools (#2984 R2.5): grouping by sorted risk, the Asks first chip, the
// send-without-asking menu and group links, the inline confirm, the always-ask count, Turn all
// off/on, folding, and the A-to-Z fallback when nothing is sorted yet.
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  IntegrationClassifierRisk,
  IntegrationClassifierToolSort,
  IntegrationToolDescriptor
} from "@moss/shared";

import {
  alwaysAskCount,
  groupToolsByRisk,
  IntegrationToolsSection,
  readableName,
  toolMatches,
  toolsOnPatch
} from "../../apps/web/src/settings/integration-tool-groups.js";

type Detail = Parameters<typeof groupToolsByRisk>[0];

function tool(name: string, group = ""): IntegrationToolDescriptor {
  return { name, description: `${name} does a thing`, group, inputSchema: null };
}

function sorted(
  toolName: string,
  risk: IntegrationClassifierRisk,
  extra: Partial<IntegrationClassifierToolSort> = {}
): IntegrationClassifierToolSort {
  return {
    toolName,
    status: "current",
    risk,
    failure: null,
    sendWithoutAsking: false,
    asksFirst: risk === "outbound" || risk === "destructive",
    readableName: toolName,
    sortedAt: "2026-10-02T09:00:00.000Z",
    sortedBy: null,
    sortMethod: null,
    failedAt: null,
    keptOut: false,
    classifierState: "off",
    preparationFailure: null,
    preparedAt: null,
    ...extra
  };
}

function detail(overrides: Partial<Detail> = {}): Detail {
  return {
    tools: [tool("GetState"), tool("SetLight"), tool("Notify"), tool("FindPhone"), tool("Unlock")],
    groups: [],
    enabledGroups: [],
    enabledTools: [],
    mutedTools: [],
    groupOptIn: false,
    classifierTools: [
      sorted("GetState", "read"),
      sorted("SetLight", "write"),
      sorted("Notify", "outbound"),
      sorted("FindPhone", "outbound"),
      sorted("Unlock", "destructive")
    ],
    ...overrides
  };
}

let renderer: ReactTestRenderer | undefined;
const onSetOn = vi.fn();
const onSend = vi.fn();
const onKeptOut = vi.fn();

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  onSetOn.mockReset();
  onSend.mockReset();
  onKeptOut.mockReset();
});

function render(value: Detail): void {
  act(() => {
    renderer = create(
      createElement(IntegrationToolsSection, {
        detail: value,
        onSetOn,
        onSendWithoutAsking: onSend,
        onSetKeptOut: onKeptOut
      })
    );
  });
}

function text(): string {
  return JSON.stringify(renderer!.toJSON());
}

function flatten(children: unknown): string {
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(flatten).join("");
  return "";
}

function buttons(label: string) {
  return renderer!.root
    .findAllByType("button")
    .filter((node) => flatten(node.props.children) === label);
}

function click(label: string): void {
  const [button] = buttons(label);
  if (!button) throw new Error(`no button "${label}"`);
  act(() => button.props.onClick());
}

function openMenu(toolName: string): void {
  const trigger = renderer!.root.find(
    (node) => node.type === "button" && node.props["aria-label"] === `More for ${toolName}`
  );
  act(() => trigger.props.onClick());
}

function menuLabels(): string[] {
  return renderer!.root
    .findAll((node) => node.type === "button" && node.props.role === "menuitem")
    .map((node) => {
      const label = node.findAll((child) => child.type === "span" && !child.props.className)[0];
      return flatten(label ? label.props.children : node.props.children);
    });
}

function menuItem(label: string) {
  const items = renderer!.root.findAll(
    (node) => node.type === "button" && node.props.role === "menuitem"
  );
  const item = items[menuLabels().indexOf(label)];
  if (!item) throw new Error(`no menu item "${label}"`);
  return item;
}

describe("groupToolsByRisk", () => {
  it("orders the four risk groups and trails tools that are not sorted yet", () => {
    const value = detail({
      tools: [tool("Unlock"), tool("Later"), tool("GetState"), tool("Notify")],
      classifierTools: [
        sorted("Unlock", "destructive"),
        { ...sorted("Later", "read"), status: "stale", risk: null },
        sorted("GetState", "read"),
        sorted("Notify", "outbound")
      ]
    });
    const groups = groupToolsByRisk(value)!;
    expect(groups.map((group) => group.title)).toEqual([
      "Looks things up",
      "Sends things out",
      "Sensitive",
      "Not sorted yet"
    ]);
    expect(groups[3]!.tools.map((t) => t.name)).toEqual(["Later"]);
  });

  it("returns null when nothing is sorted, so the page lists A to Z", () => {
    expect(groupToolsByRisk(detail({ classifierTools: [] }))).toBeNull();
  });
});

describe("alwaysAskCount", () => {
  it("counts tools that are on and still ask, including sending tools not yet allowed", () => {
    expect(alwaysAskCount(detail())).toBe(3);
  });

  it("drops allowed sending tools and tools that are off", () => {
    const value = detail({
      mutedTools: ["Unlock"],
      classifierTools: [
        sorted("GetState", "read"),
        sorted("SetLight", "write"),
        sorted("Notify", "outbound"),
        sorted("FindPhone", "outbound", { sendWithoutAsking: true, asksFirst: false }),
        sorted("Unlock", "destructive")
      ]
    });
    expect(alwaysAskCount(value)).toBe(1);
  });
});

describe("toolsOnPatch", () => {
  it("mutes tools turned off and unmutes tools turned on", () => {
    const value = detail({ mutedTools: ["Notify"], enabledTools: ["GetState"] });
    expect(toolsOnPatch(value, ["GetState"], false)).toEqual({
      enabledTools: [],
      mutedTools: ["Notify", "GetState"]
    });
    expect(toolsOnPatch(value, ["Notify"], true)).toEqual({
      enabledTools: ["GetState"],
      mutedTools: []
    });
  });

  it("picks a tool by name when its app group is off", () => {
    const value = detail({
      groupOptIn: true,
      tools: [tool("a", "Movie"), tool("b", "Backup")],
      groups: [
        { name: "Movie", toolCount: 1, enabled: true },
        { name: "Backup", toolCount: 1, enabled: false }
      ]
    });
    expect(toolsOnPatch(value, ["a", "b"], true)).toEqual({ enabledTools: ["b"], mutedTools: [] });
  });
});

describe("IntegrationToolsSection", () => {
  it("shows the counts, the YOLO line and the four groups", () => {
    render(detail());
    const html = text();
    expect(html).toContain("5 of 5 on");
    expect(html).not.toContain("always ask");
    expect(html).toContain("YOLO mode skips the asking.");
    for (const title of ["Looks things up", "Changes things", "Sends things out", "Sensitive"]) {
      expect(html).toContain(title);
    }
  });

  it("marks tools that ask first", () => {
    render(detail());
    const chips = renderer!.root.findAll(
      (node) => node.type === "span" && flatten(node.props.children) === "Asks first"
    );
    expect(chips).toHaveLength(3);
  });

  it("offers Send without asking only on sending tools, and sends it for that tool", () => {
    render(detail());
    openMenu("GetState");
    expect(menuLabels()).toEqual(["Keep out of the classifier"]);
    openMenu("FindPhone");
    expect(text()).toContain("Chat sends with this tool without checking with you");
    act(() => menuItem("Send without asking").props.onClick());
    expect(onSend).toHaveBeenCalledWith(["FindPhone"], true);
  });

  it("shows an allowed tool as sending without asking and offers to undo it", () => {
    render(
      detail({
        classifierTools: [
          sorted("Notify", "outbound"),
          sorted("FindPhone", "outbound", { sendWithoutAsking: true, asksFirst: false })
        ]
      })
    );
    expect(text()).toContain("Sends without asking");
    openMenu("FindPhone");
    expect(text()).toContain("Chat checks with you first");
    act(() => menuItem("Ask before sending").props.onClick());
    expect(onSend).toHaveBeenCalledWith(["FindPhone"], false);
  });

  it("shows only Send all without asking when every sending tool asks", () => {
    render(detail());
    expect(buttons("Send all without asking")).toHaveLength(1);
    expect(buttons("Ask first for all")).toHaveLength(0);
  });

  it("shows both group links when some sending tools are allowed and some ask", () => {
    render(
      detail({
        classifierTools: [
          sorted("Notify", "outbound"),
          sorted("FindPhone", "outbound", { sendWithoutAsking: true, asksFirst: false })
        ]
      })
    );
    expect(buttons("Send all without asking")).toHaveLength(1);
    click("Ask first for all");
    expect(onSend).toHaveBeenCalledWith(["FindPhone"], false);
  });

  it("shows only Ask first for all when every sending tool is allowed", () => {
    const allowed = { sendWithoutAsking: true, asksFirst: false };
    render(
      detail({
        classifierTools: [
          sorted("Notify", "outbound", allowed),
          sorted("FindPhone", "outbound", allowed)
        ]
      })
    );
    expect(buttons("Send all without asking")).toHaveLength(0);
    click("Ask first for all");
    expect(onSend).toHaveBeenCalledWith(["Notify", "FindPhone"], false);
  });

  it("confirms before allowing the whole group, and Cancel sends nothing", () => {
    render(detail());
    click("Send all without asking");
    expect(text()).toContain("Let chat send with these 2 tools without checking with you?");
    click("Cancel");
    expect(text()).not.toContain("Let chat send with these");
    expect(onSend).not.toHaveBeenCalled();

    click("Send all without asking");
    click("Allow");
    expect(onSend).toHaveBeenCalledWith(["Notify", "FindPhone"], true);
    expect(text()).not.toContain("Let chat send with these");
  });

  it("turns a whole group off, and offers Turn all on once every tool in it is off", () => {
    render(detail({ mutedTools: ["Unlock"] }));
    expect(text()).toContain("0 of 1 on");
    expect(buttons("Turn all off")).toHaveLength(3);
    click("Turn all on");
    expect(onSetOn).toHaveBeenCalledWith(["Unlock"], true);
    act(() => buttons("Turn all off")[0]!.props.onClick());
    expect(onSetOn).toHaveBeenCalledWith(["GetState"], false);
  });

  it("switches one tool through the same on/off path", () => {
    render(detail());
    const input = renderer!.root.find(
      (node) => node.type === "input" && node.props["aria-label"] === "Enable SetLight"
    );
    act(() => input.props.onChange({ target: { checked: false } }));
    expect(onSetOn).toHaveBeenCalledWith(["SetLight"], false);
  });

  it("folds a long group to six tools and shows the rest on request", () => {
    const names = Array.from({ length: 9 }, (_, i) => `Read${i}`);
    render(
      detail({
        tools: names.map((name) => tool(name)),
        classifierTools: names.map((name) => sorted(name, "read"))
      })
    );
    expect(text()).not.toContain("Read7");
    click("Show 3 more");
    expect(text()).toContain("Read7");
  });

  it("lists A to Z with a plain note when nothing is sorted yet", () => {
    render(detail({ tools: [tool("Zed"), tool("Alpha")], classifierTools: [] }));
    const html = text();
    expect(html).toContain("so they show A to Z");
    expect(html).not.toContain("Looks things up");
    expect(html.indexOf("Enable Alpha")).toBeLessThan(html.indexOf("Enable Zed"));
  });
});

describe("tool names and search (#2984 R2.5b)", () => {
  const named = () =>
    detail({
      classifierTools: [
        sorted("GetState", "read", { readableName: "Check what devices are doing" }),
        sorted("SetLight", "write"),
        sorted("Notify", "outbound"),
        sorted("FindPhone", "outbound", { readableName: "Ring my phone" }),
        sorted("Unlock", "destructive")
      ]
    });

  it("shows the readable name with the raw name small underneath", () => {
    render(named());
    const raw = renderer!.root.findAll(
      (node) => node.type === "span" && String(node.props.className).includes("intg-tool__raw")
    );
    expect(raw.map((node) => node.findByType("code").props.children)).toEqual([
      "GetState",
      "FindPhone"
    ]);
    expect(text()).toContain("Check what devices are doing");
    expect(readableName(named(), tool("FindPhone"))).toBe("Ring my phone");
    expect(readableName(named(), tool("Missing"))).toBe("Missing");
  });

  it("matches the readable name, the raw name and the description", () => {
    const value = named();
    expect(toolMatches(value, tool("FindPhone"), "ring my")).toBe(true);
    expect(toolMatches(value, tool("FindPhone"), "findphone")).toBe(true);
    expect(toolMatches(value, tool("FindPhone"), "does a thing")).toBe(true);
    expect(toolMatches(value, tool("FindPhone"), "devices")).toBe(false);
  });

  it("marks a tool being prepared again", () => {
    render(
      detail({
        classifierTools: [sorted("SetLight", "write", { classifierState: "preparing_again" })]
      })
    );
    expect(text()).toContain("Preparing again");
  });
});

describe("keeping a tool out of the classifier (#2984 R2.5b)", () => {
  it("offers Keep out on every tool and sends it for that tool", () => {
    render(detail());
    const triggers = renderer!.root.findAll(
      (node) => node.type === "button" && String(node.props["aria-label"]).startsWith("More for")
    );
    expect(triggers).toHaveLength(5);
    openMenu("SetLight");
    expect(text()).toContain("Chat can still use it");
    act(() => menuItem("Keep out of the classifier").props.onClick());
    expect(onKeptOut).toHaveBeenCalledWith(["SetLight"], true);
  });

  it("shows Undo on the tool just kept out, and Undo lets it back in", () => {
    const value = detail();
    render(value);
    openMenu("SetLight");
    act(() => menuItem("Keep out of the classifier").props.onClick());
    act(() =>
      renderer!.update(
        createElement(IntegrationToolsSection, {
          detail: {
            ...value,
            classifierTools: value.classifierTools.map((entry) =>
              entry.toolName === "SetLight" ? { ...entry, keptOut: true } : entry
            )
          },
          onSetOn,
          onSendWithoutAsking: onSend,
          onSetKeptOut: onKeptOut
        })
      )
    );
    expect(text()).toContain("Kept out of the classifier");
    click("Undo");
    expect(onKeptOut).toHaveBeenLastCalledWith(["SetLight"], false);
  });

  it("marks a kept-out tool without Undo when it was kept out earlier, and offers to let it in", () => {
    render(
      detail({
        classifierTools: [
          sorted("SetLight", "write", { keptOut: true, classifierState: "kept_out" })
        ]
      })
    );
    expect(text()).toContain("Kept out of the classifier");
    expect(buttons("Undo")).toHaveLength(0);
    openMenu("SetLight");
    act(() => menuItem("Let the classifier use it").props.onClick());
    expect(onKeptOut).toHaveBeenCalledWith(["SetLight"], false);
  });
});
