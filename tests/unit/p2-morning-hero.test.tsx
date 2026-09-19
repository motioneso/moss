import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { BriefingRunDto, LocaleSettingsDto, SourceFreshnessV1 } from "@moss/shared";

import {
  buildTodayHeroContent,
  splitHeadline,
  TodayHero
} from "../../apps/web/src/today/today-hero.js";

const locale: LocaleSettingsDto = {
  timezone: "America/Los_Angeles",
  region: "en-US",
  dateFormat: "12"
};

function morningRun(overrides: Partial<BriefingRunDto> = {}): BriefingRunDto {
  return {
    id: "run-1",
    definitionId: "def-1",
    ownerUserId: "user-1",
    status: "succeeded",
    runKind: "scheduled",
    briefingType: "morning",
    summaryText: "A clear morning. There is room for a break and lunch before the review.",
    sourceMetadata: {},
    feedbackItems: [],
    structuredPayload: { version: 1, actionRows: [], catchUp: null },
    createdAt: "2026-09-18T15:00:00.000Z",
    ...overrides
  };
}

const baseInput = {
  mode: "day" as const,
  assessmentShown: true,
  morningLoading: false,
  morningDefinitionId: "def-1",
  eveningRun: null,
  eveningSplit: null,
  eveningLoading: false,
  eveningTargetTime: "19:00",
  fallbackTop: "Good morning.",
  fallbackAccent: "Here is your day.",
  ledeHtml: "<span>Fallback lede</span>",
  locale,
  onFeedbackChanged: () => {},
  onOpenReader: () => {}
};

describe("buildTodayHeroContent — morning (day) mode", () => {
  it("populated: headline is the split first sentence, body is the rest, prepared time is real, reader control is present", () => {
    const run = morningRun();
    const split = splitHeadline(run.summaryText);
    const content = buildTodayHeroContent({
      ...baseInput,
      morningRun: run,
      morningSplit: split,
      morningFreshness: null
    });

    expect(content.preparedAt).toBe("Prepared at 8:00");
    expect(content.readerControl).not.toBeNull();

    const markup = renderToStaticMarkup(
      <TodayHero
        mode="day"
        eyebrow="Good morning"
        headline={content.headline}
        summary={content.summary}
        preparedAt={content.preparedAt}
        readerControl={content.readerControl}
        weather={<div>weather</div>}
      />
    );
    expect(markup).toContain("A clear morning.");
    expect(markup).toContain("There is room for a break and lunch before the review.");
    // The bulleted fallback must never appear once a readable run exists.
    expect(markup).not.toContain("Fallback lede");
  });

  it("not ready: no run means the prepared line names the not-ready state and there is no reader control", () => {
    const content = buildTodayHeroContent({
      ...baseInput,
      morningRun: null,
      morningSplit: null,
      morningFreshness: null
    });

    expect(content.preparedAt).toBe("Your morning briefing is not ready yet.");
    expect(content.readerControl).toBeNull();
  });

  it("loading: prepared time is withheld and the summary shows the gathering state", () => {
    const content = buildTodayHeroContent({
      ...baseInput,
      morningLoading: true,
      morningRun: null,
      morningSplit: null,
      morningFreshness: null
    });

    expect(content.preparedAt).toBeNull();
    const markup = renderToStaticMarkup(<div>{content.summary}</div>);
    expect(markup).toContain("Gathering your morning briefing");
  });

  it("assessment hidden: falls back to the lede and withholds the prepared line even with a readable run", () => {
    const run = morningRun();
    const content = buildTodayHeroContent({
      ...baseInput,
      assessmentShown: false,
      morningRun: run,
      morningSplit: splitHeadline(run.summaryText),
      morningFreshness: null
    });

    expect(content.preparedAt).toBeNull();
    const markup = renderToStaticMarkup(<div>{content.summary}</div>);
    expect(markup).toContain("Fallback lede");
  });

  it("stale: the freshness banner renders ahead of the briefing body", () => {
    const run = morningRun();
    const freshness: SourceFreshnessV1 = {
      version: 1,
      capturedAt: "2026-09-17T15:00:00.000Z",
      sources: [
        { source: "email", freshnessKind: "connector_sync", asOf: "2026-09-15T15:00:00.000Z" }
      ]
    };
    const content = buildTodayHeroContent({
      ...baseInput,
      morningRun: run,
      morningSplit: splitHeadline(run.summaryText),
      morningFreshness: freshness
    });

    const markup = renderToStaticMarkup(<div>{content.summary}</div>);
    expect(markup).toContain("Some sources are over a day old");
    expect(markup).toContain("There is room for a break and lunch before the review.");
  });
});

describe("morning hero vertical rhythm (day mode only)", () => {
  async function heroCss(): Promise<string> {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const cssUrl = new URL("../../apps/web/src/styles/kit-today-hero.css", import.meta.url);
    return readFile(fileURLToPath(cssUrl), "utf8");
  }

  function dayBlock(css: string): string {
    const flat = css.replace(/\s+/g, " ");
    const start = flat.indexOf("/* Morning-only vertical rhythm");
    expect(start).toBeGreaterThan(-1);
    return flat.slice(start);
  }

  it("wide: day-scoped padding, eyebrow gap and prepared gap match the study rhythm", async () => {
    const block = dayBlock(await heroCss());
    expect(block).toContain('.today-hero[data-mode="day"] { padding-top: 37px; }');
    expect(block).toContain(
      '.today-hero[data-mode="day"] .today-hero__eyebrow { margin-bottom: 24px; }'
    );
    expect(block).toContain(
      '.today-hero[data-mode="day"] .today-hero__prepared { margin-top: 35px; }'
    );
  });

  it("narrow: day-scoped rhythm keeps mobile tops on the study (summary 18px per study)", async () => {
    const block = dayBlock(await heroCss());
    expect(block).toContain("@media (max-width: 680px)");
    expect(block).toContain('.today-hero[data-mode="day"] { padding-top: 25px; }');
    expect(block).toContain(
      '.today-hero[data-mode="day"] .today-hero__eyebrow { margin-bottom: 19px; }'
    );
    expect(block).toContain(
      '.today-hero[data-mode="day"] .today-hero__summary { margin-top: 18px; }'
    );
    expect(block).toContain(
      '.today-hero[data-mode="day"] .today-hero__prepared { margin-top: 11px; }'
    );
  });

  it("evening hero is untouched: no bare (unscoped) rhythm overrides", async () => {
    const block = dayBlock(await heroCss());
    // Every margin/padding declaration in the rhythm block must sit under a
    // [data-mode="day"] selector, so the evening guards cannot move.
    const declarations = block.match(/[a-z-]+:\s*\d+px;/g) ?? [];
    expect(declarations.length).toBeGreaterThan(0);
    const selectors = block.match(/[^{}]+(?=\{)/g) ?? [];
    for (const selector of selectors) {
      if (selector.includes("@media")) continue;
      expect(selector).toContain('[data-mode="day"]');
    }
  });
});
