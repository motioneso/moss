import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { ChatFreshnessFooter } from "@moss/ui";
import type { SourceFreshnessV1 } from "@moss/shared";

const CAPTURED = "2026-06-28T10:00:00.000Z";
const freshness: SourceFreshnessV1 = {
  version: 1,
  capturedAt: CAPTURED,
  sources: [
    { source: "email", freshnessKind: "connector_sync", asOf: "2026-06-27T22:00:00.000Z" },
    { source: "tasks", freshnessKind: "realtime", asOf: CAPTURED }
  ]
};

describe("ChatFreshnessFooter", () => {
  it("renders nothing when sourceFreshness is null", () => {
    expect(renderToString(createElement(ChatFreshnessFooter, { sourceFreshness: null }))).toBe("");
  });
  it("renders nothing when sourceFreshness is undefined", () => {
    expect(renderToString(createElement(ChatFreshnessFooter, { sourceFreshness: undefined }))).toBe(
      ""
    );
  });
  it("renders a details element with source names", () => {
    const html = renderToString(createElement(ChatFreshnessFooter, { sourceFreshness: freshness }));
    expect(html).toContain("<details");
    expect(html).toContain("Email");
    expect(html).toContain("Tasks");
  });
  it("renders ages in the body", () => {
    const html = renderToString(createElement(ChatFreshnessFooter, { sourceFreshness: freshness }));
    expect(html).toContain("live");
    expect(html).toMatch(/\d+(h|m|d) ago/);
  });
});
