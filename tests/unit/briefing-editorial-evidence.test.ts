import { describe, expect, it } from "vitest";

import {
  isNewsBriefingEvidence,
  isSportsBriefingEvidence,
  NEWS_EVIDENCE_STORIES_MAX,
  NEWS_EVIDENCE_SUMMARY_MAX,
  SPORTS_EVIDENCE_GAMES_MAX,
  SPORTS_EVIDENCE_STORIES_TOTAL_MAX,
  type NewsBriefingEvidenceV1,
  type SportsBriefingEvidenceV1
} from "@moss/shared";
import {
  composeSportsBriefingEvidence,
  deriveGamePhase,
  deriveSportsState
} from "../../packages/sports/src/briefing-evidence.js";
import { projectNewsBriefingEvidence } from "../../packages/news/src/briefing-evidence.js";
import type { GameSummary } from "@moss/shared";

function game(overrides: Partial<GameSummary> = {}): GameSummary {
  return {
    id: "g1",
    competitionKey: "nfl",
    startsAt: "2026-07-01T20:00:00.000Z",
    state: "pre",
    statusDetail: "7:20 PM",
    home: {
      teamKey: "dal",
      sourceTeamId: "6",
      name: "Dallas Cowboys",
      shortName: "DAL",
      crestUrl: null,
      score: null,
      record: null,
      winner: false,
      scorers: null
    },
    away: {
      teamKey: "min",
      sourceTeamId: "min",
      name: "Minnesota Vikings",
      shortName: "MIN",
      crestUrl: null,
      score: null,
      record: null,
      winner: false,
      scorers: null
    },
    ...overrides
  };
}

const NOW = new Date("2026-07-01T18:00:00.000Z");

describe("sports game phases from actor-local instants", () => {
  it("marks a finished game final and a live game live", () => {
    expect(deriveGamePhase(game({ state: "final", statusDetail: "Final" }), NOW, "UTC")).toBe(
      "final"
    );
    expect(deriveGamePhase(game({ state: "live", statusDetail: "Q3" }), NOW, "UTC")).toBe("live");
  });

  it("marks a later-today game tonight in the actor zone but upcoming elsewhere", () => {
    const evening = game({ state: "pre", startsAt: "2026-07-01T23:00:00.000Z" });
    expect(deriveGamePhase(evening, NOW, "America/New_York")).toBe("tonight");
    expect(deriveGamePhase(evening, new Date("2026-07-02T04:00:00.000Z"), "America/New_York")).toBe(
      "upcoming"
    );
  });

  it("treats a game ending after local midnight as final, not tonight", () => {
    const late = game({
      state: "final",
      statusDetail: "Final",
      startsAt: "2026-07-01T02:10:00.000Z"
    });
    expect(deriveGamePhase(late, new Date("2026-07-01T05:00:00.000Z"), "America/New_York")).toBe(
      "final"
    );
  });

  it("marks postponed and cancelled status text postponed", () => {
    expect(deriveGamePhase(game({ statusDetail: "Postponed" }), NOW, "UTC")).toBe("postponed");
    expect(deriveGamePhase(game({ statusDetail: "Cancelled" }), NOW, "UTC")).toBe("postponed");
  });
});

describe("sports section states", () => {
  it("prefers live over tonight over finals, quiet on an empty answered board", () => {
    expect(deriveSportsState(["final", "tonight", "live"], false, false)).toBe("live");
    expect(deriveSportsState(["final", "tonight"], false, false)).toBe("tonight");
    expect(deriveSportsState(["final"], false, false)).toBe("finals");
    expect(deriveSportsState([], false, true)).toBe("quiet");
  });

  it("is unknown on any provider miss without live/tonight/finals", () => {
    expect(deriveSportsState([], true, true)).toBe("unknown");
    expect(deriveSportsState(["upcoming"], true, false)).toBe("unknown");
  });
});

