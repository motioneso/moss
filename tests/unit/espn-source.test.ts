import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createEspnDatasetAdapter,
  sanitizeArticleBody
} from "../../packages/sports/src/source/espn-source.js";

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL(`../../packages/sports/src/source/__fixtures__/${name}`, import.meta.url)
      ),
      "utf8"
    )
  );
}

const okFetch = (body: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

const adapter = createEspnDatasetAdapter();

function fetchDataset(datasetKey: string, params: Record<string, unknown>, fetchFn: typeof fetch) {
  return adapter.fetchDataset(datasetKey, params, { fetchFn });
}

describe("EspnDatasetAdapter", () => {
  it("parses a scoreboard into GameSummary[]", async () => {
    const games = (await fetchDataset(
      "scoreboard",
      { competitionKey: "nfl", day: "2026-01-04" },
      okFetch(fixture("nfl-scoreboard.json"))
    )) as {
      state: string;
      home: { teamKey: string; score: number | null; winner: boolean; scorers: string[] | null };
      away: { teamKey: string; scorers: string[] | null };
    }[];
    expect(games.length).toBeGreaterThan(0);
    expect(games[0]?.home.teamKey).toBeTypeOf("string");
    expect(games[0]?.home.teamKey).toBe("dal");
    expect(games[0]?.home.score).toBe(27);
    expect(games[0]?.home.winner).toBe(true);
    expect(games[0]?.away.teamKey).toBe("ne");
    expect(["pre", "live", "final"]).toContain(games[0]?.state);
    expect(games[0]?.state).toBe("final");
    // NFL carries neither field in a form that maps to "goals" — no scorers for any other sport.
    expect(games[0]?.home.scorers).toBeNull();
    expect(games[0]?.away.scorers).toBeNull();
  });

  it("parses soccer scoring plays into each side's tallied goal scorers", async () => {
    const event = {
      id: "1",
      date: "2026-01-04T00:00:00Z",
      competitions: [
        {
          competitors: [
            { homeAway: "home", team: { id: "100", abbreviation: "MIN" } },
            { homeAway: "away", team: { id: "200", abbreviation: "DAL" } }
          ],
          status: { type: { state: "post", detail: "Full Time" } },
          details: [
            {
              type: { text: "Goal" },
              team: { id: "100" },
              athletesInvolved: [{ shortName: "A. Isak" }]
            },
            {
              type: { text: "Goal" },
              team: { id: "100" },
              athletesInvolved: [{ shortName: "A. Isak" }]
            },
            {
              type: { text: "Goal" },
              team: { id: "200" },
              athletesInvolved: [{ shortName: "Z. Benson" }]
            },
            // Non-goal scoring plays (e.g. a card) must not be counted as a scorer.
            {
              type: { text: "Yellow Card" },
              team: { id: "200" },
              athletesInvolved: [{ shortName: "X" }]
            }
          ]
        }
      ]
    };
    const games = (await fetchDataset(
      "scoreboard",
      { competitionKey: "usa.1", day: "2026-01-04" },
      okFetch({ events: [event] })
    )) as { home: { scorers: string[] | null }; away: { scorers: string[] | null } }[];
    expect(games[0]?.home.scorers).toEqual(["A. Isak (2)"]);
    expect(games[0]?.away.scorers).toEqual(["Z. Benson"]);
  });

  it("parses hockey goal leaders into each side's scorers", async () => {
    const event = {
      id: "1",
      date: "2026-01-04T00:00:00Z",
      competitions: [
        {
          competitors: [
            {
              homeAway: "home",
              team: { id: "100", abbreviation: "DAL" },
              leaders: [
                {
                  name: "goals",
                  leaders: [
                    { displayValue: "1", athlete: { shortName: "Z. Benson" } },
                    { displayValue: "1", athlete: { shortName: "T. Hintz" } }
                  ]
                }
              ]
            },
            { homeAway: "away", team: { id: "200", abbreviation: "MIN" } }
          ],
          status: { type: { state: "post", detail: "Final" } }
        }
      ]
    };
    const games = (await fetchDataset(
      "scoreboard",
      { competitionKey: "nhl", day: "2026-01-04" },
      okFetch({ events: [event] })
    )) as { home: { scorers: string[] | null }; away: { scorers: string[] | null } }[];
    // Dallas scored 4 goals in the real game this fixture is modeled on but ESPN's own "goal
    // leaders" list only carries these two distinct scorers — that gap is expected here.
    expect(games[0]?.home.scorers).toEqual(["Z. Benson", "T. Hintz"]);
    expect(games[0]?.away.scorers).toBeNull();
  });

  it("throws a typed error on non-200 (caller degrades)", async () => {
    const failFetch = (async () =>
      new Response("nope", { status: 503 })) as unknown as typeof fetch;
    await expect(
      fetchDataset("scoreboard", { competitionKey: "nfl", day: "2026-01-04" }, failFetch)
    ).rejects.toThrow(/ESPN/);
  });

  it("rejects an unknown competition before fetching", async () => {
    await expect(
      fetchDataset("scoreboard", { competitionKey: "cricket.ipl", day: "2026-01-04" }, okFetch({}))
    ).rejects.toThrow(/unknown competition/i);
  });

  it("rejects an unknown dataset key", async () => {
    await expect(fetchDataset("nonsense", { competitionKey: "nfl" }, okFetch({}))).rejects.toThrow(
      /unknown dataset/i
    );
  });

  it("parses soccer standings as a single labelled-null section", async () => {
    const table = (await fetchDataset(
      "standings",
      { competitionKey: "eng.1" },
      okFetch(fixture("eng1-standings.json"))
    )) as { sections: { label: string | null; rows: unknown[] }[] };
    expect(table.sections).toHaveLength(1);
    expect(table.sections[0]?.label).toBeNull();
    expect(table.sections[0]?.rows[0]).toMatchObject({
      teamKey: "ars",
      rank: 1,
      points: 46,
      wins: 14,
      losses: 2,
      draws: 4,
      winPercent: null,
      qualifies: true,
      qualificationNote: "UEFA Champions League",
      qualificationColor: "#2a66d1"
    });
    expect((table.sections[0]?.rows[1] as { qualifies: boolean }).qualifies).toBe(false);
  });

  it("repairs ESPN's malformed note colors and nulls unparseable ones (mrb4sa8y)", async () => {
    // ESPN's live Premier League feed ships the Europa League note color as "##B5E7CE"
    // (double hash, seen 2026-07-07). Raw, it invalidates the row's color-mix() tint, so the
    // Europa zone silently rendered with no highlight at all. The adapter must normalize the
    // hash and reject anything that still isn't a hex color (inline-style safety too).
    const base = fixture("eng1-standings.json") as {
      children: { standings: { entries: { note?: unknown }[] } }[];
    };
    const doctored = structuredClone(base);
    const entries = doctored.children[0]!.standings.entries;
    entries[0]!.note = { description: "Europa League", color: "##B5E7CE" };
    entries[1]!.note = { description: "Relegation", color: "url(javascript:alert(1))" };
    const table = (await fetchDataset(
      "standings",
      { competitionKey: "eng.1" },
      okFetch(doctored)
    )) as { sections: { rows: { qualificationColor: string | null }[] }[] };
    expect(table.sections[0]?.rows[0]?.qualificationColor).toBe("#B5E7CE");
    expect(table.sections[0]?.rows[1]?.qualificationColor).toBeNull();
  });

  it("keeps every tournament group as its own section", async () => {
    const table = (await fetchDataset(
      "standings",
      { competitionKey: "fifa.world" },
      okFetch(fixture("fifa-standings.json"))
    )) as { sections: { label: string | null; rows: { qualifies: boolean }[] }[] };
    expect(table.sections.map((s) => s.label)).toEqual(["Group A", "Group B"]);
    expect(table.sections[0]?.rows[0]?.qualifies).toBe(true);
  });

  it("parses record-league conferences with winPercent", async () => {
    const table = (await fetchDataset(
      "standings",
      { competitionKey: "nfl" },
      okFetch(fixture("nfl-standings.json"))
    )) as {
      sections: { label: string | null; rows: Record<string, unknown>[] }[];
    };
    expect(table.sections.map((s) => s.label)).toEqual([
      "American Football Conference",
      "National Football Conference"
    ]);
    expect(table.sections[1]?.rows[0]).toMatchObject({
      teamKey: "dal",
      wins: 10,
      losses: 2,
      winPercent: 0.833,
      points: null
    });
  });

  // Live ?level=3 division entries carry no "rank" stat but arrive standings-sorted; the
  // parser must fall back to the entry order or every US-league row ranks 0 and the web
  // guard hides the whole standing line (live feedback mraxrdxr, mraz6m43).
  it("falls back to entry order for rank when the rank stat is absent", async () => {
    const division = (wins: number) => ({
      stats: [
        { name: "wins", value: wins },
        { name: "losses", value: 12 - wins },
        { name: "winPercent", value: wins / 12 }
      ]
    });
    const payload = {
      name: "National Football League",
      children: [
        {
          name: "American Football Conference",
          children: [
            {
              name: "AFC East",
              standings: {
                entries: [
                  {
                    team: { abbreviation: "NE", displayName: "New England Patriots" },
                    ...division(10)
                  },
                  { team: { abbreviation: "BUF", displayName: "Buffalo Bills" }, ...division(8) }
                ]
              }
            }
          ]
        }
      ]
    };
    const table = (await fetchDataset(
      "standings",
      { competitionKey: "nfl" },
      okFetch(payload)
    )) as {
      sections: { label: string | null; conference: string | null; rows: { rank: number }[] }[];
    };
    expect(table.sections[0]?.label).toBe("AFC East");
    expect(table.sections[0]?.conference).toBe("American Football Conference");
    expect(table.sections[0]?.rows.map((r) => r.rank)).toEqual([1, 2]);
  });

  // College football ?level=3 entries carry "wins" and an "overall" record string but no
  // "losses"/"winPercent" stat at all (verified live 2026-09-03); the parser must read the
  // record string or every FBS team shows as undefeated.
  it("reads losses from the overall record when ESPN omits the losses stat (college football)", async () => {
    const payload = {
      name: "NCAA Football",
      children: [
        {
          name: "Big Ten Conference",
          standings: {
            entries: [
              {
                team: { abbreviation: "OSU", displayName: "Ohio State Buckeyes" },
                stats: [
                  { name: "wins", value: 10, displayValue: "10" },
                  { name: "overall", displayValue: "10-2" }
                ]
              },
              {
                team: { abbreviation: "PSU", displayName: "Penn State Nittany Lions" },
                stats: [{ name: "overall", displayValue: "9-3-1" }]
              }
            ]
          }
        }
      ]
    };
    const table = (await fetchDataset(
      "standings",
      { competitionKey: "ncaaf" },
      okFetch(payload)
    )) as {
      sections: { label: string | null; rows: Record<string, unknown>[] }[];
    };
    expect(table.sections.map((s) => s.label)).toEqual(["Big Ten Conference"]);
    expect(table.sections[0]?.rows[0]).toMatchObject({
      teamKey: "osu",
      wins: 10,
      losses: 2,
      draws: null,
      winPercent: 10 / 12
    });
    expect(table.sections[0]?.rows[1]).toMatchObject({
      teamKey: "psu",
      wins: 9,
      losses: 3,
      draws: 1,
      winPercent: 9.5 / 13
    });
  });

  it("parses news into Headline[]", async () => {
    const headlines = (await fetchDataset(
      "headlines",
      { competitionKey: "nfl" },
      okFetch(fixture("nfl-news.json"))
    )) as { id: string; competitionKey: string; url: string; title: string }[];
    expect(headlines).toHaveLength(2);
    expect(headlines[0]).toMatchObject({
      id: "4567",
      competitionKey: "nfl",
      url: "https://www.espn.com/nfl/story/_/id/4567"
    });
    expect(headlines[0]?.title).toContain("Cowboys");
  });

  it("parses teams into TeamRef[]", async () => {
    const teams = (await fetchDataset(
      "teams",
      { competitionKey: "nfl" },
      okFetch(fixture("nfl-teams.json"))
    )) as {
      teamKey: string;
      competitionKey: string;
      name: string;
      shortName: string;
      crestUrl: string | null;
    }[];
    expect(teams).toHaveLength(2);
    expect(teams[0]).toMatchObject({
      teamKey: "dal",
      competitionKey: "nfl",
      name: "Dallas Cowboys",
      shortName: "Cowboys"
    });
    expect(teams[0]?.crestUrl).toContain("dal.png");
  });

  it("parses news images and provider team tags", async () => {
    const headlines = (await fetchDataset(
      "headlines",
      { competitionKey: "nfl" },
      okFetch(fixture("nfl-news.json"))
    )) as { imageUrl: string | null; sourceTeamIds: string[]; teamKeys: string[] }[];
    expect(headlines[0]?.imageUrl).toBe("https://a.espncdn.com/photo/2026/0104/cowboys-header.jpg");
    expect(headlines[0]?.sourceTeamIds).toEqual(["6"]);
    expect(headlines[0]?.teamKeys).toEqual([]); // the service fills these, not the source
    expect(headlines[1]?.imageUrl).toBeNull();
    expect(headlines[1]?.sourceTeamIds).toEqual([]);
  });

  it("carries the provider team id on listTeams", async () => {
    const teams = (await fetchDataset(
      "teams",
      { competitionKey: "nfl" },
      okFetch(fixture("nfl-teams.json"))
    )) as { sourceTeamId: string | null }[];
    expect(teams[0]?.sourceTeamId).toBe("6");
  });

  it("passes the schedule params through to the teams/competition-scoped endpoint", async () => {
    const games = (await fetchDataset(
      "schedule",
      { teamKey: "dal", competitionKey: "nfl" },
      okFetch(fixture("nfl-scoreboard.json"))
    )) as { competitionKey: string }[];
    expect(games.length).toBeGreaterThan(0);
    expect(games[0]?.competitionKey).toBe("nfl");
  });

  // Soccer schedule URLs only resolve numeric team ids — the abbreviation slug returns an
  // empty payload, which nulled form/next-match on every soccer card (live feedback mrawhx9c).
  it("prefers sourceTeamId over teamKey in the schedule URL when present", async () => {
    const urls: string[] = [];
    const spyFetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ events: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    await fetchDataset(
      "schedule",
      { teamKey: "sd", competitionKey: "usa.1", sourceTeamId: "22529" },
      spyFetch
    );
    await fetchDataset("schedule", { teamKey: "dal", competitionKey: "nfl" }, spyFetch);
    expect(urls[0]).toContain("/teams/22529/schedule");
    expect(urls[1]).toContain("/teams/dal/schedule"); // no id → abbreviation fallback
  });

  // The same slug trap on the NEWS endpoint, which went unfixed when the schedule one was found:
  // /soccer/eng.1/news?team=ars answers HTTP 400 (verified live 2026-08-01) while ?team=359 returns
  // that club's stories, so every soccer card fell back to an empty team feed and read "No recent
  // news" mid-season (Ben /sports feedback 2026-08-01). US leagues take either form.
  it("prefers sourceTeamId over teamKey in the news query when present", async () => {
    const urls: string[] = [];
    const spyFetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ articles: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    await fetchDataset(
      "headlines",
      { teamKey: "ars", competitionKey: "eng.1", sourceTeamId: "359" },
      spyFetch
    );
    await fetchDataset("headlines", { teamKey: "sf", competitionKey: "mlb" }, spyFetch);
    await fetchDataset("headlines", { competitionKey: "nfl" }, spyFetch);
    expect(urls[0]).toContain("/news?team=359");
    expect(urls[1]).toContain("/news?team=sf"); // no id → abbreviation fallback
    expect(urls[2]).not.toContain("?team="); // league-wide feed keeps no filter at all
  });

  // #1265 security QA BLOCKING-1(c): the schedule path segment is the outbound sink for a team
  // key that originates in an assistant tool call. Two earlier belts (roster validation in
  // SportsService.followTeam, length+pattern bounds on the tool input schema) should mean nothing
  // exotic ever reaches here — this is the third, independent one, so it is asserted on its own
  // terms rather than on the assumption that the others held. Matches what getHeadlines already
  // does for its query-string use of teamKey.
  it("percent-encodes the schedule path key so it cannot escape its URL segment", async () => {
    const urls: string[] = [];
    const spyFetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ events: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    await fetchDataset("schedule", { teamKey: "../../../evil", competitionKey: "nfl" }, spyFetch);
    expect(urls[0]).toContain("/teams/..%2F..%2F..%2Fevil/schedule");
    expect(urls[0]).not.toContain("/teams/../");

    // Same for the numeric-id branch, which is the one production actually takes for soccer.
    await fetchDataset(
      "schedule",
      { teamKey: "sd", competitionKey: "usa.1", sourceTeamId: "22529/../../evil" },
      spyFetch
    );
    expect(urls[1]).toContain("22529%2F..%2F..%2Fevil");
  });

  // The /schedule endpoint wraps score in { value, displayValue } (the scoreboard sends a plain
  // string); Number({...}) is NaN, which nulled schedule scores and made soccer draws read as
  // losses in the form pips (live feedback mrawhx9c).
  it("parses object-shaped schedule scores", async () => {
    const drawEvent = {
      events: [
        {
          id: "1",
          date: "2026-07-01T00:00Z",
          competitions: [
            {
              status: { type: { state: "post", detail: "FT" } },
              competitors: [
                {
                  homeAway: "home",
                  winner: false,
                  score: { value: 2, displayValue: "2" },
                  team: { abbreviation: "SD", displayName: "San Diego FC" }
                },
                {
                  homeAway: "away",
                  winner: false,
                  score: { value: 2, displayValue: "2" },
                  team: {
                    abbreviation: "LAFC",
                    displayName: "LAFC",
                    // schedule payloads carry a `logos` array, not the scoreboard's flat
                    // `logo` — the crest must still come through (live feedback mrawvc48)
                    logos: [{ href: "https://a.espncdn.com/i/teamlogos/soccer/500/lafc.png" }]
                  }
                }
              ]
            }
          ]
        }
      ]
    };
    const games = (await fetchDataset(
      "schedule",
      { teamKey: "sd", competitionKey: "usa.1", sourceTeamId: "22529" },
      okFetch(drawEvent)
    )) as {
      home: { score: number | null };
      away: { score: number | null; crestUrl: string | null };
    }[];
    expect(games[0]?.home.score).toBe(2);
    expect(games[0]?.away.score).toBe(2);
    expect(games[0]?.away.crestUrl).toBe("https://a.espncdn.com/i/teamlogos/soccer/500/lafc.png");
  });

  // --- Featured-article body (#857) --------------------------------------------------------

  it("sanitizes ESPN story HTML down to plaintext with zero surviving markup", () => {
    // The core injection mitigation: after sanitize there must be NO tags and NO `<photoN>`
    // tokens left, and entities must be decoded — because the web tier renders this as text.
    const body = sanitizeArticleBody(
      (fixture("nfl-article.json") as { headlines: { story: string }[] }).headlines[0]!.story
    );
    expect(body).not.toMatch(/[<>]/); // no tags, no <photo1> token survives
    expect(body).not.toContain("photo1");
    expect(body).toContain("Cowboys");
    expect(body).toContain("27–17 win"); // &ndash; decoded
    expect(body).toContain("“We earned this,”"); // &ldquo;/&rdquo; decoded
    expect(body).toContain("ESPN’s"); // &#39; decoded
    // First few <p> blocks joined on blank lines — the client splits on these.
    expect(body.split("\n\n").length).toBeGreaterThanOrEqual(2);
  });

  it("caps an over-long body at a word boundary with an ellipsis", () => {
    const longStory = `<p>${"word ".repeat(400).trim()}</p>`;
    const body = sanitizeArticleBody(longStory);
    expect(body.length).toBeLessThanOrEqual(901); // ~900 cap + the ellipsis char
    expect(body.endsWith("…")).toBe(true);
    // Clipped on a word boundary: the token before the ellipsis is a whole "word", never a
    // fragment like "wor…" — so dropping the ellipsis leaves complete words.
    expect(body.slice(0, -1).trimEnd().endsWith("word")).toBe(true);
  });

  it("returns empty string for absent/empty story", () => {
    expect(sanitizeArticleBody(undefined)).toBe("");
    expect(sanitizeArticleBody("")).toBe("");
    expect(sanitizeArticleBody("<photo1>")).toBe(""); // token-only body → nothing to show
  });

  it("fetches the featured article body from a URL derived from the numeric id", async () => {
    const urls: string[] = [];
    const spyFetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify(fixture("nfl-article.json")), { status: 200 });
    }) as unknown as typeof fetch;
    const body = (await fetchDataset("articleBody", { articleId: "4567" }, spyFetch)) as string;
    // URL is built from the id on the content host — never from a response-supplied href (SSRF).
    expect(urls[0]).toBe("https://content.core.api.espn.com/v1/sports/news/4567");
    expect(body).toContain("Cowboys");
  });

  it("rejects a non-numeric or too-short article id without fetching (SSRF/index-fallback guard)", async () => {
    for (const badId of ["", "3", "12", "abc", "45x", "../secrets", "4567?x=1"]) {
      let called = false;
      const spyFetch = (async () => {
        called = true;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch;
      const body = (await fetchDataset("articleBody", { articleId: badId }, spyFetch)) as string;
      expect(body).toBe("");
      expect(called).toBe(false);
    }
  });

  it("degrades to empty string when the body fetch fails (never blocks the overview)", async () => {
    const failFetch = (async () =>
      new Response("nope", { status: 404 })) as unknown as typeof fetch;
    const body = (await fetchDataset("articleBody", { articleId: "9999999" }, failFetch)) as string;
    expect(body).toBe("");
  });
});
