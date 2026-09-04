import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import type { FollowedTeamCard, FollowedTeamNews } from "@moss/shared";

import { SportsTicker, TickerTeam } from "../../packages/sports/src/web/sports-ticker.js";

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
    // standing + form stay in the header sub-row under the team name (mrawlzb7)
    expect(html).toContain("sp-feat__sub");
    expect(html).toContain("sp-formpip");
    expect(html).toContain("2nd · NFC North");
    // #963: the live score moves into the footer strip (same .sp-next bar as next-game),
    // with a LIVE token; the body slot goes back to the news lede like any non-live card.
    expect(html).toContain("sp-feat__next");
    expect(html).toContain("sp-next__livetag");
    expect(html).toContain("MIN 21 – 14 DAL");
    expect(html).toContain("Vikings lead late in Dallas");
    // the bold body score is gone — no score-styled body element renders
    expect(html).not.toContain("sp-feat__score");
    // live strip shows the score, never the upcoming fixture, even though nextMatch is set
    expect(html).not.toContain("sp-next__venue");
    // the competition/status eyebrow row stays removed (live feedback mratgoq4)
    expect(html).not.toContain("sp-feat__comp");
  });

  it("shows the No-recent-news placeholder on a storyless live card (#963)", () => {
    const html = render([card({ stories: [] })]);
    expect(html).toContain("No recent news");
    expect(html).toContain("sp-next__livetag");
    expect(html).toContain("MIN 21 – 14 DAL");
    expect(html).not.toContain("sp-feat__score");
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

  it("shows the next-game footer with opponent crest, no visible name (non-live)", () => {
    const html = render([card({ status: "news", primary: "", stories: [story()] })]);
    expect(html).toContain("sp-feat__next");
    // opponent identity is the crest (initials swatch here — no crestUrl) plus an
    // sr-only name; the visible "vs Green Bay Packers" line is gone (mrawvc48)
    expect(html).toContain("sp-sronly");
    expect(html).toContain("vs Green Bay Packers");
    expect(html).not.toContain("sp-feat__nextlbl");
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
    expect(html).toContain("sp-feat__next");
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
    // teams' crests and shows just "L 3–9" — the crests carry the identity, so the cheap
    // "L 3–9 vs Blue Jays" text no longer appears. sr-only keeps both team names reachable.
    const html = render([
      card({
        status: "today",
        todayGameState: "final",
        primary: "L 3–9 vs Blue Jays",
        resultMatch: {
          opponentName: "Toronto Blue Jays",
          opponentCrestUrl: null,
          scoreText: "L 3–9",
          homeAway: "away",
          ownScorers: null,
          opponentScorers: null
        }
      })
    ]);
    expect(html).toContain("sp-feat__result");
    expect(html).toContain("L 3–9");
    expect(html).toContain("sp-sronly");
    expect(html).toContain("Toronto Blue Jays"); // sr-only opponent name (SSR splits the "vs " prefix)
    // the cheap combined text tail is gone
    expect(html).not.toContain("L 3–9 vs Blue Jays");
    // most sports/most games have no scorer data — no scorer list should render at all
    expect(html).not.toContain("sp-feat__scorers");
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
          scoreText: "W 2–1",
          homeAway: "home",
          ownScorers: ["A. Isak (2)"],
          opponentScorers: ["Z. Benson"]
        }
      })
    ]);
    expect(html).toContain("sp-feat__scorers--home");
    expect(html).toContain("A. Isak (2)");
    expect(html).toContain("sp-feat__scorers--away");
    expect(html).toContain("Z. Benson");
  });

  it("leads with the first story and links the rest — up to three per club (mrb0pk1n)", () => {
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
    expect(html).toContain("sp-feat__stories");
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
    expect(html).toContain("sp-tk__next");
    expect(html).toContain("sp-next__livetag");
    expect(html).toContain("MIN 21 – 14 DAL");
    expect(html).toContain("Vikings lead late in Dallas");
    // the bold body score is gone on this surface too
    expect(html).not.toContain("sp-tk__score");
    // live strip carries the score, not the fixture, even with nextMatch set
    expect(html).not.toContain("Green Bay Packers");
  });

  it("shows the No-recent-news placeholder on a storyless live card (#963)", () => {
    const html = renderTickerTeam(card({ stories: [] }));
    expect(html).toContain("No recent news");
    expect(html).toContain("sp-next__livetag");
    expect(html).toContain("MIN 21 – 14 DAL");
    expect(html).not.toContain("sp-tk__score");
  });

  it("keeps the next-game footer on a non-live card (#963 non-regression)", () => {
    const html = renderTickerTeam(card({ status: "news", primary: "", stories: [story()] }));
    expect(html).toContain("sp-tk__next");
    expect(html).toContain("Green Bay Packers");
    expect(html).not.toContain("sp-next__livetag");
  });
});
