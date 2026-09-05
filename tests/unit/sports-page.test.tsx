import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import type {
  FollowedTeamCard,
  GameSummary,
  Headline,
  OverviewHero,
  SportsOverviewResponse,
  StandingsGroup
} from "@moss/shared";

import {
  findFeaturedStory,
  hasLiveGame,
  leadWidePhotoFirst,
  SportsPage
} from "../../packages/sports/src/web/sports-page.js";
import { sportsQueryKeys } from "../../packages/sports/src/web/query-keys.js";

// Root suite renders @moss/web components with react-dom/server (no jsdom /
// @testing-library — deliberately avoided repo-wide; see settings-appearance-pane.test.tsx).
// useQuery reads primed cache synchronously during renderToString, so the resolved
// state is asserted against the SSR HTML string.

function liveGame(): GameSummary {
  return {
    id: "g-live",
    competitionKey: "nfl",
    startsAt: "2026-07-01T23:20:00Z",
    state: "live",
    statusDetail: "Q3 4:12",
    home: {
      teamKey: "min",
      sourceTeamId: "16",
      name: "Minnesota Vikings",
      shortName: "MIN",
      crestUrl: null,
      score: 21,
      record: "10-2",
      winner: true,
      scorers: null
    },
    away: {
      teamKey: "dal",
      sourceTeamId: "6",
      name: "Dallas Cowboys",
      shortName: "DAL",
      crestUrl: null,
      score: 14,
      record: "8-4",
      winner: false,
      scorers: null
    }
  };
}

function followedCard(overrides: Partial<FollowedTeamCard> = {}): FollowedTeamCard {
  return {
    teamKey: "min",
    competitionKey: "nfl",
    competitionLabel: "NFL",
    name: "Minnesota Vikings",
    crestUrl: null,
    status: "live",
    primary: "MIN 21 – 14 DAL",
    stories: [],
    form: ["W", "W", "L"],
    standing: "1st · NFC North",
    nextMatch: {
      opponentName: "Green Bay Packers",
      homeAway: "home",
      startsAt: "2026-07-05T20:00:00.000Z"
    },
    lastMatchAt: "2026-06-29T20:00:00.000Z",
    rationale: "Playing right now",
    ...overrides
  };
}

function standingsGroup(): StandingsGroup {
  return {
    competitionKey: "eng.1",
    competitionLabel: "Premier League",
    standingsShape: "record",
    sections: [
      {
        label: null,
        rows: [
          {
            teamKey: "ars",
            sourceTeamId: "359",
            name: "Arsenal",
            rank: 1,
            points: 40,
            wins: 12,
            losses: 2,
            draws: 4,
            winPercent: null,
            qualifies: true,
            qualificationNote: null,
            qualificationColor: null
          }
        ]
      }
    ]
  };
}

const TEST_COMPETITION_LABELS: Record<string, string> = {
  nfl: "NFL",
  nba: "NBA",
  epl: "Premier League",
  "eng.1": "Premier League"
};

function headline(
  id: string,
  competitionKey: string,
  title: string,
  overrides: Partial<Headline> = {}
): Headline {
  return {
    id,
    sportKey: "football",
    competitionKey,
    competitionLabel: TEST_COMPETITION_LABELS[competitionKey] ?? competitionKey.toUpperCase(),
    title,
    url: "https://example.test/" + id,
    publishedAt: "2026-07-01T18:00:00Z",
    imageUrl: null,
    imageWidth: null,
    imageHeight: null,
    summary: "",
    teamKeys: [],
    publisherLabel: "ESPN",
    publisherDomain: "espn.com",
    ...overrides
  };
}

// The hero carries every followed game in the window, not just the lead one (#1386), so each
// fixture spells out its slides.
function gamedayHero(...games: GameSummary[]): Extract<OverviewHero, { mode: "gameday" }> {
  return {
    mode: "gameday",
    games: games.map((game) => ({
      game,
      competitionLabel: TEST_COMPETITION_LABELS[game.competitionKey] ?? "NFL",
      rationale: `You follow ${game.home.name}.`
    }))
  };
}

