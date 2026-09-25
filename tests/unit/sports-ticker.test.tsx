// @vitest-environment jsdom
import { act, createElement } from "react";
import { renderToString } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";

import type { FollowedLeagueCard, FollowedTeamCard, FollowedTeamNews } from "@moss/shared";

import {
  SportsTicker,
  TickerLeague,
  TickerTeam
} from "../../packages/sports/src/web/sports-ticker.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Stories arrive fully-formed on the card now (mrb0pk1n) — no client-side headline matching.
function story(overrides: Partial<FollowedTeamNews> = {}): FollowedTeamNews {
  return {
    title: "Vikings extend their coach",
    url: "https://example.com/n1",
    publishedAt: "2026-07-07T12:00:00Z",
    imageUrl: null,
    publisherLabel: "ESPN",
    publisherDomain: "espn.com",
    ...overrides
  };
}

function card(overrides: Partial<FollowedTeamCard> = {}): FollowedTeamCard {
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
    standing: "2nd · NFC North",
    nextMatch: {
      opponentName: "Green Bay Packers",
      homeAway: "home",
      startsAt: "2026-07-11T20:00:00Z"
    },
    lastMatchAt: null,
    rationale: "You follow the Vikings",
    ...overrides
  };
}

function render(followed: FollowedTeamCard[]): string {
  const client = new QueryClient();
  return renderToString(
    createElement(QueryClientProvider, { client }, createElement(SportsTicker, { followed }))
  );
}