describe("sports evidence composition", () => {
  it("an ambiguous follow yields no game, story or fact and is counted", () => {
    const { facts, evidence } = composeSportsBriefingEvidence({
      follows: [
        {
          id: "f1",
          competitionKey: "nfl",
          teamKey: "PAC",
          sourceTeamId: null,
          createdAt: "2026-06-01T00:00:00.000Z"
        }
      ],
      teamsByComp: new Map([
        [
          "nfl",
          [
            {
              teamKey: "pac",
              competitionKey: "nfl",
              name: "Pacific Tigers",
              shortName: "PAC",
              crestUrl: null,
              sourceTeamId: "413",
              abbreviation: "PAC"
            },
            {
              teamKey: "pac.414",
              competitionKey: "nfl",
              name: "Pacific Lutheran",
              shortName: "PAC",
              crestUrl: null,
              sourceTeamId: "414",
              abbreviation: "PAC"
            }
          ]
        ]
      ]),
      scoreboardByComp: new Map([["nfl", [game()]]]),
      headlinesByComp: new Map(),
      now: NOW,
      timeZone: "UTC",
      degraded: false,
      capturedAt: NOW.toISOString()
    });
    expect(facts).toEqual([]);
    expect(evidence.ambiguousFollowCount).toBe(1);
    expect(evidence.games).toEqual([]);
    expect(evidence.stories).toEqual([]);
  });

  it("uses the default slate boards when nothing is followed", () => {
    const { facts, evidence } = composeSportsBriefingEvidence({
      follows: [],
      teamsByComp: new Map(),
      scoreboardByComp: new Map([
        ["nfl", [game()]],
        ["nba", []]
      ]),
      headlinesByComp: new Map(),
      now: NOW,
      timeZone: "UTC",
      degraded: false,
      capturedAt: NOW.toISOString()
    });
    expect(evidence.games).toHaveLength(1);
    expect(facts.length).toBeGreaterThan(0);
    expect(evidence.ambiguousFollowCount).toBe(0);
  });

  it("a partial miss with an empty answered board is degraded unknown, never quiet", () => {
    const { evidence } = composeSportsBriefingEvidence({
      follows: [
        {
          id: "f1",
          competitionKey: "nfl",
          teamKey: "dal",
          sourceTeamId: "6",
          createdAt: "2026-06-01T00:00:00.000Z"
        }
      ],
      teamsByComp: new Map([
        [
          "nfl",
          [
            {
              teamKey: "dal",
              competitionKey: "nfl",
              name: "Dallas Cowboys",
              shortName: "DAL",
              crestUrl: null,
              sourceTeamId: "6",
              abbreviation: "DAL"
            }
          ]
        ]
      ]),
      scoreboardByComp: new Map([["nfl", []]]),
      headlinesByComp: new Map(),
      now: NOW,
      timeZone: "UTC",
      degraded: true,
      capturedAt: NOW.toISOString()
    });
    expect(evidence.degraded).toBe(true);
    expect(evidence.state).toBe("unknown");
  });

  it("a provider miss is degraded unknown, never quiet", () => {
    const { evidence } = composeSportsBriefingEvidence({
      follows: [],
      teamsByComp: new Map(),
      scoreboardByComp: new Map(),
      headlinesByComp: new Map(),
      now: NOW,
      timeZone: "UTC",
      degraded: true,
      capturedAt: NOW.toISOString()
    });
    expect(evidence.degraded).toBe(true);
    expect(evidence.state).toBe("unknown");
  });

  it("caps games at 8 and stories at 6 total", () => {
    const boards = new Map([["nfl", Array.from({ length: 12 }, (_, i) => game({ id: `g${i}` }))]]);
    const { evidence } = composeSportsBriefingEvidence({
      follows: [],
      teamsByComp: new Map(),
      scoreboardByComp: boards,
      headlinesByComp: new Map(),
      now: NOW,
      timeZone: "UTC",
      degraded: false,
      capturedAt: NOW.toISOString()
    });
    expect(evidence.games.length).toBeLessThanOrEqual(SPORTS_EVIDENCE_GAMES_MAX);
  });
});