function makeOverview(overrides: Partial<SportsOverviewResponse> = {}): SportsOverviewResponse {
  return {
    hero: gamedayHero(liveGame()),
    followed: [followedCard()],
    scoreboard: [
      {
        competitionKey: "nfl",
        competitionLabel: "NFL",
        games: [liveGame()]
      }
    ],
    topStories: [headline("h1", "nfl", "Vikings clinch division on late field goal")],
    leagueNews: [
      {
        kind: "competition",
        sportKey: "football",
        competitionKey: "nfl",
        competitionLabel: "NFL",
        headlines: [headline("h2", "nfl", "Cowboys sign veteran lineman")]
      }
    ],
    standings: [standingsGroup()],
    followedTeams: [{ competitionKey: "nfl", teamKey: "min", sourceTeamId: "16" }],
    followedLeagues: [],
    followedLeagueCards: [],
    ambiguousFollows: [],
    degraded: false,
    ...overrides
  };
}

function render(overview: SportsOverviewResponse): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sportsQueryKeys.overview, overview);
  return renderToString(createElement(QueryClientProvider, { client }, createElement(SportsPage)));
}

describe("SportsPage", () => {
  it("renders the broadsheet masthead", () => {
    const html = render(makeOverview());
    // Masthead pared to a section-nav + live-event line — the nameplate/brand strip was cut
    // (Ben 2026-07-07: drop the YOLO nameplate + palette chrome from the sports header).
    expect(html).toContain("sp-mast");
    expect(html).toContain("sp-mast__nav");
    expect(html).toContain("sp-mast__navlink");
  });

  it("renders the gameday hero without rationale text, with both teams and scores", () => {
    const html = render(makeOverview());
    // The rationale is why the game is on the page, not something to print at the reader.
    expect(html).not.toContain("You follow Minnesota Vikings");
    expect(html).toContain("Minnesota Vikings");
    expect(html).toContain("Dallas Cowboys");
    expect(html).toContain("21");
    // live pulse present for a live game
    expect(html).toContain("sp-livedot");
    // live score is a scoped aria-live region so screen readers hear updates
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-atomic="true"');
    // competitionLabel must render on every game surface, including the featured score bar
    // (must-not-regress: live badge does not replace the competition label)
    expect(html).toContain('<span class="sp-scorebar__comp">NFL</span>');
  });

  // #1386. The single-game case must be byte-for-byte what shipped before the carousel existed:
  // no tablist, no arrows, nothing extra around the bar.
  it("renders a lone gameday game with no carousel chrome", () => {
    const html = render(makeOverview());
    expect(html).toContain("sp-scorebar");
    expect(html).not.toContain("sp-gameday__tabs");
    expect(html).not.toContain('role="tablist"');
  });

  it("carousels two followed games as tabs, showing the lead game and hiding the rest", () => {
    const second: GameSummary = {
      ...liveGame(),
      id: "g-live-2",
      home: { ...liveGame().home, teamKey: "phi", name: "Philadelphia Eagles", shortName: "PHI" },
      away: { ...liveGame().away, teamKey: "was", name: "Washington", shortName: "WAS" }
    };
    const html = render(makeOverview({ hero: gamedayHero(liveGame(), second) }));
    expect(html).toContain('role="tablist"');
    // A tab names the matchup and its score — the whole reason tabs beat dots here.
    expect(html).toContain("WAS at PHI");
    // Both slides are in the DOM (the stage sizes to the tallest), but only the lead is active
    // and only the lead is reachable.
    expect(html).toContain('data-active="true"');
    expect(html).toContain('data-active="false"');
    expect(html).toContain('aria-hidden="true"');
  });

  it("does not announce the hero score via aria-live when the game is not live", () => {
    const html = render(
      makeOverview({
        hero: gamedayHero({ ...liveGame(), state: "final", statusDetail: "Final" })
      })
    );
    expect(html).not.toContain("aria-live");
    expect(html).not.toContain("aria-atomic");
  });

  it("renders pre-game match times in a clock format, not the raw source status", () => {
    const preGame: GameSummary = {
      ...liveGame(),
      id: "g-pre",
      state: "pre",
      statusDetail: "SOURCE_PREGAME_STRING",
      startsAt: "2026-07-01T23:20:00Z",
      home: { ...liveGame().home, score: null },
      away: { ...liveGame().away, score: null }
    };
    const html = render(
      makeOverview({
        hero: gamedayHero(preGame),
        scoreboard: [{ competitionKey: "nfl", competitionLabel: "NFL", games: [preGame] }]
      })
    );

    expect(html).not.toContain("SOURCE_PREGAME_STRING");
    expect(html).toContain('<span class="sp-scorebar__clock">16:20</span>');
  });

  it("renders the followed-team ticker block with form pips in the header sub-row", () => {
    const html = render(makeOverview());
    expect(html).toContain("sp-ticker");
    expect(html).toContain("MIN 21 – 14 DAL");
    expect(html).toContain("sp-formpip");
    // #963: the fixture card is live — the footer strip carries the live score + LIVE token
    // (supersedes mrawrk0e's hidden-footer rule); body/next-game specifics live in the
    // ticker's own suite.
    expect(html).toContain("sp-next__livetag");
  });

  it("renders the Top-stories column on gameday without the RANKED eyebrow or explainer dek", () => {
    // Default makeOverview is a gameday (live hero), so the carousel yields to the
    // combined Top-stories list in the main column (mrb4w77y).
    const html = render(makeOverview());
    expect(html).toContain("sp-grid");
    expect(html).toContain("sp-latest");
    expect(html).toContain("Top stories");
    expect(html).not.toContain("RANKED");
  });

  it("renders a news-status ticker block as a link to the story", () => {
    const html = render(
      makeOverview({
        followed: [
          followedCard({
            status: "news",
            primary: "",
            stories: [
              {
                title: "Cowboys clinch the division",
                url: "https://example.com/h1",
                publishedAt: "2026-07-01T12:00:00Z",
                imageUrl: null,
                publisherLabel: "ESPN",
                publisherDomain: "espn.com"
              }
            ]
          })
        ]
      })
    );
    expect(html).toContain('href="https://example.com/h1"');
    expect(html).toContain("Cowboys clinch the division");
  });

  it("renders the around-the-leagues board in the main column, with the top strip hidden (mrb4w77y)", () => {
    const html = render(
      makeOverview({
        scoreboard: [
          { competitionKey: "nfl", competitionLabel: "NFL", games: [liveGame()] },
          {
            competitionKey: "nba",
            competitionLabel: "NBA",
            games: [
              {
                ...liveGame(),
                id: "g2",
                competitionKey: "nba",
                state: "final",
                statusDetail: "Final"
              }
            ]
          }
        ]
      })
    );
    // mrb4w77y: scores moved into the main column as a broader board; the old top
    // strip is hidden behind SHOW_AROUND_STRIP (kept in code in case we bring it back).
    expect(html).toContain("sp-board");
    expect(html).toContain("sp-board__league"); // league label rendered once per group
    expect(html).not.toContain("sp-around__scroll");
    expect(html).toContain("Scroll left");
    expect(html).toContain("Scroll right");
    // #841 fix: live and final games surface the source statusDetail (clock/period, "Final"),
    // not just the raw score — a bare score alone can't tell a live game from a final one.
    expect(html).toContain("Q3 4:12");
    expect(html).toContain("Final");
  });

  it("marks a followed team in the standings and scoreboard (is-you / is-mine)", () => {
    const html = render(
      makeOverview({
        followedTeams: [
          { competitionKey: "nfl", teamKey: "min", sourceTeamId: "16" },
          { competitionKey: "eng.1", teamKey: "ars", sourceTeamId: "359" }
        ]
      })
    );
    expect(html).toContain("is-you");
    expect(html).toContain("Premier League");
    expect(html).toContain("W-L");
    expect(html).not.toContain(">#<");
  });

  // Review finding S1, blocker 3: once a short name is shared by two teams, a followed team's
  // stored key can become a permanent number (see follow-identity.ts) while the scoreboard and
  // standings rows for that team keep arriving under the raw, still-shared short name — those
  // fetches have no way to know about the collision. Marking "you" by comparing keys alone would
  // silently stop working the moment that happens; it must also try the permanent number.
  it("still marks a followed team as you when its stored key is a number but the row still carries the shared short name (S1)", () => {
    const sharedShortNameGame: GameSummary = {
      id: "g-shared",
      competitionKey: "nfl",
      startsAt: "2026-07-01T23:20:00Z",
      state: "live",
      statusDetail: "Q3 4:12",
      home: {
        teamKey: "pac",
        sourceTeamId: "401",
        name: "Pacific Lutheran Lutes",
        shortName: "PAC",
        crestUrl: null,
        score: 21,
        record: "10-2",
        winner: true
      },
      away: {
        teamKey: "gb",
        sourceTeamId: null,
        name: "Green Bay Packers",
        shortName: "GB",
        crestUrl: null,
        score: 14,
        record: "8-4",
        winner: false
      }
    };
    const html = render(
      makeOverview({
        hero: gamedayHero(sharedShortNameGame),
        scoreboard: [
          { competitionKey: "nfl", competitionLabel: "NFL", games: [sharedShortNameGame] }
        ],
        // The saved follow now resolves to the permanent number "401", not the shared short name
        // "pac" the game row still carries.
        followedTeams: [{ competitionKey: "nfl", teamKey: "129700", sourceTeamId: "401" }]
      })
    );
    const youIndex = html.indexOf("sp-board__side--you");
    expect(youIndex).toBeGreaterThan(-1);
    expect(html.slice(youIndex, youIndex + 200)).toContain("Pacific Lutheran Lutes");
  });

  it("does not cross-mark a same-teamKey row in another competition (pair-scoped)", () => {
    const html = render(
      makeOverview({
        standings: [
          {
            competitionKey: "eng.1",
            competitionLabel: "Championship",
            standingsShape: "table",
            sections: [
              {
                label: null,
                rows: [
                  {
                    teamKey: "min",
                    sourceTeamId: "16",
                    name: "Minnows FC",
                    rank: 5,
                    points: 30,
                    wins: 8,
                    losses: 6,
                    draws: 4,
                    winPercent: null,
                    qualifies: false,
                    qualificationNote: null,
                    qualificationColor: null
                  }
                ]
              }
            ]
          },
          standingsGroup()
        ]
      })
    );
    const eng1RowStart = html.indexOf("Minnows FC");
    const eng1RowMarkup = html.slice(Math.max(0, eng1RowStart - 400), eng1RowStart);
    expect(eng1RowMarkup).not.toContain("is-you");
  });

  it("shows one standings section at a time with paging controls", () => {
    const html = render(
      makeOverview({
        standings: [
          {
            ...standingsGroup(),
            competitionKey: "mlb",
            competitionLabel: "MLB",
            standingsShape: "table",
            sections: [
              {
                label: "AL East",
                rows: [
                  {
                    teamKey: "nyy",
                    sourceTeamId: null,
                    name: "New York Yankees",
                    rank: 1,
                    points: 52,
                    wins: 52,
                    losses: 31,
                    draws: null,
                    winPercent: null,
                    qualifies: true,
                    qualificationNote: null,
                    qualificationColor: null
                  }
                ]
              },
              {
                label: "AL West",
                rows: [
                  {
                    teamKey: "hou",
                    sourceTeamId: null,
                    name: "Houston Astros",
                    rank: 1,
                    points: 49,
                    wins: 49,
                    losses: 34,
                    draws: null,
                    winPercent: null,
                    qualifies: true,
                    qualificationNote: null,
                    qualificationColor: null
                  }
                ]
              }
            ]
          }
        ]
      })
    );
    // Non-tournament leagues open on "All": one merged league-wide table, best to worst,
    // renumbered so per-section ranks can't collide (live feedback mra33whr + mra50mfr).
    // The old one-section-at-a-time pager (sp-standings__count / Next standings) is gone;
    // sections are reachable through the view <select> instead.
    expect(html).toContain("New York Yankees");
    expect(html).toContain("Houston Astros");
    expect(html).toContain("Select standings league");
    expect(html).toContain("Select standings view");
    expect(html).toContain('<option value="all" selected');
    expect(html).toContain("AL East");
    expect(html).toContain("AL West");
    expect(html).toContain('<td class="pos">2</td>');
    expect(html).not.toContain("sp-standings__count");
    expect(html).not.toContain("Next standings");
  });

  it("names the current league in the standings picker trigger", () => {
    const html = render(makeOverview()); // overview has only one standings group
    expect(html).toContain('aria-label="Select standings league"');
    expect(html).toContain(">Premier League<");
  });

  it("renders a qualification legend from the row note (#841)", () => {
    const html = render(
      makeOverview({
        standings: [
          {
            competitionKey: "eng.1",
            competitionLabel: "Premier League",
            standingsShape: "table",
            sections: [
              {
                label: null,
                rows: [
                  {
                    teamKey: "ars",
                    sourceTeamId: "359",
                    name: "Arsenal",
                    rank: 1,
                    points: 40,
                    wins: 12,
                    losses: 2,
                    draws: 4,
                    winPercent: null,
                    qualifies: true,
                    qualificationNote: "UEFA Champions League",
                    qualificationColor: "#2a66d1"
                  }
                ]
              }
            ]
          }
        ],
        followedTeams: [{ competitionKey: "eng.1", teamKey: "ars", sourceTeamId: "359" }]
      })
    );
    expect(html).toContain("sp-legend");
    expect(html).toContain("UEFA Champions League");
  });

  it("differentiates relegation from qualification structurally, not by color (#841)", () => {
    const html = render(
      makeOverview({
        standings: [
          {
            competitionKey: "eng.1",
            competitionLabel: "Premier League",
            standingsShape: "table",
            sections: [
              {
                label: null,
                rows: [
                  {
                    teamKey: "ars",
                    sourceTeamId: "359",
                    name: "Arsenal",
                    rank: 1,
                    points: 40,
                    wins: 12,
                    losses: 2,
                    draws: 4,
                    winPercent: null,
                    qualifies: true,
                    qualificationNote: "UEFA Champions League",
                    qualificationColor: "#2a66d1"
                  },
                  {
                    teamKey: "shf",
                    sourceTeamId: null,
                    name: "Sheffield Town",
                    rank: 20,
                    points: 22,
                    wins: 5,
                    losses: 20,
                    draws: 3,
                    winPercent: null,
                    qualifies: true,
                    qualificationNote: "Relegation",
                    qualificationColor: "#c1272d"
                  }
                ]
              }
            ]
          }
        ]
      })
    );
    // Both notes get their own legend entry; the marker is a miniature-row swatch painted
    // with ESPN's per-note color (PL-site-style tint + edge bar — the color pass shipped in
    // the broadsheet redesign, superseding the numeral markers).
    expect(html).toContain("UEFA Champions League");
    expect(html).toContain("Relegation");
    const markerCount = [...html.matchAll(/sp-legend__marker/g)].length;
    expect(markerCount).toBe(2);
    expect(html).toContain("#2a66d1");
    expect(html).toContain("#c1272d");
  });

  it("tiers the news-band mosaic: feature, double-column majors with art, standards (mrb5reqq)", () => {
    // Supersedes the mrb0wd68 one-column-per-league sections: stories now flatten into one
    // weight-ranked mosaic. Weights (art +2, dek +1, followed +2, league-front editorial +2):
    // nb1 (art+dek+front) = 5 → wins the full-width feature; nb2/nb3 (art, 2) take the two
    // double-column major slots; nb4 (art, 2) flows as a single-column standard — its art
    // stays, only the brief rail suppresses art, and nothing overflows into it here.
    const html = render(
      makeOverview({
        leagueNews: [
          {
            kind: "competition",
            sportKey: "football",
            competitionKey: "nfl",
            competitionLabel: "NFL",
            headlines: [
              headline("nb1", "nfl", "Cowboys sign veteran lineman", {
                imageUrl: "https://a.espncdn.com/photo/nb1.jpg",
                summary: "A five-year deal shores up the right side."
              }),
              headline("nb2", "nfl", "Giants extend head coach", {
                imageUrl: "https://a.espncdn.com/photo/nb2.jpg"
              }),
              headline("nb3", "nfl", "Bears trade up in the draft", {
                imageUrl: "https://a.espncdn.com/photo/nb3.jpg"
              }),
              headline("nb4", "nfl", "Injury report roundup", {
                imageUrl: "https://a.espncdn.com/photo/nb4.jpg"
              })
            ]
          }
        ]
      })
    );
    expect(html).toContain("sp-newsband__feature");
    expect(html).toContain('src="https://a.espncdn.com/photo/nb1.jpg"');
    const majorCount = [...html.matchAll(/sp-newsband__art--major/g)].length;
    expect(majorCount).toBe(2);
    expect(html).toContain('src="https://a.espncdn.com/photo/nb4.jpg"');
    // 4 stories fit the mosaic caps — no overflow, so no brief rail.
    expect(html).not.toContain("In brief");
  });

  it("promotes the heaviest story to the feature slot and majors need art (mrb47x3h + mrb5reqq)", () => {
    // Weight = art (+2) + dek (+1) + followed team (+2) + league-front editorial (+2);
    // the fixture follows nfl/min. nbf2 (5) wins the full-width feature even though the feed
    // buried it last; it leaves the mosaic so it renders exactly once. nbf3 (4, followed +
    // art) takes a double-column major slot; plain nbf1 (2, front bonus but no art) can't be
    // a major and flows as a standard despite arriving first.
    const html = render(
      makeOverview({
        leagueNews: [
          {
            kind: "competition",
            sportKey: "football",
            competitionKey: "nfl",
            competitionLabel: "NFL",
            headlines: [
              headline("nbf1", "nfl", "League schedule notes"),
              headline("nbf3", "nfl", "Vikings lock up their left tackle", {
                imageUrl: "https://a.espncdn.com/photo/nbf3.jpg",
                teamKeys: ["min"]
              }),
              headline("nbf2", "nfl", "Vikings stun Cowboys at the horn", {
                imageUrl: "https://a.espncdn.com/photo/nbf2.jpg",
                summary: "A 60-yard walk-off field goal flips the division race.",
                teamKeys: ["min"]
              })
            ]
          }
        ]
      })
    );
    expect(html).toContain("sp-newsband__feature");
    expect(html).toContain("sp-newsband__title--feature");
    expect(html.split("Vikings stun Cowboys at the horn").length - 1).toBe(1);
    const majorCount = [...html.matchAll(/sp-newsband__art--major/g)].length;
    expect(majorCount).toBe(1);
    expect(html).toContain("Vikings lock up their left tackle");
    expect(html).toContain("League schedule notes");
  });

  it("renders the empty state with a follow CTA when nothing is followed", () => {
    const html = render(
      makeOverview({
        followed: [],
        followedTeams: [],
        hero: {
          mode: "story",
          headline: headline("lead", "epl", "The transfer window is heating up")
        }
      })
    );
    expect(html).toContain("Follow your teams");
    expect(html).toContain("Choose teams to follow");
  });

  // #763: a whole-league follow (no individual team) is a first-class picker option — the
  // page must not treat that user as if they follow nothing.
  it("shows a distinct leagues header (not the empty-state CTA) for a league-only follower", () => {
    const html = render(
      makeOverview({
        followed: [],
        followedTeams: [],
        followedLeagues: [{ competitionKey: "eng.1", competitionLabel: "Premier League" }],
        hero: {
          mode: "story",
          headline: headline("lead", "epl", "The transfer window is heating up")
        }
      })
    );
    expect(html).not.toContain("Follow your teams");
    expect(html).not.toContain("Choose teams to follow");
    // Header redesign pass: whole-league follows no longer get a ticker block — the league's
    // content lives in the grouped news/standings sections, so no Followed strip renders at all.
    expect(html).not.toContain('aria-label="Followed"');
    expect(html).not.toContain("sp-tk--league");
    expect(html).toContain("Premier League");
    // standings/scores still render for league-only followers (board replaced the
    // Latest column as the always-on main-column block — mrb4w77y)
    expect(html).toContain("Around the leagues");
  });

  // #764: a genuine zero-follow user (no teams, no leagues) previously saw a blank page because
  // the backend never fetched any competition data. The frontend already had this rendering path
  // (`hasSlate` below) — it just needed the backend to actually populate scoreboard/topStories/
  // leagueNews for a zero-follow user (see SportsService.getOverview's default slate).
  it("renders the follow CTA together with a populated default slate for a zero-follow user", () => {
    const html = render(
      makeOverview({
        followed: [],
        followedTeams: [],
        followedLeagues: [],
        hero: {
          mode: "story",
          headline: headline("lead", "nba", "Celtics roll past Heat")
        }
      })
    );
    expect(html).toContain("Follow your teams");
    expect(html).toContain("Choose teams to follow");
    // the default slate (top stories/standings/league news) renders alongside the CTA, not
    // a blank page (H4/#764). Zero-follow users get no hero carousel, so the combined
    // Top-stories list is their only route to topStories (mrb4w77y).
    expect(html).toContain("Top stories");
    expect(html).toContain("Vikings clinch division on late field goal");
    expect(html).toContain("Cowboys sign veteran lineman");
  });

  it("renders the top-stories hero carousel on a quiet day (mrb4w77y)", () => {
    // The carousel consumes data.topStories (not hero.headline), so the quiet-day
    // fixture must put the lead story into topStories — mirroring the server, where
    // the story-mode hero headline IS topStories[0].
    const html = render(
      makeOverview({
        hero: {
          mode: "story",
          headline: headline("lead", "epl", "The transfer window is heating up", {
            imageUrl: "https://a.espncdn.com/photo/2026/story.jpg"
          })
        },
        topStories: [
          headline("lead", "epl", "The transfer window is heating up", {
            imageUrl: "https://a.espncdn.com/photo/2026/story.jpg"
          }),
          headline("h1", "nfl", "Vikings clinch division on late field goal")
        ]
      })
    );
    expect(html).toContain('aria-roledescription="carousel"');
    expect(html).toContain("The transfer window is heating up");
    // second top story renders as another slide, not a Latest column (quiet day = no list)
    expect(html).toContain("Vikings clinch division on late field goal");
    expect(html).toContain("NFL");
    expect(html).toContain('src="https://a.espncdn.com/photo/2026/story.jpg"');
    expect(html).toContain('href="https://example.test/lead"'); // slide title links out
    expect(html).not.toContain("No followed game today");
  });

  it("renders the top-stories column and league news grid on gameday", () => {
    const html = render(makeOverview());
    expect(html).toContain("Top stories");
    expect(html).toContain("Sports news");
    expect(html).toContain("Cowboys sign veteran lineman");
  });

  it("renders the news band with a blurb, continue-reading link, and league filter", () => {
    const html = render(
      makeOverview({
        leagueNews: [
          {
            kind: "competition",
            sportKey: "football",
            competitionKey: "nfl",
            competitionLabel: "NFL",
            headlines: [
              headline("nb1", "nfl", "Cowboys sign veteran lineman", {
                summary: "The move shores up a thin offensive line ahead of the playoffs.",
                url: "https://example.test/nb1"
              })
            ]
          }
        ]
      })
    );
    expect(html).toContain("sp-newsband");
    expect(html).toContain("The move shores up a thin offensive line ahead of the playoffs.");
    expect(html).toContain("Continue reading");
    expect(html).toContain('href="https://example.test/nb1"');
    expect(html).toContain("sp-newsband__filter");
  });

  it("renders a ticker-shaped skeleton row while loading", () => {
    const client = new QueryClient(); // nothing primed → loading branch
    const html = renderToString(
      createElement(QueryClientProvider, { client }, createElement(SportsPage))
    );
    expect(html).toContain("sp-skel--ticker");
    expect(html).toContain("sp-skel--hero");
  });

  it("renders a skeleton matching the composition (ticker + hero + grid, no around strip)", () => {
    const client = new QueryClient(); // nothing primed → loading branch
    const html = renderToString(
      createElement(QueryClientProvider, { client }, createElement(SportsPage))
    );
    expect(html).toContain("sp-skel--ticker");
    // sp-skel--around dropped with the strip (hidden behind SHOW_AROUND_STRIP, mrb4w77y)
    expect(html).not.toContain("sp-skel--around");
    expect(html).toContain("sp-skel--hero");
    expect(html).toContain("sp-skel--grid");
  });
});

