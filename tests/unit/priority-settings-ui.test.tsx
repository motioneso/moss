import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import {
  PrioritySettings,
  priorityDraftValidation,
  prioritySourceIncluded,
  priorityWeightLabel
} from "@moss/settings-ui";
import type { PriorityModelPreferenceV1 } from "@moss/priority";

describe("PrioritySettings", () => {
  const savedModel = {
    version: 1 as const,
    mode: "balanced" as const,
    anchors: [] as PriorityModelPreferenceV1["anchors"],
    mutedSources: ["memory", "wellness", "future-source"],
    updatedAt: "2026-07-01T00:00:00Z"
  };

  function mount(model = savedModel) {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["priority-model"], model);
    const patch = vi.fn((init: RequestInit | undefined) => init?.method === "PATCH");
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        patch(init);
        return new Response(init.body, { status: 200 });
      }
      return new Response(JSON.stringify(model), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <QueryClientProvider client={queryClient}>
          <PrioritySettings />
        </QueryClientProvider>
      );
    });
    return { renderer, patch };
  }

  function button(renderer: ReactTestRenderer, name: string) {
    return renderer.root.findAllByType("button").find((item) => {
      const children = Array.isArray(item.props.children)
        ? item.props.children
        : [item.props.children];
      return children.some((child) => typeof child === "string" && child.includes(name));
    });
  }

  function input(renderer: ReactTestRenderer, label: string) {
    return renderer.root
      .findAllByType("input")
      .find((item) => item.props["aria-label"] === label || item.props.placeholder === label);
  }

  afterEach(() => vi.unstubAllGlobals());

  it("maps stored weights and source exclusions to user language", () => {
    expect(priorityWeightLabel(-2)).toBe("Much lower");
    expect(priorityWeightLabel(0)).toBe("Neutral");
    expect(priorityWeightLabel(2)).toBe("Much higher");
    const model = {
      version: 1 as const,
      mode: "balanced" as const,
      anchors: [],
      mutedSources: ["email" as const],
      updatedAt: "now"
    };
    expect(prioritySourceIncluded(model, "tasks")).toBe(true);
    expect(prioritySourceIncluded(model, "email")).toBe(false);
    expect(
      priorityDraftValidation({
        ...model,
        anchors: [
          {
            id: "1",
            kind: "project",
            label: " ",
            aliases: [],
            weight: 1,
            enabled: true,
            createdAt: "now",
            updatedAt: "now"
          }
        ]
      })
    ).toContain("label");
  });

  it("renders its loading state inside a query client", () => {
    const queryClient = new QueryClient();

    const html = renderToString(
      <QueryClientProvider client={queryClient}>
        <PrioritySettings />
      </QueryClientProvider>
    );

    expect(html).toContain("Loading priority settings");
    expect(html).toContain("pane__title");
    expect(html).toContain("pane__card");
    expect(html).not.toContain('class="loading"');
  });

  it("labels unwired muted sources as having no effect yet", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["priority-model"], {
      version: 1,
      mode: "balanced",
      anchors: [],
      mutedSources: [],
      updatedAt: "2026-07-01T00:00:00Z"
    });

    const html = renderToString(
      <QueryClientProvider client={queryClient}>
        <PrioritySettings />
      </QueryClientProvider>
    );

    expect(html).toContain("Sources your assistant may prioritize");
    expect(html).toContain(
      "These choices affect ranking only; they do not change source access or data visibility."
    );
    expect(html).toContain("Tasks");
    expect(html).toContain("Notes");
    expect(html).not.toContain("Memory");
    expect(html).not.toContain("Wellness");
    expect(html).not.toContain("Anchor kind");
    expect(html).not.toContain('value="-2"');
  });

  it("keeps Add, edits, and source changes local until one valid Save", async () => {
    const { renderer, patch } = mount();

    act(() => button(renderer, "Add priority")?.props.onClick());
    expect(patch).not.toHaveBeenCalled();

    act(() =>
      input(renderer, "e.g. Finish the launch plan")?.props.onChange({
        target: { value: "Ship launch" },
        currentTarget: { value: "Ship launch" }
      })
    );
    act(() =>
      input(renderer, "Include tasks in priority ranking")?.props.onChange({
        target: { checked: false }
      })
    );
    expect(patch).not.toHaveBeenCalled();

    await act(async () => button(renderer, "Save priorities")?.props.onClick());

    expect(patch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(patch.mock.calls[0]?.[0]?.body as string);
    expect(body.anchors[0].label).toBe("Ship launch");
    expect(body.mutedSources).toEqual(["memory", "wellness", "future-source", "tasks"]);
  });

  it("blocks Save for a blank required label without a PATCH", () => {
    const { renderer, patch } = mount();
    act(() => button(renderer, "Add priority")?.props.onClick());
    act(() => button(renderer, "Save priorities")?.props.onClick());

    expect(patch).not.toHaveBeenCalled();
    expect(button(renderer, "Save priorities")).toBeDefined();
  });

  it("discards the local draft back to the saved snapshot", () => {
    const { renderer, patch } = mount({
      ...savedModel,
      anchors: [
        {
          id: "saved",
          kind: "project",
          label: "Saved priority",
          aliases: [],
          weight: 1,
          enabled: true,
          createdAt: "now",
          updatedAt: "now"
        }
      ]
    });

    act(() =>
      input(renderer, "e.g. Finish the launch plan")?.props.onChange({
        target: { value: "Changed priority" },
        currentTarget: { value: "Changed priority" }
      })
    );
    expect(
      renderer.root.findAllByType("input").some((item) => item.props.value === "Changed priority")
    ).toBe(true);
    act(() => button(renderer, "Discard")?.props.onClick());

    expect(
      renderer.root.findAllByType("input").some((item) => item.props.value === "Saved priority")
    ).toBe(true);
    expect(patch).not.toHaveBeenCalled();
  });

  it("preserves hidden and unknown sources through a real Save", async () => {
    const { renderer, patch } = mount();
    act(() =>
      input(renderer, "Include tasks in priority ranking")?.props.onChange({
        target: { checked: false }
      })
    );
    await act(async () => button(renderer, "Save priorities")?.props.onClick());

    const body = JSON.parse(patch.mock.calls[0]?.[0]?.body as string);
    expect(body.mutedSources).toEqual(["memory", "wellness", "future-source", "tasks"]);
    expect(
      renderer.root
        .findAllByType("input")
        .some((item) => item.props["aria-label"]?.includes("memory"))
    ).toBe(false);
  });
});
