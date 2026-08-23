import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { WorkshopGroups } from "../../packages/workshop/src/web/workshop-groups.js";
import type {
  ExternalModuleSummary,
  ModuleBuildSummary
} from "../../packages/workshop/src/web/types.js";

function render(
  builds: readonly ModuleBuildSummary[],
  modules: readonly ExternalModuleSummary[]
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
    title: "Allotment watering log",
    description: "Tracks watering for the allotment beds",
    status: "building",
    step: "Writing the page",
    stepIndex: 4,
    totalSteps: 6,
    progressPercent: 64,
    startedAt: "2026-08-20T09:00:00Z",
    costCents: 42,
    dailyLimitCents: 500,
    log: [],
    reachesExternalServices: 0,
    storesData: true,
    ...overrides
  };
}

function liveModule(overrides: Partial<ExternalModuleSummary> = {}): ExternalModuleSummary {
  return {
    id: "m-1",
    title: "Good Mythical Morning tracker",
    description: "Watches for new episodes",
    scope: "you",
    approvedAt: "2026-08-01T09:00:00Z",
    lastRefreshedAt: "2026-08-20T09:00:00Z",
    usedByCount: null,
    broken: false,
    brokenReason: null,
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

  it("shows a build awaiting approval under Needs you", () => {
    const html = render([building({ id: "b-2", status: "awaiting_plan_approval" })], []);
    expect(html).toContain("Needs you");
  });

  it("shows an installed module under Live", () => {
    const html = render([], [liveModule()]);
    expect(html).toContain("Live");
    expect(html).toContain("Good Mythical Morning tracker");
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