// #762: the overview query's refetchInterval decides whether to keep polling by asking
// hasLiveGame() whether the last-fetched payload actually contains a live game — otherwise a
// LiveDot pulses forever over a score that stopped updating the moment the page mounted.
describe("hasLiveGame (#762)", () => {
  const quietHero = {
    mode: "story" as const,
    headline: headline("lead", "epl", "The transfer window is heating up")
  };

  it("is false when nothing in the payload is live", () => {
    const overview = makeOverview({
      hero: quietHero,
      followed: [followedCard({ status: "news" })],
      scoreboard: [
        {
          competitionKey: "nfl",
          competitionLabel: "NFL",
          games: [{ ...liveGame(), state: "final", statusDetail: "FT" }]
        }
      ]
    });
    expect(hasLiveGame(overview)).toBe(false);
  });

  it("is false for undefined data (query hasn't resolved yet)", () => {
    expect(hasLiveGame(undefined)).toBe(false);
  });

  it("is true when the gameday hero's game is live", () => {
    // makeOverview()'s default hero is a live gameday game.
    expect(hasLiveGame(makeOverview())).toBe(true);
  });

  it("is true when a followed team card is live even with a story hero", () => {
    const overview = makeOverview({
      hero: quietHero,
      followed: [followedCard({ status: "live" })],
      scoreboard: [
        {
          competitionKey: "nfl",
          competitionLabel: "NFL",
          games: [{ ...liveGame(), state: "final", statusDetail: "FT" }]
        }
      ]
    });
    expect(hasLiveGame(overview)).toBe(true);
  });

  it("is true when a scoreboard game is live even with no gameday hero or live followed card", () => {
    const overview = makeOverview({
      hero: quietHero,
      followed: [followedCard({ status: "news" })],
      scoreboard: [
        {
          competitionKey: "nfl",
          competitionLabel: "NFL",
          games: [liveGame()]
        }
      ]
    });
    expect(hasLiveGame(overview)).toBe(true);
  });
});

