/**
 * The old Sports overview, standings and latest-result routes, run through the old Fastify
 * handlers with the real dataset client and ESPN reader. Only the network and the follows table
 * are replaced: ESPN answers from recorded fixtures and follows come from a fixed list.
 * Run: tsx tools/overview-oracle.ts, then minify the output into tests/fixtures/overview-routes.golden.json
 */
import { readFileSync } from "node:fs";
import Fastify from "fastify";
import { createDatasetClient } from "../../../packages/datasets/src/index.js";
import { setMossErrorHandler } from "../../../apps/api/src/error-handling.js";
import { createEspnDatasetAdapter } from "../../../packages/sports/src/source/espn-source.js";
import { sportsModuleManifest } from "../../../packages/sports/src/manifest.js";
import { registerSportsRoutes } from "../../../packages/sports/src/routes.js";

const NOW = new Date("2026-11-13T03:00:00Z");
const dir = new URL("../tests/fixtures/", import.meta.url);

const fixtureFor = (url: string): string | null => {
  const has = (s: string) => url.includes(s);
  if (has("/teams?")) {
    if (has("/soccer/eng.1/")) return "eng1-teams.json";
    if (has("/baseball/college-baseball/")) return "ncaa-baseball-teams-subset.json";
    return "nfl-teams.json";
  }
  if (has("/schedule") || has("/scoreboard?")) {
    if (has("/soccer/")) return "eng1-scoreboard-20260104-everton-brentford.json";
    if (has("/hockey/nhl/")) return "nhl-scoreboard-20261112.json";
    return "nfl-scoreboard.json";
  }
  if (has("/standings?")) {
    if (has("/soccer/eng.1/")) return "eng1-standings.json";
    if (has("/soccer/fifa.world/")) return "fifa-standings.json";
    if (has("/football/college-football/")) return "ncaaf-standings.json";
    return "nfl-standings.json";
  }
  if (has("/news")) return has("/soccer/eng.1/") ? "eng1-news.json" : "nfl-news.json";
  return null;
};
const fetchFn = (async (url: string) => {
  const file = fixtureFor(String(url));
  if (!file) {
    console.error("UNMAPPED", String(url));
    return new Response("{}", { status: 404 });
  }
  const body = readFileSync(new URL(file, dir), "utf8");
  return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
}) as unknown as typeof fetch;

interface Follow {
  competitionKey: string;
  teamKey: string | null;
  sourceTeamId: string | null;
}
const scenarios: { name: string; follows: Follow[]; urls: string[] }[] = [
  {
    name: "two competitions and a hockey club",
    follows: [
      { competitionKey: "eng.1", teamKey: "EVE", sourceTeamId: "368" },
      { competitionKey: "uefa.champions", teamKey: "EVE", sourceTeamId: "368" },
      { competitionKey: "nhl", teamKey: "BOS", sourceTeamId: "1" },
      { competitionKey: "eng.1", teamKey: "BRE", sourceTeamId: "337" }
    ],
    urls: [
      "/api/sports/overview",
      "/api/sports/results/latest?competitionKey=nhl&sourceTeamId=1",
      "/api/sports/results/latest?competitionKey=eng.1&teamName=everton",
      "/api/sports/results/latest?teamName=boston"
    ]
  },
  {
    name: "a football club with a standing line",
    follows: [
      { competitionKey: "nfl", teamKey: "DAL", sourceTeamId: "6" },
      { competitionKey: "nfl", teamKey: null, sourceTeamId: null }
    ],
    urls: ["/api/sports/overview"]
  },
  {
    name: "no follows",
    follows: [],
    urls: [
      "/api/sports/overview",
      "/api/sports/standings?competitionKey=nfl",
      "/api/sports/standings?competitionKey=eng.1",
      "/api/sports/standings?competitionKey=fifa.world",
      "/api/sports/standings?competitionKey=nope",
      "/api/sports/results/latest"
    ]
  },
  {
    name: "whole league and a follow without an id",
    follows: [
      { competitionKey: "nhl", teamKey: null, sourceTeamId: null },
      { competitionKey: "eng.1", teamKey: "EVE", sourceTeamId: null }
    ],
    urls: ["/api/sports/overview"]
  }
];

const [source] = sportsModuleManifest.externalSources ?? [];
if (!source) throw new Error("missing espn source");
const out: unknown[] = [];
for (const scenario of scenarios) {
  const datasetClient = createDatasetClient(source, createEspnDatasetAdapter(), { fetchFn });
  const server = Fastify();
  setMossErrorHandler(server);
  // The table lists newest first, then by id.
  const rows = scenario.follows
    .map((f, i) => ({
      id: `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`,
      ...f,
      createdAt: `2026-11-11T10:00:${String(i).padStart(2, "0")}.000Z`
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  registerSportsRoutes(server, {
    resolveAccessContext: async () => ({
      actorUserId: "00000000-0000-4000-8000-0000000000ee",
      requestId: "parity"
    }),
    dataContext: {
      withDataContext: async (_a: unknown, run: (db: unknown) => unknown) => run({})
    } as never,
    repository: { list: async () => rows } as never,
    espnCoverageRepository: {
      get: async () => ({ enabled: true, usesDefaultCoverage: true, assignments: [] })
    } as never,
    datasetClient,
    discovery: {} as never,
    storyFeedback: {} as never,
    now: () => NOW
  } as never);
  for (const url of scenario.urls) {
    const result = await server.inject({ method: "GET", url });
    out.push({
      scenario: scenario.name,
      url,
      status: result.statusCode,
      body: result.json() as unknown
    });
  }
  await server.close();
}
console.log(JSON.stringify(out, null, 1));
