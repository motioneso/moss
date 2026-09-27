import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import {
  BriefingFreshnessList,
  BriefingStaleBanner,
  delayedEmailSource,
  parseBriefingFreshness
} from "../../apps/web/src/today/briefing-freshness.js";
import type { LocaleSettingsDto, SourceFreshnessV1 } from "@moss/shared";

const locale: LocaleSettingsDto = {
  timezone: "America/Los_Angeles",
  region: "en-US",
  dateFormat: "12"
};

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

describe("parseBriefingFreshness", () => {
  it("reads the saved sourceTimestamps field from briefing metadata", () => {
    expect(parseBriefingFreshness({ sourceTimestamps: freshness })).toEqual(freshness);
  });
});

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

describe("BriefingFreshnessList contribution rows", () => {
  const timed: SourceFreshnessV1 = {
    version: 1,
    capturedAt: "2026-09-10T16:00:00.000Z",
    sources: [
      {
        source: "calendar",
        freshnessKind: "connector_sync",
        asOf: "2026-09-10T13:40:00.000Z"
      },
      { source: "tasks", freshnessKind: "realtime", asOf: "2026-09-10T16:00:00.000Z" },
      { source: "vault", freshnessKind: "vault_write", asOf: null }
    ]
  };
  const counts = {
    sectionLines: { calendar: 9, tasks: 5 },
    calendarTodayCount: 4,
    calendarEventCount: 9,
    taskCount: 9,
    vaultCount: 0
  };

  it("names each source with its local time and what it contributed", () => {
    const html = renderToString(
      createElement(BriefingFreshnessList, { freshness: timed, locale, sourceMetadata: counts })
    );
    expect(html).toContain("Calendar");
    expect(html).toContain("6:40 AM");
    expect(html).toContain("4 events on today&#x27;s schedule");
    expect(html).toContain("5 tasks");
  });

  it("shows no contribution line for a source with nothing recorded", () => {
    const html = renderToString(
      createElement(BriefingFreshnessList, { freshness: timed, locale, sourceMetadata: counts })
    );
    expect(html).toContain("Notes");
    expect(html).not.toContain("saved notes");
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

  it("ignores invalid capture and email timestamps", () => {
    const invalidCapture: SourceFreshnessV1 = {
      version: 1,
      capturedAt: "not-a-date",
      sources: [
        { source: "email", freshnessKind: "connector_sync", asOf: "2026-06-28T08:00:00.000Z" }
      ]
    };
    const invalidEmailTime: SourceFreshnessV1 = {
      version: 1,
      capturedAt: CAPTURED,
      sources: [{ source: "email", freshnessKind: "connector_sync", asOf: "not-a-date" }]
    };
    expect(delayedEmailSource(invalidCapture)).toBeNull();
    expect(delayedEmailSource(invalidEmailTime)).toBeNull();
  });
});