describe("the lead story prefers a wide photo (#2237)", () => {
  it("moves the first story with a wide photo to the front", () => {
    const stories = [
      headline("a", "nfl", "Narrow", { imageUrl: "/a", imageWidth: 400 }),
      headline("b", "nfl", "No photo"),
      headline("c", "nfl", "Wide", { imageUrl: "/c", imageWidth: 1280 }),
      headline("d", "nfl", "Also wide", { imageUrl: "/d", imageWidth: 900 })
    ];

    expect(leadWidePhotoFirst(stories).map((story) => story.id)).toEqual(["c", "a", "b", "d"]);
  });

  it("changes nothing when no story has a wide photo, or when the first already does", () => {
    const narrow = [
      headline("a", "nfl", "Narrow", { imageUrl: "/a", imageWidth: 400 }),
      headline("b", "nfl", "No photo")
    ];
    expect(leadWidePhotoFirst(narrow)).toBe(narrow);

    const alreadyWide = [
      headline("a", "nfl", "Wide", { imageUrl: "/a", imageWidth: 1200 }),
      headline("b", "nfl", "Narrow", { imageUrl: "/b", imageWidth: 300 })
    ];
    expect(leadWidePhotoFirst(alreadyWide)).toBe(alreadyWide);
  });

  it("keeps every story: this is a preference, not a filter", () => {
    const stories = [
      headline("a", "nfl", "No photo"),
      headline("b", "nfl", "Wide", { imageUrl: "/b", imageWidth: 1280 })
    ];
    expect(leadWidePhotoFirst(stories)).toHaveLength(2);
  });

  it("picks a wide photo for the game band too, and falls back when there is none", () => {
    const game = liveGame();
    const about = (id: string, overrides: Partial<Headline>) =>
      headline(id, "nfl", "Vikings hold off the Cowboys", {
        teamKeys: ["min", "dal"],
        ...overrides
      });

    const withWide = makeOverview({
      topStories: [
        about("narrow", { imageUrl: "/narrow", imageWidth: 400, summary: "A dek" }),
        about("wide", { imageUrl: "/wide", imageWidth: 1280 })
      ],
      hero: gamedayHero(game)
    });
    expect(findFeaturedStory(game, withWide)?.id).toBe("wide");

    const noWide = makeOverview({
      topStories: [
        about("plain", { imageUrl: "/plain", imageWidth: 400 }),
        about("dek", { imageUrl: "/dek", imageWidth: 300, summary: "A dek" })
      ],
      hero: gamedayHero(game)
    });
    expect(findFeaturedStory(game, noWide)?.id).toBe("dek");
  });
});
