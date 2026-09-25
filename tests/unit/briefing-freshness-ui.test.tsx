import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import {
  BriefingFreshnessList,
  BriefingStaleBanner,
  delayedEmailSource
} from "../../apps/web/src/today/briefing-freshness.js";
import type { SourceFreshnessV1 } from "@moss/shared";

const CAPTURED = "2026-06-28T10:00:00.000Z";

const freshness: SourceFreshnessV1 = {
  version: 1,
  capturedAt: CAPTURED,
  sources: [
    { source: "email", freshnessKind: "connector_sync", asOf: "2026-06-27T22:00:00.000Z" },
    { source: "tasks", freshnessKind: "realtime", asOf: CAPTURED },
    { source: "vault", freshnessKind: "vault_write", asOf: null }
  ]
};

describe("BriefingFreshnessList", () => {
  it("renders source labels", () => {
    const html = renderToString(createElement(BriefingFreshnessList, { freshness }));
    expect(html).toContain("Email");
    expect(html).toContain("Tasks");
    expect(html).toContain("Notes");
  });
  it("renders live for realtime sources", () => {
    const html = renderToString(createElement(BriefingFreshnessList, { freshness }));
    expect(html).toContain("live");
  });
  it("renders unknown for null asOf", () => {
    const html = renderToString(createElement(BriefingFreshnessList, { freshness }));
    expect(html).toContain("unknown");
  });
  it("renders relative age for timestamped sources", () => {
    const html = renderToString(createElement(BriefingFreshnessList, { freshness }));
    expect(html).toMatch(/\d+(h|m|d) ago/);
  });
});

describe("BriefingStaleBanner", () => {
  it("renders for stale sources (>24h)", () => {
    const staleFreshness: SourceFreshnessV1 = {
      version: 1,
      capturedAt: CAPTURED,
      sources: [
        { source: "email", freshnessKind: "connector_sync", asOf: "2026-06-26T10:00:00.000Z" }
      ]
    };
    const html = renderToString(createElement(BriefingStaleBanner, { freshness: staleFreshness }));
    expect(html).toContain("Email");
  });
  it("renders nothing when all sources are within threshold", () => {
    const recentFreshness: SourceFreshnessV1 = {
      version: 1,
      capturedAt: CAPTURED,
      sources: [
        { source: "email", freshnessKind: "connector_sync", asOf: "2026-06-27T22:00:00.000Z" }
      ]
    };
    expect(renderToString(createElement(BriefingStaleBanner, { freshness: recentFreshness }))).toBe(
      ""
    );
  });
  it("renders nothing for realtime sources", () => {
    const rtFreshness: SourceFreshnessV1 = {
      version: 1,
      capturedAt: CAPTURED,
      sources: [{ source: "tasks", freshnessKind: "realtime", asOf: CAPTURED }]
    };
    expect(renderToString(createElement(BriefingStaleBanner, { freshness: rtFreshness }))).toBe("");
  });
  it("can leave delayed email to its source-specific notice", () => {
    const staleEmail: SourceFreshnessV1 = {
      version: 1,
      capturedAt: CAPTURED,
      sources: [
        { source: "email", freshnessKind: "connector_sync", asOf: "2026-06-26T10:00:00.000Z" }
      ]
    };
    expect(
      renderToString(
        createElement(BriefingStaleBanner, { freshness: staleEmail, excludeSources: ["email"] })
      )
    ).toBe("");
  });
});

describe("delayedEmailSource", () => {
  it("flags email more than an hour behind the briefing capture", () => {
    const delayed: SourceFreshnessV1 = {
      version: 1,
      capturedAt: CAPTURED,
      sources: [
        { source: "email", freshnessKind: "connector_sync", asOf: "2026-06-28T08:59:00.000Z" }
      ]
    };
    expect(delayedEmailSource(delayed)?.asOf).toBe("2026-06-28T08:59:00.000Z");
  });

  it("does not flag a source within an hour or a realtime source", () => {
    const recent: SourceFreshnessV1 = {
      version: 1,
      capturedAt: CAPTURED,
      sources: [
        { source: "email", freshnessKind: "connector_sync", asOf: "2026-06-28T09:00:00.000Z" }
      ]
    };
    expect(delayedEmailSource(recent)).toBeNull();
    const realtime: SourceFreshnessV1 = {
      version: 1,
      capturedAt: CAPTURED,
      sources: [{ source: "email", freshnessKind: "realtime", asOf: "2026-06-27T10:00:00.000Z" }]
    };
    expect(delayedEmailSource(realtime)).toBeNull();
  });
});
