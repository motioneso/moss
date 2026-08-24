import { describe, expect, it } from "vitest";

import type { SportsFollowDto } from "@moss/shared";

import type { SourceHeadline } from "../../packages/sports/src/source/sports-source.js";
import { mergeHeadlineScope } from "../../packages/sports/src/headline-composition.js";
import { SportsService } from "../../packages/sports/src/sports-service.js";
import { makeDeps, makeSource, TODAY, userA } from "./sports-service.test.js";

// Split out of sports-service.test.ts (#858) to stay under the check:file-size 1000-line cap —
// these tests share that file's makeDeps/makeSource/userA/TODAY fixtures rather than duplicating
// them.
describe("id→url story keying (#858)", () => {
  it("keeps the chosen ESPN identity while unioning trusted custom assignment scope", () => {
    const espn: SourceHeadline = {
      id: "espn-story",
      competitionKey: "nfl",
      competitionLabel: "NFL",
      title: "Shared story",
      url: "https://publisher.example/shared",
      publishedAt: `${TODAY}T10:00:00.000Z`,
      imageUrl: null,
      summary: "",
      teamKeys: [],
      origin: "espn",
      publisherLabel: "ESPN",
      publisherDomain: "espn.com",
      sourceTeamIds: []
    };

    expect(
      mergeHeadlineScope([espn], {
        ...espn,
        id: "custom-story",
        origin: "custom",
        sourceId: "source-1",
        teamKeys: ["dal"],
        publisherLabel: "Publisher",
        publisherDomain: "publisher.example"
      })
    ).toEqual([{ ...espn, teamKeys: ["dal"] }]);
  });

  it("does not drop a distinct same-id story from leagueNews just because a different story with the same id became a top story", async () => {
    const nflLeagueFollow: SportsFollowDto = {
      id: "f1",
      competitionKey: "nfl",
      teamKey: null,
      createdAt: "2026-06-01T00:00:00.000Z"
    };
    const h0: SourceHeadline = {
      id: "dup",
      competitionKey: "nfl",
      competitionLabel: "NFL",
      title: "Editorial lead (becomes the top story)",
      url: "https://example.com/dup-a",
      publishedAt: `${TODAY}T10:00:00.000Z`,
      imageUrl: null,
      summary: "",
      teamKeys: [],
      origin: "espn",
      publisherLabel: "ESPN",
      publisherDomain: "espn.com",
      sourceTeamIds: []
    };
    const h1: SourceHeadline = {
      id: "dup",
      competitionKey: "nfl",
      competitionLabel: "NFL",
      title: "Distinct story, colliding id",
      url: "https://example.com/dup-b",
      publishedAt: `${TODAY}T11:00:00.000Z`,
      imageUrl: null,
      summary: "",
      teamKeys: [],
      origin: "espn",
      publisherLabel: "ESPN",
      publisherDomain: "espn.com",
      sourceTeamIds: []
    };
    const service = new SportsService(
      makeDeps({
        follows: [nflLeagueFollow],
        source: makeSource({
          getHeadlines: async (competitionKey) => (competitionKey === "nfl" ? [h0, h1] : [])
        })
      })
    );
    const overview = await service.getOverview(userA);
    expect(overview.topStories.map((h) => h.url)).toContain("https://example.com/dup-a");
    const nflGroup = overview.leagueNews.find((g) => g.competitionKey === "nfl");
    expect(nflGroup?.headlines.map((h) => h.title)).toEqual(["Distinct story, colliding id"]);
  });

  it("does not splice the featured article's body onto an unrelated headline that happens to share its id", async () => {
    const nflFollow: SportsFollowDto = {
      id: "f1",
      competitionKey: "nfl",
      teamKey: null,
      createdAt: "2026-06-01T00:00:00.000Z"
    };
    const nbaFollow: SportsFollowDto = {
      id: "f2",
      competitionKey: "nba",
      teamKey: null,
      createdAt: "2026-06-01T00:00:00.000Z"
    };
    // nfl feed: an editorial lead (tier-1 top story, excluded from leagueNews) followed by the
    // heavy story that will become the feature — image + summary + first-in-its-(filtered)-group
    // bonus clears BIG_STORY_WEIGHT (4): 2 + 1 + 2 = 5.
    const nflLead: SourceHeadline = {
      id: "nfl-lead",
      competitionKey: "nfl",
      competitionLabel: "NFL",
      title: "NFL editorial lead",
      url: "https://example.com/nfl-lead",
      publishedAt: `${TODAY}T09:00:00.000Z`,
      imageUrl: null,
      summary: "",
      teamKeys: [],
      origin: "espn",
      publisherLabel: "ESPN",
      publisherDomain: "espn.com",
      sourceTeamIds: []
    };
    const nflFeature: SourceHeadline = {
      id: "dup",
      competitionKey: "nfl",
      competitionLabel: "NFL",
      title: "NFL feature story",
      url: "https://example.com/nfl-dup",
      publishedAt: `${TODAY}T10:00:00.000Z`,
      imageUrl: "https://img.example.com/nfl.jpg",
      summary: "NFL summary text",
      teamKeys: [],
      origin: "espn",
      publisherLabel: "ESPN",
      publisherDomain: "espn.com",
      sourceTeamIds: []
    };
    // nba feed: its own editorial lead (tier-1 top story, excluded), then a second, unrelated
    // story that happens to share `nflFeature`'s id "dup" but has a completely different url.
    const nbaLead: SourceHeadline = {
      id: "nba-lead",
      competitionKey: "nba",
      competitionLabel: "NBA",
      title: "NBA editorial lead",
      url: "https://example.com/nba-lead",
      publishedAt: `${TODAY}T08:00:00.000Z`,
      imageUrl: null,
      summary: "",
      teamKeys: [],
      origin: "espn",
      publisherLabel: "ESPN",
      publisherDomain: "espn.com",
      sourceTeamIds: []
    };
    const nbaOther: SourceHeadline = {
      id: "dup",
      competitionKey: "nba",
      competitionLabel: "NBA",
      title: "NBA distinct story (colliding id)",
      url: "https://example.com/nba-other",
      publishedAt: `${TODAY}T07:00:00.000Z`,
      imageUrl: null,
      summary: "",
      teamKeys: [],
      origin: "espn",
      publisherLabel: "ESPN",
      publisherDomain: "espn.com",
      sourceTeamIds: []
    };
    const service = new SportsService({
      ...makeDeps({
        follows: [nflFollow, nbaFollow],
        source: makeSource({
          getHeadlines: async (competitionKey) => {
            if (competitionKey === "nfl") return [nflLead, nflFeature];
            if (competitionKey === "nba") return [nbaLead, nbaOther];
            return [];
          },
          getArticleBody: async () => "Fetched real article body."
        })
      }),
      publicSourceReader: {
        refresh: async () => ({
          degraded: false,
          persistedResults: 0,
          headlines: [
            {
              id: "custom-shared-url",
              sourceId: "source-1",
              competitionKey: "nba",
              competitionLabel: "NBA",
              title: "Custom story sharing the ESPN feature URL",
              url: nflFeature.url,
              publishedAt: `${TODAY}T06:00:00.000Z`,
              imageUrl: null,
              summary: "Custom summary",
              teamKeys: [],
              origin: "custom",
              publisherLabel: "Publisher",
              publisherDomain: "publisher.example"
            }
          ]
        })
      }
    });
    const overview = await service.getOverview(userA);
    const nflGroup = overview.leagueNews.find((g) => g.competitionKey === "nfl");
    expect(nflGroup?.headlines.find((h) => h.title === "NFL feature story")?.body).toBe(
      "Fetched real article body."
    );
    const nbaGroup = overview.leagueNews.find((g) => g.competitionKey === "nba");
    expect(
      nbaGroup?.headlines.find((h) => h.title === "NBA distinct story (colliding id)")?.body
    ).toBeUndefined();
    expect(nbaGroup?.headlines.find((h) => h.id === "custom-shared-url")?.body).toBeUndefined();
  });

  it("never sends a custom feature id to ESPN when another competition has the same URL", async () => {
    const nbaFollow: SportsFollowDto = {
      id: "f-nba",
      competitionKey: "nba",
      teamKey: null,
      createdAt: "2026-06-01T00:00:00.000Z"
    };
    const nflFollow: SportsFollowDto = {
      id: "f-nfl",
      competitionKey: "nfl",
      teamKey: "dal",
      createdAt: "2026-06-01T00:00:00.000Z"
    };
    const headline = (competitionKey: "nba" | "nfl", id: string, url: string): SourceHeadline => ({
      id,
      competitionKey,
      competitionLabel: competitionKey.toUpperCase(),
      title: id,
      url,
      publishedAt: `${TODAY}T10:00:00.000Z`,
      imageUrl: null,
      summary: "",
      teamKeys: [],
      origin: "espn",
      publisherLabel: "ESPN",
      publisherDomain: "espn.com",
      sourceTeamIds: []
    });
    const sharedUrl = "https://example.com/shared";
    const articleBodyIds: string[] = [];
    const service = new SportsService({
      ...makeDeps({
        follows: [nbaFollow, nflFollow],
        source: makeSource({
          getHeadlines: async (competitionKey) => {
            if (competitionKey === "nba") {
              return [
                headline("nba", "nba-lead", "https://example.com/nba-lead"),
                headline("nba", "espn-same-url", sharedUrl)
              ];
            }
            const fillers = Array.from({ length: 4 }, (_, index) => ({
              ...headline("nfl", `nfl-filler-${index}`, `https://example.com/filler-${index}`),
              sourceTeamIds: ["6"]
            }));
            return [headline("nfl", "nfl-lead", "https://example.com/nfl-lead"), ...fillers];
          },
          listTeams: async (competitionKey) =>
            competitionKey === "nfl"
              ? [
                  {
                    teamKey: "dal",
                    competitionKey,
                    name: "Dallas Cowboys",
                    shortName: "Cowboys",
                    crestUrl: null,
                    sourceTeamId: "6"
                  }
                ]
              : [],
          getArticleBody: async (articleId) => {
            articleBodyIds.push(articleId);
            return "ESPN body";
          }
        })
      }),
      publicSourceReader: {
        refresh: async () => ({
          degraded: false,
          persistedResults: 0,
          headlines: [
            {
              id: "custom-feature",
              sourceId: "source-1",
              competitionKey: "nfl",
              competitionLabel: "NFL",
              title: "Custom feature",
              url: sharedUrl,
              publishedAt: `${TODAY}T11:00:00.000Z`,
              imageUrl: null,
              summary: "Custom summary",
              teamKeys: ["dal"],
              origin: "custom",
              publisherLabel: "Publisher",
              publisherDomain: "publisher.example"
            }
          ]
        })
      }
    });

    const overview = await service.getOverview(userA);

    expect(
      overview.leagueNews
        .find((group) => group.competitionKey === "nfl")
        ?.headlines.find((item) => item.id === "custom-feature")?.body
    ).toBeUndefined();
    expect(articleBodyIds).toEqual([]);
  });

  it("unions team scope when league and team assignments return the same custom URL", async () => {
    const leagueFollow: SportsFollowDto = {
      id: "league-follow",
      competitionKey: "nfl",
      teamKey: null,
      createdAt: "2026-06-01T00:00:00.000Z"
    };
    const teamFollow: SportsFollowDto = {
      id: "team-follow",
      competitionKey: "nfl",
      teamKey: "dal",
      createdAt: "2026-06-02T00:00:00.000Z"
    };
    const sharedUrl = "https://publisher.example/shared-story";
    const common = {
      sourceId: "source-1",
      competitionKey: "nfl",
      competitionLabel: "NFL",
      url: sharedUrl,
      publishedAt: `${TODAY}T11:00:00.000Z`,
      imageUrl: null,
      summary: "",
      origin: "custom" as const,
      publisherLabel: "Publisher",
      publisherDomain: "publisher.example"
    };
    const service = new SportsService({
      ...makeDeps({
        follows: [leagueFollow, teamFollow],
        source: makeSource({
          getScoreboard: async () => [],
          getSchedule: async () => [],
          getStandings: async () => ({ sections: [] }),
          getHeadlines: async () => []
        })
      }),
      publicSourceReader: {
        refresh: async () => ({
          degraded: false,
          persistedResults: 0,
          headlines: [
            { ...common, id: "league-copy", title: "Shared story", teamKeys: [] },
            { ...common, id: "team-copy", title: "Shared story", teamKeys: ["dal"] }
          ]
        })
      }
    });

    const overview = await service.getOverview(userA);
    const card = overview.followed.find((item) => item.teamKey === "dal");

    expect(card?.stories.filter((story) => story.url === sharedUrl)).toHaveLength(1);
    expect(
      overview.leagueNews
        .flatMap((group) => group.headlines)
        .filter((item) => item.url === sharedUrl)
    ).toHaveLength(0);
  });

  it("does not let a tier-1 lead's id block a distinct, team-matched story from tier 2 just because the ids collide", async () => {
    // Regression for rankTopStories' OWN dedup set (pickedIds -> pickedUrls), isolated from the
    // separate, correct followedStoryUrls exclusion (L293-296) that drops a top story already
    // shown on a followed-team card: h1 is tier-2-eligible (feed-rank order, dal-tagged) but aged
    // off the card's newest-3 cap (toTeamStories, followed-card.ts) by h2/h3/h4 below, so it can
    // only reach `overview.topStories` via rankTopStories tier 2 — never via the card path.
    const dalFollow: SportsFollowDto = {
      id: "f1",
      competitionKey: "nfl",
      teamKey: "dal",
      createdAt: "2026-06-01T00:00:00.000Z"
    };
    // h0 is the tier-1 pick (front of feed, unconditional) — not tagged to any team.
    const h0: SourceHeadline = {
      id: "dup",
      competitionKey: "nfl",
      competitionLabel: "NFL",
      title: "Editorial lead",
      url: "https://example.com/a",
      publishedAt: `${TODAY}T06:00:00.000Z`,
      imageUrl: null,
      summary: "",
      teamKeys: [],
      origin: "espn",
      publisherLabel: "ESPN",
      publisherDomain: "espn.com",
      sourceTeamIds: []
    };
    // h1 shares h0's id ("dup") but is a distinct story (different url) tagged to the followed
    // team (sourceTeamIds "6" -> resolves to "dal" via the listTeams override below) — tier 2
    // should pick it up. Oldest of the dal-tagged stories, so the card (newest-first, cap 3)
    // crops it once h2/h3/h4 exist.
    const h1: SourceHeadline = {
      id: "dup",
      competitionKey: "nfl",
      competitionLabel: "NFL",
      title: "Distinct dal story, colliding id",
      url: "https://example.com/b",
      publishedAt: `${TODAY}T07:00:00.000Z`,
      imageUrl: null,
      summary: "",
      teamKeys: [],
      origin: "espn",
      publisherLabel: "ESPN",
      publisherDomain: "espn.com",
      sourceTeamIds: ["6"]
    };
    const dalFiller = (n: number): SourceHeadline => ({
      id: `filler-${n}`,
      competitionKey: "nfl",
      competitionLabel: "NFL",
      title: `Dal filler story ${n}`,
      url: `https://example.com/filler-${n}`,
      publishedAt: `${TODAY}T${10 + n}:00:00.000Z`,
      imageUrl: null,
      summary: "",
      teamKeys: [],
      origin: "espn",
      publisherLabel: "ESPN",
      publisherDomain: "espn.com",
      sourceTeamIds: ["6"]
    });
    const h2 = dalFiller(1);
    const h3 = dalFiller(2);
    const h4 = dalFiller(3);
    const service = new SportsService(
      makeDeps({
        follows: [dalFollow],
        source: makeSource({
          getHeadlines: async (competitionKey, teamKey) => {
            if (competitionKey !== "nfl") return [];
            if (teamKey) return []; // isolate: no per-team feed noise for this test
            return [h0, h1, h2, h3, h4];
          },
          listTeams: async (competitionKey) => [
            {
              teamKey: "dal",
              competitionKey,
              name: "Dallas Cowboys",
              shortName: "Cowboys",
              crestUrl: null,
              sourceTeamId: "6"
            }
          ]
        })
      })
    );
    const overview = await service.getOverview(userA);
    const dalCard = overview.followed.find((c) => c.teamKey === "dal");
    expect(dalCard?.stories.map((s) => s.url)).not.toContain("https://example.com/b");
    expect(overview.topStories.map((h) => h.url)).toContain("https://example.com/b");
  });
});
