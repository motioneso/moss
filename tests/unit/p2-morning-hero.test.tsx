import * as labels from "../../apps/web/src/today/today-labels.js";
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
    expect(markup.indexOf('class="today-hero__summary"')).toBeLessThan(
      markup.indexOf('class="today-hero__weather"')
    );
    expect(markup.indexOf('class="today-hero__weather"')).toBeLessThan(
      markup.indexOf('class="today-hero__prepared"')
    );
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
    const end = flat.indexOf("/* End morning-only vertical rhythm. */");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return flat.slice(start, end);
  }

  it("wide: day-scoped padding, eyebrow gap and prepared gap match the study rhythm", async () => {
    const block = dayBlock(await heroCss());
    expect(block).toContain('.today-hero[data-mode="day"] { padding-top: 37px; }');
    expect(block).toContain(
      '.today-hero[data-mode="day"] .today-hero__eyebrow { margin-bottom: 24px; }'
    );
    expect(block).toContain(
      '.today-hero[data-mode="day"] .today-hero__prepared { margin-top: 35px; justify-content: space-between; }'
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

  it("whole file: bare hero spacing anywhere equals the shared baseline snapshot", async () => {
    // Evening pixel-parity itself is Prover's guard captures, not this
    // test. This test scans the entire stylesheet so an unscoped spacing
    // rule anywhere in the file gets caught: every margin, padding or gap
    // declaration on a today-hero selector must either sit under
    // [data-mode="day"] or match the shared-baseline snapshot below that
    // both modes already render. Changing a baseline value means evening
    // moves too, so the snapshot forces that edit to update this test.
    const css = await heroCss();
    const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const flat = (s: string) => s.trim().replace(/\s+/g, " ");
    const squeeze = (s: string) => s.replace(/\s+/g, "");
    type Rule = { media: string; selector: string; body: string };
    const rules: Rule[] = [];
    let i = 0;
    while (i < clean.length) {
      while (i < clean.length && /\s/.test(clean[i] ?? "")) i++;
      if (i >= clean.length) break;
      const brace = clean.indexOf("{", i);
      if (brace === -1) break;
      const prelude = flat(clean.slice(i, brace));
      let depth = 1;
      let j = brace + 1;
      while (j < clean.length && depth > 0) {
        if (clean[j] === "{") depth++;
        else if (clean[j] === "}") depth--;
        j++;
      }
      const body = clean.slice(brace + 1, j - 1);
      if (prelude.startsWith("@media")) {
        for (const m of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
          rules.push({ media: prelude, selector: flat(m[1] ?? ""), body: m[2] ?? "" });
        }
      } else {
        rules.push({ media: "", selector: prelude, body });
      }
      i = j;
    }
    const snapshot: Record<string, string[]> = {
      "|.today-hero": ["margin:0calc(-1*var(--space-6))18px", "padding:29px34px30px"],
      "@media (max-width: 880px)|.today-hero": ["padding:23px22px"],
      "@media (max-width: 560px)|.today-hero": ["margin-left:-0.75rem", "margin-right:-0.75rem"],
      "|.today-hero__eyebrow": ["margin:0010px"],
      "|.today-hero__title": ["margin:0"],
      "|.today-hero__summary": ["margin-top:19px"],
      "|.today-hero__prepared": ["gap:8px16px", "margin:21px00"],
      "|.today-hero__rule": ["margin:20px016px"],
      "|.today-hero__weather .wx-row": ["margin-top:0"]
    };
    const seen = new Set<string>();
    for (const rule of rules) {
      if (!rule.selector.includes("today-hero")) continue;
      if (rule.selector.includes("today-hero__sections")) continue;
      if (rule.selector.includes('[data-mode="day"]')) continue;
      const decls: string[] = [];
      for (const m of rule.body.matchAll(/(margin|padding|gap)(-[a-z]+)?\s*:\s*([^;]+);/g)) {
        decls.push(squeeze(`${m[1] ?? ""}${m[2] ?? ""}:${m[3] ?? ""}`));
      }
      if (decls.length === 0) continue;
      const key = `${rule.media}|${rule.selector}`;
      expect(snapshot[key]).toEqual(decls.sort());
      seen.add(key);
    }
    expect([...seen].sort()).toEqual(Object.keys(snapshot).sort());
  });

  it("keeps the day section index cascade after the generic section rules", async () => {
    const css = await heroCss();
    expect(css.lastIndexOf(".today-hero__sections {")).toBeGreaterThan(
      css.indexOf(".cmd-sections {")
    );
  });

  it("asserts the four-link inventory in order and the utility row present with the not-ready line when the run is not readable", () => {
    expect((labels as Record<string, unknown>).TODAY_SECTION_LINKS).toEqual([
      { href: "#start-here", label: "Your day & preparation" },
      { href: "#needs-you", label: "Quick actions" },
      { href: "#news", label: "News" },
      { href: "#sports", label: "Sports" }
    ]);

    const markup = renderToStaticMarkup(
      <TodayHero
        mode="day"
        eyebrow="Good morning"
        headline="Morning headline"
        summary="Morning summary"
        preparedAt={null}
        readerControl={null}
        weather={null}
      />
    );

    expect(markup).toContain('class="today-hero__prepared"');
    expect(markup).toContain('class="today-hero__not-ready"');
    expect(markup).toContain("Briefing not ready yet");
  });

  it("renders the section index outside the hero band below the gold rule", () => {
    const markup = renderToStaticMarkup(
      <TodayHero
        mode="day"
        eyebrow="Good morning"
        headline="Morning headline"
        summary="Morning summary"
        preparedAt={null}
        readerControl={null}
        weather={null}
        sectionLinks={<nav id="section-nav">Links</nav>}
      />
    );

    const ruleIndex = markup.indexOf('class="today-hero__rule"');
    const closingSectionIndex = markup.indexOf("</section>");
    const navIndex = markup.indexOf('id="section-nav"');

    expect(ruleIndex).toBeGreaterThan(-1);
    expect(closingSectionIndex).toBeGreaterThan(ruleIndex);
    expect(navIndex).toBeGreaterThan(closingSectionIndex);
  });
});