describe("SportsTicker", () => {
  it("renders a live team with the score in the footer strip and news in the body (#963)", () => {
    const html = render([
      card({
        stories: [story({ title: "Vikings lead late in Dallas", url: "https://example.com/live" })]
      })
    ]);
    expect(html).toContain("sp-ticker");
    expect(html).toContain("Minnesota Vikings");
    // standing + form sit in the card head beside the team name
    expect(html).toContain("sp-tk__head");
    expect(html).toContain("sp-formpip");
    expect(html).toContain("2nd · NFC North");
    // #963: the live score takes the footer slot; the body slot goes back to the news lede
    expect(html).toContain("sp-tk__next--live");
    expect(html).toContain("Live now");
    expect(html).toContain("MIN 21 – 14 DAL");
    expect(html).toContain("Vikings lead late in Dallas");
    // the bold body score is gone — no score-styled body element renders
    expect(html).not.toContain("sp-tk__score");
    // live footer shows the score, never the upcoming fixture, even though nextMatch is set
    expect(html).not.toContain("Green Bay Packers");
  });

  it("puts the Live label beside a long name and the five form pips in the same head", () => {
    const html = renderTickerTeam(
      card({ name: "Wolverhampton Wanderers", form: ["W", "W", "D", "L", "W"] })
    );
    const head = /<header class="sp-tk__head">([\s\S]*?)<\/header>/.exec(html)?.[1] ?? "";
    expect(head).toMatch(/sp-tk__name">Wolverhampton Wanderers<\/span><span class="sp-tk__live">/);
    expect(head.match(/sp-formpip sp-formpip--/g)).toHaveLength(5);
  });

  it("shows the No-recent-news placeholder on a storyless live card (#963)", () => {
    const html = render([card({ stories: [] })]);
    expect(html).toContain("No recent news");
    expect(html).toContain("sp-tk__next--live");
    expect(html).toContain("MIN 21 – 14 DAL");
    expect(html).not.toContain("sp-tk__score");
  });

  it("caps a live card at two secondary stories — the strip needs its room (#963)", () => {
    // live behaves like any footer-bearing card: lede + 2 links, not lede + 3.
    const html = render([
      card({
        stories: [
          story({ title: "Lede story", url: "https://example.com/a" }),
          story({ title: "Second story", url: "https://example.com/b" }),
          story({ title: "Third story", url: "https://example.com/c" }),
          story({ title: "Fourth story", url: "https://example.com/d" })
        ]
      })
    ]);
    expect(html).toContain("Second story");
    expect(html).toContain("Third story");
    expect(html).not.toContain("Fourth story");
  });

  // Regression for the standingIsSane guard: the old bare /-\d/ negative-points check also
  // matched every W-L record and hid ALL US-league standings on live data (mraxrdxr, mraz6m43).
  it("shows a W-L record standing but still hides negative-points noise", () => {
    const html = render([card({ standing: "#3 · 10-2" })]);
    expect(html).toContain("#3 · 10-2");
    const noisy = render([card({ standing: "#0 · -7.5 pts" }), card({ standing: "#4 · -2 pts" })]);
    expect(noisy).not.toContain("-7.5 pts");
    expect(noisy).not.toContain("-2 pts");
  });

  it("shows the text next-game footer, same as Today (non-live)", () => {
    const html = render([card({ status: "news", primary: "", stories: [story()] })]);
    expect(html).toContain("sp-tk__next");
    expect(html).toContain("Next game");
    expect(html).toContain("vs Green Bay Packers");
    expect(html).not.toContain("sp-tk__next--live");
  });

  it("renders the Today card in the strip, without the story feedback menu (#2074)", () => {
    const stories = [
      story({ title: "Lede", url: "https://example.com/a", storyRef: "ref-a" }),
      story({ title: "Second", url: "https://example.com/b", storyRef: "ref-b" })
    ];
    const html = render([card({ status: "news", primary: "", stories })]);
    expect(html).toMatch(/aria-label="Followed teams"[^>]*>\s*<article class="sp-tk"/);
    expect(html).not.toContain("sp-feat");
    expect(html).not.toContain("sp-feedback");
    // Today keeps the menu on the same card.
    const client = new QueryClient();
    const today = renderToString(
      createElement(
        QueryClientProvider,
        { client },
        createElement(TickerTeam, {
          card: card({ status: "news", primary: "", stories }),
          surface: "today"
        })
      )
    );
    expect(today).toContain("sp-feedback");
  });

  it("fills the pre-game today primary with news — footer carries the fixture", () => {
    // mrawrk0e: "Vikings @ Cowboys" duplicated the footer's fixture line pre-game. Hiding the
    // whole slot then left a void (top-area feedback 2026-07-07) — it now shows news instead.
    const html = render([
      card({
        status: "today",
        primary: "Vikings @ Cowboys",
        todayGameState: "pre",
        stories: [story({ title: "Vikings name their starter", url: "https://example.com/qb" })]
      })
    ]);
    expect(html).not.toContain("Vikings @ Cowboys");
    expect(html).toContain("Vikings name their starter");
    expect(html).toContain("sp-tk__next");
    // no story at all → honest placeholder, still no fixture duplication
    const bare = render([
      card({ status: "today", primary: "Vikings @ Cowboys", todayGameState: "pre" })
    ]);
    expect(bare).not.toContain("Vikings @ Cowboys");
    expect(bare).toContain("No recent news");
    // a finished game's score stays in the primary slot when no structured resultMatch is present
    const finalHtml = render([
      card({ status: "today", primary: "MIN 24 – 10 DAL", todayGameState: "final" })
    ]);
    expect(finalHtml).toContain("MIN 24 – 10 DAL");
  });

  it("renders a finished game as both crests + result, dropping the 'vs' text (annotation #2)", () => {
    // Ben 2026-07-08 /sports #2: when resultMatch is present the score slot leads with both
    // teams' crests and shows just the bare score — the crests carry the identity, so the cheap
    // "L 3–9 vs Blue Jays" text no longer appears, and (#2253 round 2) the W/L letter is gone
    // from the visible row too: the form pips already say who won. sr-only keeps both team
    // names and the result word reachable.
    const html = render([
      card({
        status: "today",
        todayGameState: "final",
        primary: "L 3–9 vs Blue Jays",
        resultMatch: {
          opponentName: "Toronto Blue Jays",
          opponentCrestUrl: null,
          resultLabel: "L",
          homeScore: 9,
          awayScore: 3,
          homeAway: "away",
          ownScorers: null,
          opponentScorers: null
        }
      })
    ]);
    expect(html).toContain("sp-tk__result");
    expect(html).toContain(">9–3<");
    expect(html).not.toContain("L 9–3");
    expect(html).toContain("lost");
    expect(html).toContain("sp-sronly");
    expect(html).toContain("Toronto Blue Jays"); // sr-only opponent name (SSR splits the "vs " prefix)
    // the cheap combined text tail is gone
    expect(html).not.toContain("L 3–9 vs Blue Jays");
    // most sports/most games have no scorer data — no scorer list should render at all
    expect(html).not.toContain("sp-tk__scorers");
  });

  it("keeps the score in home-left order when the followed team plays away (#2253)", () => {
    // The followed team (Minnesota) is away and lost 1–3. The crests always draw home-left,
    // away-right, so the score must read "3–1" (home's number first), not "1–3" (the
    // followed team's own number first) — the old bug put the numbers on the wrong side of a
    // score that read correctly for the crests.
    const html = render([
      card({
        name: "Minnesota Vikings",
        status: "today",
        todayGameState: "final",
        primary: "L 1 – 3",
        resultMatch: {
          opponentName: "Dallas FC",
          opponentCrestUrl: null,
          resultLabel: "L",
          homeScore: 3,
          awayScore: 1,
          homeAway: "away",
          ownScorers: null,
          opponentScorers: null
        }
      })
    ]);
    expect(html).toContain(">3–1<");
    expect(html).not.toContain("1–3");
  });

  it("renders goal scorers on each team's outer side for a finished soccer/hockey game", () => {
    // Home is always on the left (Ben: "home to the left"); scorers sit on that team's outer
    // side — away team here, so its scorers land in the "--away" list, and the followed team
    // (home) has its scorers in the "--home" list.
    const html = render([
      card({
        name: "Minnesota Vikings", // followed team, plays home in this fixture
        status: "today",
        todayGameState: "final",
        primary: "MIN 2 – 1 DAL",
        resultMatch: {
          opponentName: "Dallas FC",
          opponentCrestUrl: null,
          resultLabel: "W",
          homeScore: 2,
          awayScore: 1,
          homeAway: "home",
          ownScorers: ["A. Isak (2)"],
          opponentScorers: ["Z. Benson"]
        }
      })
    ]);
    expect(html).toContain("sp-tk__scorers--home");
    expect(html).toContain("A. Isak (2)");
    expect(html).toContain("sp-tk__scorers--away");
    expect(html).toContain("Z. Benson");
  });

  it("still reserves both scorer slots when only one team has scorer data (#2253)", () => {
    // Only the home team has scorer data (e.g. a hockey game with a degraded away list). The
    // away slot must still render, empty, so the flex space stays symmetric and the crests
    // don't drift toward the edge.
    const html = render([
      card({
        name: "Minnesota Vikings",
        status: "today",
        todayGameState: "final",
        primary: "MIN 2 – 1 DAL",
        resultMatch: {
          opponentName: "Dallas FC",
          opponentCrestUrl: null,
          resultLabel: "W",
          homeScore: 2,
          awayScore: 1,
          homeAway: "home",
          ownScorers: ["A. Isak (2)"],
          opponentScorers: null
        }
      })
    ]);
    expect(html).toContain("sp-tk__scorers--home");
    expect(html).toContain("A. Isak (2)");
    // the empty away list is still in the markup, reserving its share of the row's width
    expect(html).toContain("sp-tk__scorers--away");
  });

  it("leads with the first story and links the next two (mrb0pk1n)", () => {
    // stories[0] takes the primary slot (thumb + title); the remainder render as the small
    // text links. "No recent news" only appears when the club truly has no stories (mrathm2y).
    const html = render([
      card({
        status: "news",
        primary: "",
        stories: [
          story({ title: "Vikings sign a new kicker", url: "https://example.com/vikings" }),
          story({ title: "Camp battle at corner", url: "https://example.com/corner" }),
          story({ title: "Schedule quirks explained", url: "https://example.com/sched" })
        ]
      })
    ]);
    expect(html).not.toContain("No recent news");
    expect(html).toContain("Vikings sign a new kicker");
    expect(html).toContain("sp-tk__stories");
    expect(html).toContain("Camp battle at corner");
    expect(html).toContain("Schedule quirks explained");
  });

  it("renders a news-status team as a link to the story", () => {
    const html = render([
      card({
        status: "news",
        primary: "",
        stories: [story({ title: "Cowboys clinch the division", url: "https://example.com/h1" })]
      })
    ]);
    expect(html).toContain('href="https://example.com/h1"');
    expect(html).toContain("Cowboys clinch the division");
  });

  it("is a labeled, keyboard-focusable scroll region with a manage link", () => {
    const html = render([card()]);
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="Followed teams"');
    expect(html).toContain("/settings?section=modules&amp;module=sports");
  });

  it("renders nothing when there are no follows", () => {
    // Whole-league follows also render no block here — the league-grouped sections below
    // carry them, so a league-only follower sees no Followed strip (header redesign pass).
    expect(render([])).toBe("");
  });
});

// TickerTeam is the /today surface of the same card — #963 requires the live-score strip on
// BOTH surfaces in lockstep, so it gets its own direct render coverage (it had none before).
function renderTickerTeam(c: FollowedTeamCard): string {
  const client = new QueryClient();
  return renderToString(
    createElement(QueryClientProvider, { client }, createElement(TickerTeam, { card: c }))
  );
}

describe("TickerTeam", () => {
  it("renders a live team with the score in the footer strip and news in the body (#963)", () => {
    const html = renderTickerTeam(
      card({
        stories: [story({ title: "Vikings lead late in Dallas", url: "https://example.com/live" })]
      })
    );
    expect(html).toContain("sp-tk__next--live");
    expect(html).toContain("Live now");
    expect(html).toContain("MIN 21 – 14 DAL");
    expect(html).toContain("Vikings lead late in Dallas");
    // the bold body score is gone on this surface too
    expect(html).not.toContain("sp-tk__score");
    // live strip carries the score, not the fixture, even with nextMatch set
    expect(html).not.toContain("Green Bay Packers");
  });

  it("puts the Live label beside a long name and the five form pips in the same head", () => {
    const html = renderTickerTeam(
      card({ name: "Wolverhampton Wanderers", form: ["W", "W", "D", "L", "W"] })
    );
    const head = /<header class="sp-tk__head">([\s\S]*?)<\/header>/.exec(html)?.[1] ?? "";
    expect(head).toMatch(/sp-tk__name">Wolverhampton Wanderers<\/span><span class="sp-tk__live">/);
    expect(head.match(/sp-formpip sp-formpip--/g)).toHaveLength(5);
  });

  it("shows the No-recent-news placeholder on a storyless live card (#963)", () => {
    const html = renderTickerTeam(card({ stories: [] }));
    expect(html).toContain("No recent news");
    expect(html).toContain("sp-tk__next--live");
    expect(html).toContain("MIN 21 – 14 DAL");
    expect(html).not.toContain("sp-tk__score");
  });

  it("keeps the next-game footer on a non-live card (#963 non-regression)", () => {
    const html = renderTickerTeam(card({ status: "news", primary: "", stories: [story()] }));
    expect(html).toContain("sp-tk__next");
    expect(html).toContain("Next game");
    expect(html).toContain("vs Green Bay Packers");
    expect(html).not.toContain("sp-tk__next--live");
  });

  it("puts the publisher in a kicker above the headline instead of trailing it", () => {
    const html = renderTickerTeam(
      card({
        status: "news",
        primary: "",
        stories: [
          story({
            title: "Vikings sign a new kicker",
            publisherLabel: "The Athletic",
            publisherDomain: "theathletic.com"
          })
        ]
      })
    );
    expect(html).toMatch(/class="sp-tk__kicker">The Athletic</);
    expect(html).not.toContain("Vikings sign a new kicker · The Athletic");
  });

  it("passes the team brand color to the Today stylesheet as --team-accent", () => {
    expect(renderTickerTeam(card({ status: "news" }))).toContain("--team-accent:#4f2683");
    expect(renderTickerTeam(card({ status: "news", teamKey: "zzz" }))).not.toContain(
      "--team-accent"
    );
  });

  it("keeps the score in home-left order when the followed team plays away (#2253)", () => {
    const html = renderTickerTeam(
      card({
        name: "Minnesota Vikings",
        status: "today",
        todayGameState: "final",
        primary: "L 1 – 3",
        resultMatch: {
          opponentName: "Dallas FC",
          opponentCrestUrl: null,
          resultLabel: "L",
          homeScore: 3,
          awayScore: 1,
          homeAway: "away",
          ownScorers: null,
          opponentScorers: null
        }
      })
    );
    expect(html).toContain(">3–1<");
    expect(html).not.toContain("1–3");
  });

  it("still reserves both scorer slots when only one team has scorer data (#2253)", () => {
    const html = renderTickerTeam(
      card({
        name: "Minnesota Vikings",
        status: "today",
        todayGameState: "final",
        primary: "MIN 2 – 1 DAL",
        resultMatch: {
          opponentName: "Dallas FC",
          opponentCrestUrl: null,
          resultLabel: "W",
          homeScore: 2,
          awayScore: 1,
          homeAway: "home",
          ownScorers: ["A. Isak (2)"],
          opponentScorers: null
        }
      })
    );
    expect(html).toContain("sp-tk__scorers--home");
    expect(html).toContain("A. Isak (2)");
    expect(html).toContain("sp-tk__scorers--away");
  });
});

describe("TickerTeam failed lead image", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("removes a failed lead image while keeping the headline and later good images", async () => {
    const bad = "https://example.com/broken-photo.jpg";
    const good = "https://example.com/ok-photo.jpg";
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const client = new QueryClient();
    const badCard = card({
      status: "news",
      primary: "",
      stories: [
        story({
          title: "Bad image story",
          url: "https://example.com/bad",
          imageUrl: bad
        })
      ]
    });
    const goodCard = card({
      teamKey: "dal",
      name: "Dallas FC",
      status: "news",
      primary: "",
      stories: [
        story({
          title: "Good image story",
          url: "https://example.com/good",
          imageUrl: good
        })
      ]
    });
    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(
            "div",
            null,
            createElement(TickerTeam, { card: badCard }),
            createElement(TickerTeam, { card: goodCard })
          )
        )
      );
    });
    expect(container.querySelectorAll("img.sp-tk__media")).toHaveLength(2);
    const broken = container.querySelector(`img[src="${bad}"]`);
    expect(broken).not.toBeNull();
    await act(async () => {
      broken?.dispatchEvent(new Event("error"));
    });
    const remaining = container.querySelectorAll("img.sp-tk__media");
    expect(remaining).toHaveLength(1);
    expect(remaining.item(0)?.getAttribute("src")).toBe(good);
    expect(container.textContent).toContain("Bad image story");
    expect(container.textContent).toContain("Good image story");
    await act(async () => {
      root.unmount();
    });
  });
});

describe("TickerLeague", () => {
  const league: FollowedLeagueCard = {
    competitionKey: "eng.1",
    competitionLabel: "Premier League",
    kind: "league",
    status: "news",
    logoUrl: null,
    stories: [story({ title: "City held at home", publisherLabel: "BBC Sport" })],
    results: [
      { line: "LIV 2 – 3 MNC", startsAt: "2026-09-20T15:00:00Z", state: "final", detail: "FT" }
    ]
  };

  it("labels the recent results and carries no team brand color", () => {
    const client = new QueryClient();
    const html = renderToString(
      createElement(QueryClientProvider, { client }, createElement(TickerLeague, { card: league }))
    );
    expect(html).toMatch(/class="sp-tk__kicker">BBC Sport</);
    expect(html).toContain("Recent results");
    expect(html).toContain("LIV 2 – 3 MNC");
    expect(html).not.toContain("--team-accent");
  });
});
