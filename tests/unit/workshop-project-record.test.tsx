import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  parseWorkshopProjectResult,
  WorkshopProjectRecord
} from "../../apps/web/src/chat/workshop-project-record.js";

describe("Workshop saved-project handoff", () => {
  it("opens only the saved project's internal destination and makes no build claim", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const result = {
      project: { id, title: "My idea" },
      created: true,
      destination: `/workshop/${id}`
    };
    const parsed = parseWorkshopProjectResult(result);
    expect(parsed).not.toBeNull();
    const html = renderToStaticMarkup(createElement(WorkshopProjectRecord, parsed!));
    expect(html).toContain(`href="/workshop/${id}"`);
    expect(html).toContain("Planning has not started.");
    expect(html).not.toContain("Build it");
    for (const destination of ["https://example.com", "javascript:alert(1)", "/workshop/other"]) {
      expect(parseWorkshopProjectResult({ ...result, destination })).toBeNull();
    }
    expect(
      parseWorkshopProjectResult({ ...result, project: { id: "../settings", title: "x" } })
    ).toBeNull();
    expect(parseWorkshopProjectResult(undefined)).toBeNull();
    expect(parseWorkshopProjectResult({ buildId: "old", plan: {} })).toBeNull();
  });
});
