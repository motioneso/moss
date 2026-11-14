// Writes tests/fixtures/golden.json: what the old ESPN reader returns for each recorded fixture.
// The Rust parsers must produce the same JSON. Run: tsx tools/espn-golden.ts > tests/fixtures/golden.json
import { readFileSync } from "node:fs";
import { createEspnDatasetAdapter } from "../../../packages/sports/src/source/espn-source.js";

const dir = new URL("../tests/fixtures/", import.meta.url);
const load = (name: string): unknown => JSON.parse(readFileSync(new URL(name, dir), "utf8"));

const cases: { name: string; dataset: string; params: Record<string, unknown>; fixture: string }[] =
  [
    {
      name: "teams-nfl",
      dataset: "teams",
      params: { competitionKey: "nfl" },
      fixture: "nfl-teams.json"
    },
    {
      name: "teams-eng.1",
      dataset: "teams",
      params: { competitionKey: "eng.1" },
      fixture: "eng1-teams.json"
    },
    {
      name: "teams-ncaa-baseball",
      dataset: "teams",
      params: { competitionKey: "ncaa-baseball" },
      fixture: "ncaa-baseball-teams-subset.json"
    },
    {
      name: "scoreboard-nfl",
      dataset: "scoreboard",
      params: { competitionKey: "nfl", day: "2025-09-07" },
      fixture: "nfl-scoreboard.json"
    },
    {
      name: "scoreboard-eng.1",
      dataset: "scoreboard",
      params: { competitionKey: "eng.1", day: "2026-01-04" },
      fixture: "eng1-scoreboard-20260104-everton-brentford.json"
    },
    {
      name: "scoreboard-nhl",
      dataset: "scoreboard",
      params: { competitionKey: "nhl", day: "2026-11-12" },
      fixture: "nhl-scoreboard-20261112.json"
    },
    {
      name: "standings-nfl",
      dataset: "standings",
      params: { competitionKey: "nfl" },
      fixture: "nfl-standings.json"
    },
    {
      name: "standings-eng.1",
      dataset: "standings",
      params: { competitionKey: "eng.1" },
      fixture: "eng1-standings.json"
    },
    {
      name: "standings-fifa.world",
      dataset: "standings",
      params: { competitionKey: "fifa.world" },
      fixture: "fifa-standings.json"
    },
    {
      name: "standings-ncaaf",
      dataset: "standings",
      params: { competitionKey: "ncaaf" },
      fixture: "ncaaf-standings.json"
    },
    {
      name: "headlines-nfl",
      dataset: "headlines",
      params: { competitionKey: "nfl" },
      fixture: "nfl-news.json"
    },
    {
      name: "headlines-eng.1",
      dataset: "headlines",
      params: { competitionKey: "eng.1" },
      fixture: "eng1-news.json"
    }
  ];

const adapter = createEspnDatasetAdapter();
const out: Record<string, unknown> = {};
for (const c of cases) {
  const body = load(c.fixture);
  const fetchFn = (async () => ({
    ok: true,
    status: 200,
    json: async () => body
  })) as unknown as typeof fetch;
  out[c.name] = await adapter.fetchDataset(c.dataset, c.params, { fetchFn } as never);
}
console.log(JSON.stringify(out, null, 1));