describe("evidence validators", () => {
  const sports: SportsBriefingEvidenceV1 = {
    version: 1,
    capturedAt: NOW.toISOString(),
    degraded: false,
    state: "tonight",
    ambiguousFollowCount: 0,
    games: [
      {
        id: "g1",
        competitionKey: "nfl",
        startsAt: NOW.toISOString(),
        phase: "tonight",
        statusDetail: "7:20 PM",
        headline: "MIN at DAL",
        homeShort: "DAL",
        awayShort: "MIN",
        homeScore: null,
        awayScore: null
      }
    ],
    stories: []
  };

  const news: NewsBriefingEvidenceV1 = {
    version: 1,
    capturedAt: NOW.toISOString(),
    degraded: false,
    stories: [
      {
        id: "s1",
        title: "Title",
        sourceLabel: "Wire",
        sourceKey: "wire",
        url: "https://example.com/s1",
        publishedAt: NOW.toISOString(),
        summary: "summary",
        imageUrl: null
      }
    ]
  };

  it("accepts the canonical shapes", () => {
    expect(isSportsBriefingEvidence(sports)).toBe(true);
    expect(isNewsBriefingEvidence(news)).toBe(true);
  });

  it("rejects oversize and malformed blocks", () => {
    expect(
      isSportsBriefingEvidence({
        ...sports,
        games: Array.from({ length: SPORTS_EVIDENCE_GAMES_MAX + 1 }, () => sports.games[0])
      })
    ).toBe(false);
    expect(
      isSportsBriefingEvidence({
        ...sports,
        stories: Array.from({ length: SPORTS_EVIDENCE_STORIES_TOTAL_MAX + 1 }, () => ({
          teamKey: null,
          competitionKey: "nfl",
          title: "t",
          url: "https://example.com/x",
          publishedAt: NOW.toISOString(),
          imageUrl: null,
          publisherLabel: "p",
          publisherDomain: "example.com"
        }))
      })
    ).toBe(false);
    expect(isNewsBriefingEvidence({ ...news, version: 2 })).toBe(false);
    expect(
      isNewsBriefingEvidence({
        ...news,
        stories: Array.from({ length: NEWS_EVIDENCE_STORIES_MAX + 1 }, () => news.stories[0])
      })
    ).toBe(false);
    expect(
      isNewsBriefingEvidence({
        ...news,
        stories: [{ ...news.stories[0], summary: "x".repeat(NEWS_EVIDENCE_SUMMARY_MAX + 1) }]
      })
    ).toBe(false);
    expect(
      isNewsBriefingEvidence({
        ...news,
        stories: [{ ...news.stories[0], url: "javascript:alert(1)" }]
      })
    ).toBe(false);
  });
});

describe("news evidence projection", () => {
  it("caps stories at 5 with summaries at 240 characters and passes image references through", () => {
    const headlines = Array.from({ length: 8 }, (_, i) => ({
      id: `s${i}`,
      sourceKey: "wire",
      sourceLabel: "Wire",
      topicKey: null,
      topicLabel: null,
      title: `Title ${i}`,
      url: `https://example.com/${i}`,
      publishedAt: NOW.toISOString(),
      imageUrl: i === 0 ? "/api/news/images/s0" : null,
      faviconUrl: null,
      summary: "x".repeat(500)
    }));
    const evidence = projectNewsBriefingEvidence(headlines, NOW.toISOString(), false);
    expect(evidence.stories).toHaveLength(5);
    for (const story of evidence.stories) {
      expect(story.summary.length).toBeLessThanOrEqual(240);
    }
    expect(evidence.stories[0]?.imageUrl).toBe("/api/news/images/s0");
    expect(isNewsBriefingEvidence(evidence)).toBe(true);
  });
});
