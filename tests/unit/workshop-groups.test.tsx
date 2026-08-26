import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { ModuleBuildSummary, WorkshopLiveModuleSummary } from "@moss/shared";

import { WorkshopGroups } from "../../packages/workshop/src/web/workshop-groups.js";

function render(
  builds: readonly ModuleBuildSummary[],
  modules: readonly WorkshopLiveModuleSummary[]
): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToString(
    createElement(
      QueryClientProvider,
      { client },
      createElement(WorkshopGroups, { builds, modules })
    )
  );
}

function building(overrides: Partial<ModuleBuildSummary> = {}): ModuleBuildSummary {
  return {
    id: "b-1",
    status: "building",
    step: "Writing the page",
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
    expect(html).toContain("Writing the page");
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
