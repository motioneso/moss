// @vitest-environment jsdom
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToString } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GameSide, GameSummary, Headline, SportsOverviewResponse } from "@moss/shared";
import { SportsTodayWidget } from "../../packages/sports/src/web/today-widget.js";
import { sportsQueryKeys } from "../../packages/sports/src/web/query-keys.js";
import { hasLiveGame } from "../../packages/sports/src/web/sports-page.js";
import { QUIET_NIGHT_LINE } from "../../packages/sports/src/web/today-scores.js";
import { formatDate } from "../../packages/sports/src/web/locale.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// 18:00 Eastern on July 7 — tonight's games are later the same local evening.
const NOW = new Date("2026-07-07T22:00:00.000Z");
const ZONE = "America/New_York";

function side(overrides: Partial<GameSide> = {}): GameSide {
  return {
    teamKey: "min",
    sourceTeamId: "1",
    name: "Minnesota Vikings",
    shortName: "MIN",
    crestUrl: null,
    score: null,
    record: null,
    winner: false,
    scorers: null,
    ...overrides
  };
}

function vikingSide(score: number | null): GameSide {
  return side({ score });
}

function cowboySide(score: number | null, sourceTeamId = "6"): GameSide {
  return side({
    teamKey: "dal",
    sourceTeamId,
    name: "Dallas Cowboys",
    shortName: "DAL",
    score
  });
}

function game(overrides: Partial<GameSummary> = {}): GameSummary {
  return {
    id: "game-1",
    competitionKey: "nfl",
    startsAt: "2026-07-06T17:00:00.000Z",
    state: "final",
    statusDetail: "Final",
    home: vikingSide(21),
    away: cowboySide(14),
    ...overrides
  };
}

function story(index: number): Headline {
  return {
    id: `sp-today-${index}`,
    sportKey: "football",
    competitionKey: "nfl",
    competitionLabel: "NFL",
    title: `Sports today story ${index}`,
    url: `https://example.com/sports/${index}`,
    publishedAt: "2026-07-07T12:00:00.000Z",
    imageUrl: index === 1 ? "https://example.com/lead.jpg" : null,
    imageWidth: null,
    imageHeight: null,
    summary: "A sports summary.",
    teamKeys: [],
    publisherLabel: "ESPN",
    publisherDomain: "espn.com",
    storyRef: `sports:today-${index}`
  };
}

function overview(overrides: Partial<SportsOverviewResponse> = {}): SportsOverviewResponse {
  return {
    hero: { mode: "story", headline: null },
    followed: [],
    scoreboard: [],
    topStories: [],
    leagueNews: [],
    standings: [],
    followedTeams: [],
    followedLeagues: [],
    followedLeagueCards: [],
    ambiguousFollows: [],
    degraded: false,
    ...overrides
  };
}

function seed(data: SportsOverviewResponse): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(sportsQueryKeys.overview, data);
  // Fixed actor zone: Tonight assertions must not depend on the machine running the test.
  client.setQueryData(["settings", "locale"], {
    locale: { timezone: ZONE, region: "en-US", dateFormat: "12" }
  });
  return client;
}

function render(client: QueryClient): string {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  try {
    return renderToString(
      createElement(QueryClientProvider, { client }, createElement(SportsTodayWidget))
    );
  } finally {
    vi.useRealTimers();
  }
}

