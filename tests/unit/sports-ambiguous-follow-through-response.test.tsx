import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import type { StandingsTable } from "../../packages/sports/src/source/sports-source.js";
import type { SportsOverviewResponse } from "@moss/shared";

import { SportsPage } from "../../packages/sports/src/web/sports-page.js";
import { sportsQueryKeys } from "../../packages/sports/src/web/query-keys.js";
import { buildApp, makeRepo, makeSource } from "./sports-routes.test.js";

// Review finding S1, blockers 3 and 4 (2026-09-04). Both failures had the same shape: the page
// was fixed but the fix never reached the browser, because the response schema silently drops any
// field it does not list. So nothing here hands the page a hand-built object. It starts the real
// server, asks for the overview over HTTP, and renders the real page component from exactly the
// bytes that came back.

const PACIFIC_TEAMS = [
  {
    teamKey: "pac.129700",
    competitionKey: "nfl",
    name: "Pacific Lutheran Lutes",
    shortName: "Lutes",
    crestUrl: null,
    sourceTeamId: "129700",
    abbreviation: "pac"
  },
  {
    teamKey: "pac.413",
    competitionKey: "nfl",
    name: "Pacific Tigers",
    shortName: "Tigers",
    crestUrl: null,
    sourceTeamId: "413",
    abbreviation: "pac"
  }
];

function standingsRow(name: string, sourceTeamId: string, rank: number) {
  return {
    teamKey: "pac",
    sourceTeamId,
    name,
    rank,
    points: null,
    wins: 6 - rank,
    losses: rank,
    draws: null,
    winPercent: 0.5,
    qualifies: false,
    qualificationNote: null,
    qualificationColor: null
  };
}

// Two standings rows share one short name — the case that gave the table two identical row
// identities, so the browser kept only one of them.
const sharedShortNameStandings: StandingsTable = {
  sections: [
    {
      label: null,
      rows: [
        standingsRow("Pacific Lutheran Lutes", "129700", 1),
        standingsRow("Pacific Tigers", "413", 2)
      ]
    }
  ]
};

async function overviewOverHttp(savedTeamKey = "pac"): Promise<SportsOverviewResponse> {
  const { app } = buildApp({
    repo: makeRepo([
      {
        id: "11111111-1111-1111-1111-111111111111",
        competitionKey: "nfl",
        teamKey: savedTeamKey,
        createdAt: "2026-06-01T00:00:00.000Z"
      }
    ]),
    datasetClient: makeSource({
      listTeams: async () => PACIFIC_TEAMS,
      getScoreboard: async () => [],
      getSchedule: async () => [],
      getStandings: async () => sharedShortNameStandings
    })
  });
  await app.ready();
  const res = await app.inject({ method: "GET", url: "/api/sports/overview" });
  expect(res.statusCode).toBe(200);
  const body = JSON.parse(res.body) as SportsOverviewResponse;
  await app.close();
  return body;
}

function renderPage(overview: SportsOverviewResponse): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sportsQueryKeys.overview, overview);
  return renderToString(createElement(QueryClientProvider, { client }, createElement(SportsPage)));
}

describe("a saved team that can no longer be told apart, all the way to the page", () => {
  it("carries the affected follow and each team's permanent number over the wire", async () => {
    const body = await overviewOverHttp();
    expect(body.ambiguousFollows).toEqual([
      {
        competitionKey: "nfl",
        savedTeamKey: "pac",
        candidateNames: ["Pacific Lutheran Lutes", "Pacific Tigers"]
      }
    ]);
    const rows = body.standings[0]?.sections[0]?.rows ?? [];
    expect(rows.map((row) => row.sourceTeamId)).toEqual(["129700", "413"]);
  });

  it("asks which team was meant instead of dropping the saved team in silence", async () => {
    const html = renderPage(await overviewOverHttp());
    expect(html).toContain("Which team did you mean?");
    expect(html).toContain("Pacific Lutheran Lutes");
    expect(html).toContain("Pacific Tigers");
    expect(html).toContain("Pick the right team");
  });

  it("marks only the saved team's own standings row as yours", async () => {
    // The two rows differ only by the permanent number the response now carries. Before this
    // change the number never reached the browser at all, so nothing on the table could tell the
    // two Pacific rows apart and the reader's own row was left unmarked.
    const html = renderPage(await overviewOverHttp("pac.413"));
    const rows = html
      .split("<tr")
      .slice(1)
      .filter((row) => row.includes("Pacific"));
    expect(rows).toHaveLength(2);
    const mine = rows.filter((row) => row.includes("is-you"));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toContain("Pacific Tigers");
  });
});

// Re-review 3 blocker 3 (2026-09-04): the browser used to put permanent numbers and short names
// in one collection and accept a row that matched either. A club whose own short name happens to
// be another club's permanent number was therefore marked as the reader's team. The list below is
// exactly that trap: Pacific Tigers' number is 413, and a different club goes by "413".
const NUMBER_LOOKALIKE_TEAMS = [
  ...PACIFIC_TEAMS,
  {
    teamKey: "413",
    competitionKey: "nfl",
    name: "Team 413",
    shortName: "413",
    crestUrl: null,
    sourceTeamId: "9001",
    abbreviation: "413"
  }
];

const lookalikeStandings: StandingsTable = {
  sections: [
    {
      label: null,
      rows: [
        standingsRow("Pacific Tigers", "413", 1),
        { ...standingsRow("Team 413", "9001", 2), teamKey: "413" }
      ]
    }
  ]
};

async function lookalikeOverviewOverHttp(): Promise<SportsOverviewResponse> {
  const { app } = buildApp({
    repo: makeRepo([
      {
        id: "22222222-2222-2222-2222-222222222222",
        competitionKey: "nfl",
        teamKey: "pac.413",
        createdAt: "2026-06-01T00:00:00.000Z"
      }
    ]),
    datasetClient: makeSource({
      listTeams: async () => NUMBER_LOOKALIKE_TEAMS,
      getScoreboard: async () => [],
      getSchedule: async () => [],
      getStandings: async () => lookalikeStandings
    })
  });
  await app.ready();
  const res = await app.inject({ method: "GET", url: "/api/sports/overview" });
  expect(res.statusCode).toBe(200);
  const body = JSON.parse(res.body) as SportsOverviewResponse;
  await app.close();
  return body;
}

describe("a club whose name looks like another club's number, all the way to the page", () => {
  it("marks only the followed team, not the club named after its number", async () => {
    const html = renderPage(await lookalikeOverviewOverHttp());
    const rows = html
      .split("<tr")
      .slice(1)
      .filter((row) => row.includes("Pacific Tigers") || row.includes("Team 413"));
    expect(rows).toHaveLength(2);
    const mine = rows.filter((row) => row.includes("is-you"));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toContain("Pacific Tigers");
  });
});
