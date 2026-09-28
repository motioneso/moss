import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BriefingMarkdown, plainBriefingText } from "../../apps/web/src/today/briefing-markdown.js";
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
});