function rowCount(html: string): number {
  return html.match(/sp-scores__row/g)?.length ?? 0;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Sports Today scores", () => {
  it("renders the score status above its one-line recap", () => {
    const data = overview({
      scoreboard: [
        {
          competitionKey: "nfl",
          competitionLabel: "NFL",
          games: [game({ recap: "A seventh-inning comeback" })]
        }
      ]
    });
    const html = render(seed(data));

    expect(html).toContain("Final");
    expect(html).toContain("A seventh-inning comeback");
    expect(html.indexOf("Final")).toBeLessThan(html.indexOf("A seventh-inning comeback"));
  });

  it("renders score rows with the followed team's game first", () => {
    const followedFinal = game({
      id: "followed-final",
      startsAt: "2026-07-06T17:00:00.000Z",
      statusDetail: "Final"
    });
    const otherFinal = game({
      id: "other-final",
      startsAt: "2026-07-07T19:00:00.000Z",
      statusDetail: "Final",
      home: cowboySide(28, "6"),
      away: side({
        teamKey: "phi",
        sourceTeamId: "7",
        name: "Philadelphia Eagles",
        shortName: "PHI",
        score: 24
      })
    });
    const data = overview({
      scoreboard: [
        { competitionKey: "nfl", competitionLabel: "NFL", games: [otherFinal, followedFinal] }
      ],
      followedTeams: [{ competitionKey: "nfl", teamKey: "min", sourceTeamId: "1" }]
    });
    const html = render(seed(data));

    expect(html).toContain("Your followed teams");
    expect(html).toContain("Elsewhere worth a look");
    // Followed group reads before the elsewhere group even though its game is older.
    expect(html.indexOf("Your followed teams")).toBeLessThan(
      html.indexOf("Elsewhere worth a look")
    );
    expect(html).toContain("NFL");
    expect(html).toContain("Final");
    expect(html).not.toContain("nfl ·");
    expect(rowCount(html)).toBe(2);
  });

  it("never marks a team followed on teamKey alone", () => {
    const impostor = game({
      id: "impostor-final",
      home: side({ sourceTeamId: "999", score: 30 }),
      away: cowboySide(27)
    });
    const data = overview({
      scoreboard: [{ competitionKey: "nfl", competitionLabel: "NFL", games: [impostor] }],
      // The follow is for team id "1"; this game's home side shares only the short key.
      followedTeams: [{ competitionKey: "nfl", teamKey: "min", sourceTeamId: "1" }]
    });
    const html = render(seed(data));

    expect(html).not.toContain("Your followed teams");
    expect(html).toContain("Elsewhere worth a look");
    expect(html).not.toContain("sp-board__side--you");
  });

  it("caps the elsewhere group at four and reads live first", () => {
    const games = Array.from({ length: 6 }, (_, index) =>
      game({
        id: `other-${index}`,
        startsAt: `2026-07-0${6 - (index % 2)}T17:00:00.000Z`,
        state: index === 5 ? "live" : "final",
        statusDetail: index === 5 ? "Q3 4:12" : "Final",
        home: cowboySide(20 + index, `${100 + index}`),
        away: side({
          teamKey: "phi",
          sourceTeamId: `${200 + index}`,
          name: "Philadelphia Eagles",
          shortName: "PHI",
          score: 17
        })
      })
    );
    const data = overview({
      scoreboard: [{ competitionKey: "nfl", competitionLabel: "NFL", games }]
    });
    const html = render(seed(data));

    expect(rowCount(html)).toBe(4);
    expect(html).toContain("Q3 4:12");
  });

  it("renders each hero game missing from the scoreboard exactly once", () => {
    const onlyInHero = game({ id: "hero-only", statusDetail: "Final" });
    const data = overview({
      hero: {
        mode: "gameday",
        games: [{ game: onlyInHero, competitionLabel: "NFL", rationale: "You follow them" }]
      },
      scoreboard: [
        {
          competitionKey: "nfl",
          competitionLabel: "NFL",
          games: [onlyInHero, game({ id: "board-only", statusDetail: "Final" })]
        }
      ],
      followedTeams: [{ competitionKey: "nfl", teamKey: "min", sourceTeamId: "1" }]
    });
    const html = render(seed(data));

    expect(rowCount(html)).toBe(2);
  });

  it("marks the live row and keeps polling tied to a live game", () => {
    const live = game({
      id: "live-game",
      state: "live",
      statusDetail: "Q3 4:12",
      home: vikingSide(21),
      away: cowboySide(14)
    });
    const data = overview({
      scoreboard: [{ competitionKey: "nfl", competitionLabel: "NFL", games: [live] }]
    });
    const html = render(seed(data));

    expect(html).toContain("sp-livedot");
    expect(hasLiveGame(data)).toBe(true);
    expect(hasLiveGame(overview())).toBe(false);
  });
});

