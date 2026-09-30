import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  BriefingMarkdown,
  EVENING_SECTION_NAMES,
  plainBriefingText
} from "../../apps/web/src/today/briefing-markdown.js";
import type { EveningPlanningController } from "../../apps/web/src/today/evening-planning-controller.js";
import { ReflectStep } from "../../apps/web/src/today/evening-planning-sections.js";
import { morningReportLead, splitHeadline } from "../../apps/web/src/today/today-hero.js";

describe("briefing plain text", () => {
  it("strips markdown marks from a headline", () => {
    expect(splitHeadline("**Morning Briefing**\nCalendar is quiet.").headline).toBe(
      "Morning Briefing"
    );
    expect(splitHeadline("## A calm day.\n\nLead.").headline).toBe("A calm day.");
  });

  it("keeps a two-sentence headline whole when it sits on its own first line (#2766)", () => {
    const text =
      "A clear morning. A full afternoon.\n\nThe proposal matters most. Start it early.\n\n" +
      "## Bring the notes to the 1:00 PM review\nDetails.";
    const split = splitHeadline(text);
    expect(split.headline).toBe("A clear morning. A full afternoon.");
    expect(morningReportLead(split.rest)).toBe("The proposal matters most. Start it early.");

    expect(splitHeadline("Dentist at 8:30 a.m. then a quiet day\n\nLead.").headline).toBe(
      "Dentist at 8:30 a.m. then a quiet day"
    );
  });

  it("keeps the sentence split for an older report whose short opening goes straight to a heading", () => {
    for (const heading of ["## Tasks", "**Tasks**"]) {
      const split = splitHeadline(
        `A busy day. Finish the proposal before lunch.\n\n${heading}\nMore.`
      );
      expect(split.headline).toBe("A busy day.");
      expect(morningReportLead(split.rest)).toBe("Finish the proposal before lunch.");
    }
  });

  it("strips inline marks without touching ordinary punctuation", () => {
    expect(plainBriefingText("Reply to **Alex** about the *contract* and `v2`.")).toBe(
      "Reply to Alex about the contract and v2."
    );
    expect(plainBriefingText("Scores: 3*4 = 12, snake_case stays.")).toBe(
      "Scores: 3*4 = 12, snake_case stays."
    );
  });

  it("previews a plain lead on Today", () => {
    const { rest } = splitHeadline(
      "**Morning Briefing**\nCalendar is **quiet**.\n\n**Tasks**\nMore."
    );
    expect(plainBriefingText(morningReportLead(rest))).toBe("Calendar is quiet.");
  });
});

describe("BriefingMarkdown", () => {
  it("never renders raw HTML, images or unsafe links from generated text", () => {
    const html = renderToStaticMarkup(
      createElement(BriefingMarkdown, {
        text:
          '<script>alert(1)</script>\n\n<img src="https://x.test/a.png">\n\n' +
          "![pic](https://x.test/b.png) [bad](javascript:alert(1)) [ok](https://ok.test)"
      })
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("javascript:");
    expect(html).toContain('href="https://ok.test"');
  });

  it("promotes a bare evening section line only when it starts a paragraph", () => {
    const html = renderToStaticMarkup(
      createElement(BriefingMarkdown, {
        text: "A calm day.\n\nWhat got done\n- Sent the draft\n\nTomorrow\nTomorrow looks clear.",
        sectionNames: EVENING_SECTION_NAMES
      })
    );
    expect(html).toContain('<h4 class="brief-reader__section-heading">What got done</h4>');
    expect(html).toContain('<h4 class="brief-reader__section-heading">Tomorrow</h4>');
    expect(html).toContain('<p class="jds-brief__body">Tomorrow looks clear.</p>');
  });
});

describe("evening planning reflect step", () => {
  const evening = {
    reflection: null,
    setReflection: () => undefined
  } as unknown as EveningPlanningController;

  it("renders the evening report sections as headings, not inline text", () => {
    const report =
      "The day is ready to close.\n\n**What got done**\nYou finished the interview.\n\n" +
      "**What slipped**\nNothing fell off today.\n\n**Tomorrow**\nTomorrow looks clear.\n\n" +
      "## News & sports\n- Quiet day.";
    const html = renderToStaticMarkup(
      createElement(ReflectStep, {
        evening,
        headingId: "evening-step-0",
        ledeHtml: "The day is ready to close.",
        summaryText: report
      })
    );
    const headings = [...html.matchAll(/<h4 class="brief-reader__section-heading">(.*?)<\/h4>/g)];
    expect(headings.map((match) => match[1])).toEqual([
      "What got done",
      "What slipped",
      "Tomorrow",
      "News &amp; sports"
    ]);
    expect(html).toContain('<p class="jds-brief__body">Tomorrow looks clear.</p>');
    expect(html).not.toContain("**");
    expect(html).toContain('<ul class="brief-reader__list">');
    expect(html).toContain("evening-plan__choices");
  });
});
