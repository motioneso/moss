// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BriefingRunDto } from "@moss/shared";

import { queryKeys } from "../../apps/web/src/api/query-keys.js";
import {
  buildTodayHeroContent,
  splitHeadline,
  TodayHero
} from "../../apps/web/src/today/today-hero.js";
import {
  cleanupRoots,
  fullRun,
  locale,
  readyDetail,
  renderReader,
  seedClient
} from "./morning-briefing-fixtures.js";

afterEach(async () => {
  await cleanupRoots();
  vi.unstubAllGlobals();
});

const LABELLED =
  "**Headline:** Two meetings before noon.\n\nLead: The afternoon stays open for the draft.\n\n" +
  "## Calendar\nStandup at 9.";

describe("splitHeadline writer labels", () => {
  it.each([
    ["Headline: A clear morning.\n\nLead: Room for lunch.", "A clear morning.", "Room for lunch."],
    [
      "**Headline:** A clear morning.\n\n**Lead:** Room for lunch.",
      "A clear morning.",
      "Room for lunch."
    ],
    ["**HEADLINE**: A clear morning. lead: Room for lunch.", "A clear morning.", "Room for lunch."],
    [
      "\n\nheadline:\nA clear morning.\n\n__Lead__\nRoom for lunch.",
      "A clear morning.",
      "Room for lunch."
    ]
  ])("strips the label from %j", (text, headline, rest) => {
    expect(splitHeadline(text)).toEqual({ headline, rest });
  });

  it("keeps prose that only mentions a lead", () => {
    expect(splitHeadline("Lead with the budget. Then the hires.")).toEqual({
      headline: "Lead with the budget.",
      rest: "Then the hires."
    });
    expect(splitHeadline("A clear morning. Remember to\nlead\nwith the budget.")).toEqual({
      headline: "A clear morning.",
      rest: "Remember to\nlead\nwith the budget."
    });
    expect(splitHeadline("A clear morning.\n\n## Notes\nLead: the budget talk.").rest).toBe(
      "## Notes\nLead: the budget talk."
    );
  });
});

describe("writer labels on screen", () => {
  it("never shows labels in the Today hero headline or summary", () => {
    const run: BriefingRunDto = { ...fullRun(), summaryText: LABELLED };
    const content = buildTodayHeroContent({
      mode: "day",
      assessmentShown: true,
      morningLoading: false,
      morningDefinitionId: "def-morning",
      morningRun: run,
      morningSplit: splitHeadline(run.summaryText),
      morningFreshness: null,
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
    });
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
    expect(markup).toContain("Two meetings before noon.");
    expect(markup).toContain("The afternoon stays open for the draft.");
    expect(markup).not.toMatch(/headline\s*:|lead\s*:/i);
  });

  it("never shows labels in the morning reader", async () => {
    const run = { ...fullRun(), summaryText: LABELLED };
    const client = seedClient([
      [queryKeys.briefings.run("def-morning", "run-full"), readyDetail(run)]
    ]);
    const html = await renderReader(client);
    expect(html).not.toMatch(/headline\s*:|lead\s*:/i);
    expect(html).toContain('class="brief-reader__headline">Two meetings before noon.</h3>');
    expect(html).toContain(
      '<p class="jds-brief__body">The afternoon stays open for the draft.</p>'
    );
  });
});