describe("Sports Today Tonight", () => {
  it("renders three fixture cards with their notes", () => {
    const fixtures = ["Home", "Away", "Series opener"].map((note, index) =>
      game({
        id: `tonight-${index}`,
        state: "pre",
        statusDetail: "Scheduled",
        recap: index === 0 ? null : note,
        startsAt: `2026-07-07T23:${30 + index * 10}:00.000Z`,
        home: index === 0 ? vikingSide(null) : cowboySide(null),
        away: cowboySide(null)
      })
    );
    const data = overview({
      scoreboard: [{ competitionKey: "nfl", competitionLabel: "NFL", games: fixtures }],
      followedTeams: [{ competitionKey: "nfl", teamKey: "min", sourceTeamId: "1" }]
    });
    const html = render(seed(data));

    expect(html.match(/sp-tonight__row/g)).toHaveLength(3);
    expect(html).toContain("Home");
    expect(html).toContain("Away");
    expect(html).toContain("Series opener");
  });

  it("renders a Tonight row with the local start time", () => {
    const tonight = game({
      id: "tonight-game",
      state: "pre",
      statusDetail: "7:30 PM",
      startsAt: "2026-07-07T23:30:00.000Z",
      home: vikingSide(null),
      away: cowboySide(null)
    });
    // Past local midnight: the same wall-clock game is tomorrow for this actor, not tonight.
    const afterMidnight = game({
      id: "after-midnight",
      state: "pre",
      statusDetail: "1:00 AM",
      startsAt: "2026-07-08T05:00:00.000Z",
      home: vikingSide(null),
      away: cowboySide(null)
    });
    const data = overview({
      scoreboard: [
        { competitionKey: "nfl", competitionLabel: "NFL", games: [tonight, afterMidnight] }
      ],
      followedTeams: [{ competitionKey: "nfl", teamKey: "min", sourceTeamId: "1" }]
    });
    const html = render(seed(data));

    expect(html).toContain("Tonight");
    expect(html).toContain("DAL at MIN");
    expect(html).toContain("7:30 PM");
    expect(html).toContain("Following");
    expect(html).not.toContain("1:00 AM");
  });

  it("shows a postponed today-game as Postponed and never as a final", () => {
    const postponed = game({
      id: "postponed-game",
      state: "pre",
      statusDetail: "Postponed — rain",
      startsAt: "2026-07-07T23:30:00.000Z",
      home: cowboySide(null),
      away: side({
        teamKey: "phi",
        sourceTeamId: "7",
        name: "Philadelphia Eagles",
        shortName: "PHI",
        score: null
      })
    });
    const data = overview({
      scoreboard: [{ competitionKey: "nfl", competitionLabel: "NFL", games: [postponed] }]
    });
    const html = render(seed(data));

    expect(html).toContain("Tonight");
    expect(html).toContain("Postponed");
    expect(rowCount(html)).toBe(0);
    expect(html).not.toContain("Scores");
  });

  it("shows the quiet-night line when the band is empty but the desk renders", () => {
    const data = overview({ topStories: [story(1)] });
    const html = render(seed(data));

    expect(html).toContain("Tonight");
    expect(html).toContain(QUIET_NIGHT_LINE);
  });

  it("uses an existing followed-card story for the recap when top stories are empty", () => {
    const data = overview({
      followed: [
        {
          teamKey: "ars",
          competitionKey: "eng.1",
          competitionLabel: "Premier League",
          name: "Arsenal",
          crestUrl: null,
          status: "news",
          primary: "Arsenal story",
          stories: [
            {
              title: "Arsenal seal late win to stay top of the pile",
              url: "https://example.com/arsenal-story",
              publishedAt: "2026-07-07T12:00:00.000Z",
              imageUrl: "https://example.com/lead.jpg",
              publisherLabel: "ESPN",
              publisherDomain: "espn.com",
              storyRef: "sports:arsenal-story"
            }
          ],
          form: [],
          standing: null,
          nextMatch: null,
          lastMatchAt: null,
          rationale: ""
        }
      ]
    });
    const html = render(seed(data));

    expect(html).toContain('class="sp-lead__photo"');
    expect(html).toContain("Arsenal seal late win to stay top of the pile");
  });

  it("renders nothing when scores, tonight, stories and cards are all empty", () => {
    expect(render(seed(overview()))).toBe("");
  });
});

describe("Sports Today editorial desk", () => {
  it("renders the lead kicker, dek and story-behind-the-score link", () => {
    const html = render(seed(overview({ topStories: [story(1)] })));

    expect(html).toContain("★ FOLLOWING /");
    expect(html).toContain("NFL");
    expect(html).toContain("A sports summary.");
    expect(html).toContain("The story behind the score ↗");
    expect(html).toContain('href="https://example.com/sports/1"');
  });

  it("renders the desk head with lead, scores, Tonight, cards blocks", () => {
    const final = game({ id: "desk-final", startsAt: "2026-07-06T17:00:00.000Z" });
    const tonight = game({
      id: "desk-tonight",
      state: "pre",
      statusDetail: "7:30 PM",
      startsAt: "2026-07-07T23:30:00.000Z",
      home: vikingSide(null),
      away: cowboySide(null)
    });
    const data = overview({
      scoreboard: [{ competitionKey: "nfl", competitionLabel: "NFL", games: [final, tonight] }],
      followedTeams: [{ competitionKey: "nfl", teamKey: "min", sourceTeamId: "1" }],
      topStories: [story(1), story(2)]
    });
    const html = render(seed(data));

    expect(html).toContain("jds-brief--sports");
    expect(html).toContain("03");
    expect(html).toContain("From the sidelines");
    const scoresAt = html.indexOf("Scores");
    const storiesAt = html.indexOf("Top stories");
    const tonightAt = html.indexOf(">Tonight<");
    expect(scoresAt).toBeGreaterThan(-1);
    expect(storiesAt).toBeGreaterThan(-1);
    expect(scoresAt).toBeLessThan(storiesAt);
    expect(tonightAt).toBeGreaterThan(storiesAt);
  });

  it("renders the Tonight date label beside the band heading", () => {
    const tonight = game({
      id: "tonight-label",
      state: "pre",
      statusDetail: "7:30 PM",
      startsAt: "2026-07-07T23:30:00.000Z",
      home: vikingSide(null),
      away: cowboySide(null)
    });
    const html = render(
      seed(
        overview({
          scoreboard: [{ competitionKey: "nfl", competitionLabel: "NFL", games: [tonight] }]
        })
      )
    );
    const testLocale = { timezone: ZONE, region: "en-US", dateFormat: "12" as const };
    expect(html).toContain("desk-tonight__head");
    expect(html).toContain(
      formatDate(new Date(NOW), testLocale, { weekday: "long", month: "long", day: "numeric" })
    );
    // July in America/New_York is EDT; the label carries the short zone name, not a date repeat.
    expect(html).toContain("EDT");
  });
});

