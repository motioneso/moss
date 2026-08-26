import { describe, expect, it } from "vitest";

import {
  canonicalStoryUrl,
  composeSportsNewsGroups
} from "../../packages/sports/src/headline-composition.js";
import type { SourceHeadline } from "../../packages/sports/src/source/sports-source.js";

function headline(overrides: Partial<SourceHeadline>): SourceHeadline {
  return {
    id: "story",
    sportKey: "soccer",
    competitionKey: null,
    competitionLabel: "Soccer",
    title: "Shared story",
    url: "https://example.com/story?id=1",
    publishedAt: "2026-08-25T12:00:00.000Z",
    imageUrl: null,
    summary: "",
    teamKeys: [],
    origin: "custom",
    sourceId: "fotmob",
    publisherLabel: "FotMob",
    publisherDomain: "fotmob.com",
    ...overrides
  } as SourceHeadline;
}

describe("sports headline composition", () => {
  it("normalizes safe public URLs while preserving path and query", () => {
    expect(canonicalStoryUrl("https://Example.COM:443/news/Story?ref=home#section")).toBe(
      "https://example.com/news/Story?ref=home"
    );
    expect(canonicalStoryUrl("javascript:alert(1)")).toBeNull();
  });

  it("deduplicates provider and scope paths by canonical URL without fanning out sport stories", () => {
    const sportStory = headline({ url: "https://Example.com:443/story?id=1#sport" });
    const duplicateEspnStory = headline({
      id: "espn-copy",
      sportKey: "soccer",
      competitionKey: "eng.1",
      competitionLabel: "Premier League",
      url: "https://example.com/story?id=1#league",
      origin: "espn",
      publisherLabel: "ESPN",
      publisherDomain: "espn.com",
      sourceTeamIds: []
    });
    const leagueOnlyStory = headline({
      id: "league-only",
      sportKey: "soccer",
      competitionKey: "eng.1",
      competitionLabel: "Premier League",
      url: "https://example.com/league-only",
      origin: "espn",
      publisherLabel: "ESPN",
      publisherDomain: "espn.com",
      sourceTeamIds: []
    });

    const groups = composeSportsNewsGroups(
      new Map([["soccer", [sportStory]]]),
      new Map([["eng.1", [duplicateEspnStory, leagueOnlyStory]]]),
      ["eng.1"]
    );

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      kind: "sport",
      sportKey: "soccer",
      competitionKey: null,
      competitionLabel: "Soccer",
      headlines: [{ id: "story" }]
    });
    expect(groups.flatMap((group) => group.headlines).map((item) => item.id)).toEqual([
      "story",
      "league-only"
    ]);
  });
});
