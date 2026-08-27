import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { act, create } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { ModuleBuildSummary, WorkshopLiveModuleSummary } from "@moss/shared";

import { WorkshopGroups } from "../../packages/workshop/src/web/workshop-groups.js";

const actions = {
  onApprove: vi.fn(),
  onCancel: vi.fn(),
  onOpenDraft: vi.fn(),
  onDiscardDraft: vi.fn(),
  onAskForChange: vi.fn(),
  onShip: vi.fn()
};

function render(
  builds: readonly ModuleBuildSummary[],
  modules: readonly WorkshopLiveModuleSummary[]
): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToString(
    createElement(
      QueryClientProvider,
      { client },
      createElement(WorkshopGroups, { builds, modules, actions })
    )
  );
}

function building(overrides: Partial<ModuleBuildSummary> = {}): ModuleBuildSummary {
  return {
    id: "b-1",
    status: "building",
    step: "writing_spec",
    moduleId: null,
    plan: {
      whatItDoes: "Allotment watering log",
      whatItReaches: ["the weather service"],
      whatItKeeps: "watering dates",
      whenItRuns: "each morning",
      roughCost: { time: "5 minutes", budgetCents: 500 }
    },
    fetchedUrls: [],
    writtenFiles: [],
    costCents: 42,
    error: null,
    createdAt: "2026-08-20T09:00:00Z",
    updatedAt: "2026-08-20T09:00:00Z",
    ...overrides
  };
}

function liveModule(overrides: Partial<WorkshopLiveModuleSummary> = {}): WorkshopLiveModuleSummary {
  return {
    id: "m-1",
    name: "Good Mythical Morning tracker",
    version: "0.1.0",
    scope: "you",
    ...overrides
  };
}

describe("WorkshopGroups", () => {
  it("shows an in-progress build under Building now, with its current step", () => {
    const html = render([building()], []);
    expect(html).toContain("Building now");
    expect(html).toContain("Allotment watering log");
    expect(html).toContain("Writing the plan");
    expect(html).toContain("Last active");
    expect(html).toContain('dateTime="2026-08-20T09:00:00Z"');
    expect(html).not.toContain("writing_spec");
    expect(html).not.toContain("5 minutes");
    expect(html).not.toContain("budget");
  });

  it("shows what a build has written while it's in progress", () => {
    const html = render([building({ writtenFiles: ["module.ts", "module.test.ts"] })], []);
    expect(html).toContain("What it has written");
    expect(html).toContain("module.ts");
    expect(html).toContain("module.test.ts");
  });

  it("shows a build awaiting approval under Needs you", () => {
    const html = render([building({ id: "b-2", status: "awaiting_plan_approval" })], []);
    expect(html).toContain("Needs you");
  });

  it("shows a failed build under Needs you with a working discard action", async () => {
    const handlers = { ...actions, onCancel: vi.fn() };
    let tree: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        createElement(WorkshopGroups, {
          builds: [building({ status: "failed", error: "Error" })],
          modules: [],
          actions: handlers
        })
      );
    });

    expect(JSON.stringify(tree!.toJSON())).toContain("Build couldn’t start");
    const discard = tree!.root
      .findAllByType("button")
      .find((node) => node.children.join("") === "Discard");
    await act(async () => discard?.props.onClick());
    expect(handlers.onCancel).toHaveBeenCalledWith("b-1");
  });

  it("renders a still-planning build without a plan, without throwing", () => {
    const html = render([building({ status: "planning", plan: null })], []);
    expect(html).toContain("New module");
  });

  it("shows an installed module under Live", () => {
    const html = render([], [liveModule()]);
    expect(html).toContain("Live");
    expect(html).toContain("Good Mythical Morning tracker");
    expect(html).toContain("Live · you only");
  });

  it("shows the everyone badge for a shipped module", () => {
    const html = render([], [liveModule({ scope: "everyone" })]);
    expect(html).toContain("Live · everyone");
  });

  it("renders the empty state when there is nothing to show", () => {
    const html = render([], []);
    expect(html).toContain("Nothing in the workshop yet");
  });

  it("wires every visible Workshop control to a real action", async () => {
    const handlers = {
      onApprove: vi.fn(),
      onCancel: vi.fn(),
      onOpenDraft: vi.fn(),
      onDiscardDraft: vi.fn(),
      onAskForChange: vi.fn(),
      onShip: vi.fn()
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["settings", "locale"], {
      locale: { timezone: "UTC", region: "en-US", dateFormat: "12" }
    });
    let tree: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        createElement(
          QueryClientProvider,
          { client },
          createElement(WorkshopGroups, {
            builds: [
              building({ id: "approve", status: "awaiting_plan_approval" }),
              building({
                id: "draft",
                status: "awaiting_change",
                moduleId: "videos"
              }),
              building({ id: "active" })
            ],
            modules: [liveModule({ id: "videos" })],
            actions: handlers
          })
        )
      );
    });
    const button = (label: string) =>
      tree.root.findAllByType("button").find((node) => node.children.join("") === label)!;

    await act(async () => {
      button("Build it").props.onClick();
      button("Look at the draft").props.onClick();
      const discards = tree.root
        .findAllByType("button")
        .filter((node) => node.children.join("") === "Discard");
      discards[0]?.props.onClick();
      discards[1]?.props.onClick();
      button("Stop").props.onClick();
      button("Ask for a change").props.onClick();
      button("Turn on for everyone").props.onClick();
    });

    expect(handlers.onApprove).toHaveBeenCalledWith("approve");
    expect(handlers.onOpenDraft).toHaveBeenCalledWith("videos");
    expect(handlers.onCancel).toHaveBeenCalledWith("approve");
    expect(handlers.onDiscardDraft).toHaveBeenCalledWith("videos");
    expect(handlers.onCancel).toHaveBeenCalledWith("active");
    expect(handlers.onAskForChange).toHaveBeenCalledWith("videos");
    expect(handlers.onShip).toHaveBeenCalledWith("videos");
  });

  it("only renders jds-* design system classes, no invented ones", () => {
    const html = render([building()], [liveModule()]);
    const classAttrs = [...html.matchAll(/class="([^"]*)"/g)].flatMap((m) =>
      (m[1] ?? "").split(/\s+/)
    );
    for (const cls of classAttrs) {
      expect(cls === "" || cls.startsWith("jds-") || cls.startsWith("workshop-")).toBe(true);
    }
  });
});
