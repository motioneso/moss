import { describe, expect, it } from "vitest";

import { defaultToolNamesFor } from "../../packages/briefings/src/routes.js";

// Load-bearing guard (Ben, 2026-07-01): the day's followed-team facts must be in the DEFAULT
// briefing tool set, not only the hand-selected path. A regression that drops the tool from the
// morning/evening defaults fails CI here. Today-scoped facts are intentionally NOT in the
// weekly_review default (a retrospective).
describe("briefing default tool sets", () => {
  it("includes sports.followedFactsToday in the morning default", () => {
    expect(defaultToolNamesFor("morning")).toContain("sports.followedFactsToday");
  });

  it("includes sports.followedFactsToday in the evening default", () => {
    expect(defaultToolNamesFor("evening")).toContain("sports.followedFactsToday");
  });

  it("does NOT include sports.followedFactsToday in the weekly_review default", () => {
    expect(defaultToolNamesFor("weekly_review")).not.toContain("sports.followedFactsToday");
  });

  it("includes news.topHeadlinesToday in the morning default only", () => {
    expect(defaultToolNamesFor("morning")).toContain("news.topHeadlinesToday");
    expect(defaultToolNamesFor("evening")).not.toContain("news.topHeadlinesToday");
    expect(defaultToolNamesFor("weekly_review")).not.toContain("news.topHeadlinesToday");
  });

  it("includes vault in morning and weekly_review, but not evening", () => {
    expect(defaultToolNamesFor("morning")).toContain("vault");
    expect(defaultToolNamesFor("weekly_review")).toContain("vault");
    expect(defaultToolNamesFor("evening")).not.toContain("vault");
  });
});