describe("Sports Today desk behaviour", () => {
  it("keeps league-card story anchors free of undefined publisher text", () => {
    const sharedStory = {
      title: "Arsenal seal late win to stay top of the pile",
      url: "https://example.com/story-9001",
      publishedAt: "2026-07-07T12:00:00.000Z",
      imageUrl: null,
      storyRef: "sports:story-9001"
    };
    const data = overview({
      followed: [
        {
          teamKey: "ars",
          competitionKey: "eng.1",
          competitionLabel: "Premier League",
          name: "Arsenal",
          crestUrl: null,
          status: "news",
          primary: "Arsenal story",
          stories: [{ ...sharedStory, publisherLabel: "", publisherDomain: "" }],
          form: [],
          standing: null,
          nextMatch: null,
          lastMatchAt: null,
          rationale: ""
        }
      ],
      followedLeagueCards: [
        {
          competitionKey: "eng.1",
          competitionLabel: "Premier League",
          kind: "league",
          status: "news",
          logoUrl: null,
          // This is the pre-schema-fix R2 wire shape: absent publisher fields must not leak into UI.
          stories: [sharedStory],
          results: []
        }
      ] as unknown as SportsOverviewResponse["followedLeagueCards"]
    });
    const html = render(seed(data));
    const links = [
      ...html.matchAll(/<a class="sp-tk__(?:newstx|storylink)"[^>]*>([^<]*)<\/a>/g)
    ].map((match) => match[1]);

    expect(links).toHaveLength(2);
    expect(new Set(links)).toEqual(new Set([sharedStory.title]));
    expect(html).not.toContain("undefined");
    expect(html).toContain("Following 1 team and 1 league");
  });

  it("uses the shared overview query", () => {
    const data = overview({ topStories: [story(1)] });
    const client = seed(data);
    render(client);

    expect(client.getQueryData(sportsQueryKeys.overview)).toBe(data);
  });

  it("drops a lead photo that fails to load and keeps the story", async () => {
    const data = overview({ topStories: [story(1), story(2)] });
    const client = seed(data);
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        createElement(QueryClientProvider, { client }, createElement(SportsTodayWidget))
      );
    });

    const imagesBefore = renderer!.root.findAllByProps({ src: "https://example.com/lead.jpg" });
    expect(imagesBefore.length).toBe(1);
    await act(async () => {
      imagesBefore[0]!.props.onError();
    });

    expect(renderer!.root.findAllByProps({ src: "https://example.com/lead.jpg" }).length).toBe(0);
    expect(renderer!.root.findAllByProps({ children: "Sports today story 1" }).length).toBe(1);
  });

  it("hides a story on less-like-this feedback", async () => {
    const data = overview({ topStories: [story(1), story(2)] });
    const client = seed(data);
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        createElement(QueryClientProvider, { client }, createElement(SportsTodayWidget))
      );
    });

    const menus = renderer!.root.findAllByProps({ storyRef: "sports:today-1" });
    expect(menus.length).toBeGreaterThan(0);
    await act(async () => {
      menus[0]!.props.onChanged("sports:today-1", "less_like_this");
    });

    expect(renderer!.root.findAllByProps({ children: "Sports today story 1" }).length).toBe(0);
    expect(renderer!.root.findAllByProps({ children: "Sports today story 2" }).length).toBe(1);
  });
});
