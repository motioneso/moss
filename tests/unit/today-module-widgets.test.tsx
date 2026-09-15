// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ModuleTodayWidgets } from "../../apps/web/src/today/module-today-widgets.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockState = vi.hoisted(() => ({
  loadCalls: [] as string[],
  failIds: new Set<string>()
}));

vi.mock("virtual:moss-module-web", () => {
  const entry = (moduleId: string, slots: readonly string[]) => ({
    moduleId,
    load: async () => {
      mockState.loadCalls.push(moduleId);
      if (mockState.failIds.has(moduleId)) throw new Error(`load failed for ${moduleId}`);
      return {
        default: {
          todayWidgets: slots.map((slot) => ({
            slot,
            element: createElement("div", null, `${slot} widget ${moduleId}`)
          }))
        }
      };
    }
  });
  return {
    MODULE_WEB_CONTRIBUTIONS: [
      entry("mod-a", ["brief", "quick-actions"]),
      entry("mod-b", ["brief"])
    ]
  };
});

function textOf(node: ReactTestInstance): string {
  const out: string[] = [];
  const walk = (child: ReactTestInstance | string): void => {
    if (typeof child === "string") {
      out.push(child);
      return;
    }
    for (const grandchild of child.children) walk(grandchild);
  };
  walk(node);
  return out.join(" ").replace(/\s+/g, " ");
}

async function renderHost(input: {
  readonly slot?: string;
  readonly disabledModuleIds?: readonly string[];
}): Promise<{ renderer: ReactTestRenderer; root: ReactTestInstance }> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } }
  });
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(
      createElement(
        QueryClientProvider,
        { client },
        createElement(ModuleTodayWidgets, {
          slot: input.slot,
          disabledModuleIds: [...(input.disabledModuleIds ?? [])]
        })
      )
    );
  });
  if (!renderer) throw new Error("host did not render");
  return { renderer, root: renderer.root };
}

beforeEach(() => {
  mockState.loadCalls = [];
  mockState.failIds.clear();
});

describe("ModuleTodayWidgets slot filter", () => {
  it("renders every widget without a slot", async () => {
    const { renderer, root } = await renderHost({});
    try {
      const text = textOf(root);
      expect(text).toContain("brief widget mod-a");
      expect(text).toContain("quick-actions widget mod-a");
      expect(text).toContain("brief widget mod-b");
    } finally {
      renderer.unmount();
    }
  });

  it("renders only matching widgets with a slot, mounting each contribution once", async () => {
    const brief = await renderHost({ slot: "brief" });
    try {
      const text = textOf(brief.root);
      expect(text).toContain("brief widget mod-a");
      expect(text).toContain("brief widget mod-b");
      expect(text).not.toContain("quick-actions widget mod-a");
    } finally {
      brief.renderer.unmount();
    }
    mockState.loadCalls = [];
    const dock = await renderHost({ slot: "quick-actions" });
    try {
      const text = textOf(dock.root);
      expect(text).toContain("quick-actions widget mod-a");
      expect(text).not.toContain("brief widget mod-a");
      expect(text).not.toContain("brief widget mod-b");
      expect(mockState.loadCalls.filter((id) => id === "mod-a")).toHaveLength(1);
      expect(mockState.loadCalls.filter((id) => id === "mod-b")).toHaveLength(1);
    } finally {
      dock.renderer.unmount();
    }
  });

  it("never calls load for a disabled module", async () => {
    const { renderer, root } = await renderHost({ disabledModuleIds: ["mod-a"] });
    try {
      const text = textOf(root);
      expect(text).not.toContain("widget mod-a");
      expect(text).toContain("brief widget mod-b");
      expect(mockState.loadCalls).not.toContain("mod-a");
    } finally {
      renderer.unmount();
    }
  });

  it("keeps a failed module local with retry while its sibling renders", async () => {
    mockState.failIds.add("mod-a");
    const { renderer, root } = await renderHost({});
    try {
      expect(textOf(root)).toContain("load this widget right now");
      expect(textOf(root)).toContain("Retry");
      expect(textOf(root)).toContain("brief widget mod-b");
      const retry = root.findAllByType("button").find((button) => textOf(button).includes("Retry"));
      if (!retry) throw new Error("Retry button not found");
      const callsBefore = mockState.loadCalls.filter((id) => id === "mod-a").length;
      await act(async () => {
        retry.props.onClick();
      });
      expect(mockState.loadCalls.filter((id) => id === "mod-a")).toHaveLength(callsBefore + 1);
      expect(textOf(root)).toContain("load this widget right now");
      expect(textOf(root)).toContain("brief widget mod-b");
    } finally {
      renderer.unmount();
    }
  });
});
