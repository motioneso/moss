// @vitest-environment jsdom
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { LocaleSettingsDto } from "@moss/shared";

import type { ChangedBriefingBlock } from "../../apps/web/src/today/briefing-callout.js";
import { SinceLastNight } from "../../apps/web/src/today/since-last-night.js";

const locale: LocaleSettingsDto = {
  timezone: "America/Los_Angeles",
  region: "en-US",
  dateFormat: "12"
};

function change(overrides: Partial<ChangedBriefingBlock> = {}): ChangedBriefingBlock {
  return {
    title: "Focus",
    oldStartsAt: "2026-09-29T17:00:00.000Z",
    newStartsAt: "2026-09-29T18:30:00.000Z",
    proposed: false,
    ...overrides
  };
}

const render = (changed: readonly ChangedBriefingBlock[]) =>
  renderToString(createElement(SinceLastNight, { changed, locale }));

describe("SinceLastNight", () => {
  it("renders nothing when no block moved", () => {
    expect(render([])).toBe("");
  });

  it("states a committed move as set", () => {
    const html = render([change()]);
    expect(html).toContain("Focus is set for 11:30 AM.");
    expect(html).not.toContain("proposed");
  });

  it("states a proposed move as proposed, not as its time", () => {
    const html = render([change({ proposed: true })]);
    expect(html).toContain("Focus is proposed for 11:30 AM.");
    expect(html).not.toContain("is now at");
  });

  it("marks only the proposed blocks when several changed", () => {
    const html = render([
      change({ title: "Focus", proposed: true }),
      change({ title: "Review", proposed: false })
    ]);
    expect(html).toContain("2 blocks changed since this report.");
    expect(html).toMatch(/Focus: [^<]*\(proposed, not yet on the calendar\)/);
    expect(html).not.toMatch(/Review: [^<]*proposed/);
  });
});
