import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import SportsSettings, {
  BrowseGroups,
  createFollow,
  deleteFollow,
  followControlState,
  followFor,
  indexFollows,
  leagueMatches,
  searchLeagueRows,
  SearchResults
} from "../../packages/sports/src/settings/index.js";
import { AddSourceFlow, SportsSourcesSection } from "../../packages/sports/src/settings/sources.js";
import { SourceAssignmentPicker } from "../../packages/sports/src/settings/source-assignment-picker.js";
import { sportsQueryKeys } from "../../packages/sports/src/web/query-keys.js";

const CATALOG_KEY = ["sports", "catalog"] as const;
const FOLLOWS_KEY = ["sports", "follows"] as const;

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function renderWithQuery(client: QueryClient): string {
  return renderToString(
    createElement(QueryClientProvider, { client }, createElement(SportsSettings))
  );
}

type TeamRefLite = {
  readonly teamKey: string;
  readonly competitionKey: string;
  readonly name: string;
  readonly shortName: string;
  readonly crestUrl: string | null;
  readonly sourceTeamId: string | null;
};
// Mirrors the static catalog contract (#907 Task 6): no `teams` field — the pane resolves
// rosters via the lazy leagueTeams query instead, seeded per-test below where needed.
type CompetitionLite = {
  readonly competitionKey: string;
  readonly label: string;
  readonly sportLabel: string;
  readonly regionLabel: string | null;
  readonly kind: "league" | "tournament";
  readonly marquee: boolean;
  readonly standingsShape: "table" | "groups" | "record";
  readonly confederation: "INTL" | "UEFA" | "CONCACAF" | "CONMEBOL" | "AFC" | "CAF" | "OFC";
};

const DAL: TeamRefLite = {
  teamKey: "dal",
  competitionKey: "nfl",
  name: "Dallas Cowboys",
  shortName: "DAL",
  crestUrl: null,
  sourceTeamId: "id-dal"
};
const ARS: TeamRefLite = {
  teamKey: "team.ars",
  competitionKey: "epl",
  name: "Arsenal",
  shortName: "ARS",
  crestUrl: null,
  sourceTeamId: "id-team.ars"
};

const TWO_LEAGUES: readonly CompetitionLite[] = [
  {
    competitionKey: "nfl",
    label: "NFL",
    sportLabel: "Football",
    regionLabel: null,
    kind: "league",
    marquee: false,
    standingsShape: "record",
    confederation: "INTL"
  },
  {
    competitionKey: "epl",
    label: "Premier League",
    sportLabel: "Soccer",
    regionLabel: "England",
    kind: "league",
    marquee: false,
    standingsShape: "table",
    confederation: "UEFA"
  }
];

describe("SportsSettings", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders search input when query is empty, with browse leagues collapsed", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(CATALOG_KEY, { competitions: TWO_LEAGUES, degraded: false });
    client.setQueryData(FOLLOWS_KEY, { follows: [] });
    const html = renderWithQuery(client);
    expect(html).toContain("sp-search__input");
    // ...and the old flat search hint is gone.
    expect(html).not.toContain("Search above to find teams or leagues to follow.");
  });

  it("renders absent standings preferences as all selected and explicit empty as none", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(CATALOG_KEY, { competitions: TWO_LEAGUES, degraded: false });
    client.setQueryData(FOLLOWS_KEY, { follows: [] });
    let html = renderWithQuery(client);
    expect(html).toContain("Configure standings");
    expect(html).toContain("Football");
    expect(html).toContain("England");
    const leagueBox = (markup: string, key: string) =>
      markup.match(new RegExp(`<input[^>]*value="${key}"[^>]*>`))?.[0] ?? "";
    expect(leagueBox(html, "nfl")).toContain('checked=""');
    // Soccer leagues sit under their country and stay hidden until the row is opened.
    expect(leagueBox(html, "epl")).toContain('checked=""');
    expect(html).toContain('aria-label="All England leagues"');
    expect(html).toMatch(
      /aria-expanded="false"[^>]*aria-controls="sp-standings-region-soccer-england"/
    );

    client.setQueryData(sportsQueryKeys.standingsPreferences, {
      selectedCompetitionKeys: []
    });
    html = renderWithQuery(client);
    expect(leagueBox(html, "nfl")).not.toContain('checked=""');
    expect(leagueBox(html, "epl")).not.toContain('checked=""');
    expect(html).toContain(">0<!-- --> of <!-- -->2<");
  });

  it("renders only active Sports story preferences with stored story details", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(CATALOG_KEY, { competitions: TWO_LEAGUES, degraded: false });
    client.setQueryData(FOLLOWS_KEY, { follows: [] });
    client.setQueryData(["sports", "story-feedback"], {
      feedback: [
        {
          id: "sports-1",
          ownerUserId: "owner-1",
          targetKind: "sports_story",
          targetRef: "sports-ref-1",
          surface: "sports",
          kind: "less_like_this",
          sourceKind: null,
          sourceLabel: null,
          priorityBand: null,
          effectKind: null,
          effectRef: null,
          metadata: { headline: "Cowboys clinch the NFC East", sourceLabel: "ESPN" },
          status: "active",
          reason: "Not useful today",
          revision: 1,
          ruleVersion: 1,
          createdAt: "2026-08-27T12:00:00.000Z",
          updatedAt: "2026-08-27T12:00:00.000Z",
          resolvedAt: null
        },
        {
          id: "news-1",
          ownerUserId: "owner-1",
          targetKind: "news_story",
          targetRef: "news-ref-1",
          surface: "news",
          kind: "less_like_this",
          sourceKind: null,
          sourceLabel: null,
          priorityBand: null,
          effectKind: null,
          effectRef: null,
          metadata: { headline: "News must stay out" },
          status: "active",
          reason: "No",
          revision: 1,
          ruleVersion: 1,
          createdAt: "2026-08-27T12:00:00.000Z",
          updatedAt: "2026-08-27T12:00:00.000Z",
          resolvedAt: null
        }
      ]
    });

    const html = renderWithQuery(client);
    expect(html).toContain("Story preferences");
    expect(html).toContain("Less");
    expect(html).toContain("Cowboys clinch the NFC East");
    expect(html).toContain("ESPN");
    expect(html).toContain("Not useful today");
    expect(html).toContain(
      "A major story about a subject you asked to see less of may still appear."
    );
    expect(html).not.toContain("News must stay out");
  });

  it("renders persisted source health truthfully with recovery actions", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(sportsQueryKeys.sources, {
      sources: [
        {
          kind: "custom",
          id: "11111111-1111-1111-1111-111111111111",
          label: "Drifted publisher",
          canonicalDomain: "publisher.example.com",
          homepageUrl: "https://publisher.example.com/",
          feedUrl: null,
          retrievalMethod: "scrape",
          enabled: true,
          healthState: "pending",
          healthReasonCode: "recipe_drift",
          healthMessage: "The publisher changed its public response shape.",
          lastCheckedAt: null,
          lastSuccessAt: null,
          recipeStatus: "drift",
          assignedFollowIds: ["22222222-2222-2222-2222-222222222222"],
          assignments: [
            {
              id: "33333333-3333-3333-3333-333333333333",
              followId: "22222222-2222-2222-2222-222222222222",
              sportKey: null,
              targetUrl: null,
              previewStatus: "pending",
              healthState: "pending",
              healthReasonCode: null,
              healthMessage: null,
              lastCheckedAt: null,
              lastSuccessAt: null,
              createdAt: "2026-08-24T12:00:00.000Z"
            },
            {
              id: "55555555-5555-5555-5555-555555555555",
              followId: null,
              sportKey: "soccer",
              targetUrl: "https://publisher.example.com/soccer",
              previewStatus: "verified",
              healthState: "healthy",
              healthReasonCode: null,
              healthMessage: null,
              lastCheckedAt: "2026-08-24T12:00:00.000Z",
              lastSuccessAt: "2026-08-24T12:00:00.000Z",
              createdAt: "2026-08-24T12:00:00.000Z"
            }
          ],
          createdAt: "2026-08-24T12:00:00.000Z"
        },
        {
          kind: "custom",
          id: "44444444-4444-4444-4444-444444444444",
          label: "Private publisher",
          canonicalDomain: "private.example.com",
          homepageUrl: "https://private.example.com/",
          feedUrl: "https://private.example.com/feed.xml",
          retrievalMethod: "feed",
          enabled: true,
          healthState: "auth_required",
          healthReasonCode: "auth_required",
          healthMessage: null,
          lastCheckedAt: "2026-08-24T12:00:00.000Z",
          lastSuccessAt: null,
          recipeStatus: "feed",
          assignedFollowIds: [],
          assignments: [],
          createdAt: "2026-08-24T12:00:00.000Z"
        }
      ]
    });

    const html = renderToString(
      createElement(
        QueryClientProvider,
        { client },
        createElement(SportsSourcesSection, {
          follows: [
            {
              id: "22222222-2222-2222-2222-222222222222",
              competitionKey: "nfl",
              teamKey: null,
              sourceTeamId: null,
              createdAt: "2026-08-24T12:00:00.000Z"
            }
          ],
          competitionsByKey: new Map([["nfl", TWO_LEAGUES[0]!]]),
          teamsByCompetition: new Map()
        })
      )
    );

    expect(html).toContain("Awaiting first check");
    expect(html).toContain("All NFL");
    expect(html).toContain("Soccer");
    expect(html).toContain("sp-src__assignment-identity");
    expect(html).toContain("The publisher changed its public response shape.");
    expect(html).toContain(">Retry<");
    expect(html).toContain(">Rebuild<");
    expect(html).toContain("Authenticated sources are not supported yet.");
    expect(html).not.toContain("https://publisher.example.com/soccer");
    expect(html).not.toContain("Last checked:");
    expect(html).not.toContain("Checking…");
  });

  it("uses the shared checkbox primitive for source assignments", () => {
    const html = renderToString(
      createElement(SourceAssignmentPicker, {
        follows: [
          {
            id: "22222222-2222-2222-2222-222222222222",
            competitionKey: "nfl",
            teamKey: null,
            sourceTeamId: null,
            createdAt: "2026-08-24T12:00:00.000Z"
          }
        ],
        competitionsByKey: new Map(),
        teamsByCompetition: new Map(),
        selected: new Set<string>(),
        onToggle: () => {},
        idPrefix: "sp-test-assign"
      })
    );

    expect(html).toContain('class="jds-check sp-src__check"');
    expect(html).toContain('class="jds-check__box"');
  });

  it("add-source coverage picker stays hidden until a publication is entered (Ben, 2026-09-03)", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const html = renderToString(
      createElement(
        QueryClientProvider,
        { client },
        createElement(AddSourceFlow, {
          follows: [
            {
              id: "22222222-2222-2222-2222-222222222222",
              competitionKey: "nfl",
              teamKey: null,
              sourceTeamId: null,
              createdAt: "2026-08-24T12:00:00.000Z"
            }
          ],
          competitionsByKey: new Map(),
          teamsByCompetition: new Map()
        })
      )
    );

    expect(html).toContain('id="sp-addsource-input"');
    expect(html).not.toContain("sp-addsource-assign");
    expect(html).not.toContain("Coverage (optional");
  });

  it("empty-query view starts with browse leagues collapsed, not the full catalog", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(CATALOG_KEY, { competitions: TWO_LEAGUES, degraded: false });
    client.setQueryData(FOLLOWS_KEY, { follows: [] });
    const html = renderWithQuery(client);
    expect(html).toContain("Browse leagues");
    expect(html).toContain('aria-expanded="false"');
    // The confederation catalog itself must not render until expanded.
    expect(html).not.toContain("US majors &amp; global");
    expect(html).not.toContain('id="sp-browse-panel"');
  });

  it("keeps a delayed failed POST local to the named team target", async () => {
    const response = deferred<Response>();
    const fetchMock = vi.fn(() => response.promise);
    vi.stubGlobal("fetch", fetchMock);

    const request = createFollow({ competitionKey: "epl", teamKey: ARS.teamKey });
    let settled = false;
    void request.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sports/follows",
      expect.objectContaining({ method: "POST" })
    );

    const pendingHtml = renderToString(
      createElement(SearchResults, {
        query: "ars",
        results: [ARS, DAL],
        partial: false,
        isError: false,
        competitions: TWO_LEAGUES,
        followsByKey: new Map(),
        onToggle: () => {},
        onRetry: () => {},
        actionState: {
          competitionKey: "epl",
          teamKey: ARS.teamKey,
          label: ARS.name,
          direction: "follow",
          phase: "pending",
          source: "picker"
        }
      })
    );
    expect(pendingHtml).toContain("Following…");
    expect(pendingHtml).toContain('aria-label="Follow Dallas Cowboys"');

    response.resolve(
      new Response(JSON.stringify({ message: "Follow failed" }), {
        status: 500,
        headers: { "content-type": "application/json" }
      })
    );
    await expect(request).rejects.toThrow("Follow failed");

    const errorHtml = renderToString(
      createElement(SearchResults, {
        query: "ars",
        results: [ARS, DAL],
        partial: false,
        isError: false,
        competitions: TWO_LEAGUES,
        followsByKey: new Map(),
        onToggle: () => {},
        onRetry: () => {},
        actionState: {
          competitionKey: "epl",
          teamKey: ARS.teamKey,
          label: ARS.name,
          direction: "follow",
          phase: "error",
          source: "picker"
        }
      })
    );
    expect(errorHtml).toContain('aria-label="Follow Arsenal"');
    expect(errorHtml).toContain("Couldn’t follow Arsenal. Try again.");
    expect(errorHtml).toMatch(/sp-action-target[\s\S]*Follow Arsenal[\s\S]*sp-action-error/);
  });

  it("keeps a delayed failed DELETE local and retains the prior followed state", async () => {
    const response = deferred<Response>();
    const fetchMock = vi.fn(() => response.promise);
    vi.stubGlobal("fetch", fetchMock);

    const request = deleteFollow("follow-ars");
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sports/follows/follow-ars",
      expect.objectContaining({ method: "DELETE" })
    );
    response.resolve(
      new Response(JSON.stringify({ message: "Unfollow failed" }), {
        status: 500,
        headers: { "content-type": "application/json" }
      })
    );
    await expect(request).rejects.toThrow("Unfollow failed");

    const errorHtml = renderToString(
      createElement(SearchResults, {
        query: "ars",
        results: [ARS],
        partial: false,
        isError: false,
        competitions: TWO_LEAGUES,
        followsByKey: indexFollows([
          {
            id: "follow-ars",
            competitionKey: "epl",
            teamKey: ARS.teamKey,
            sourceTeamId: ARS.sourceTeamId,
            createdAt: "2026-01-01T00:00:00Z"
          }
        ]),
        onToggle: () => {},
        onRetry: () => {},
        actionState: {
          competitionKey: "epl",
          teamKey: ARS.teamKey,
          label: ARS.name,
          direction: "unfollow",
          phase: "error",
          source: "picker"
        }
      })
    );
    expect(errorHtml).toContain('aria-label="Unfollow Arsenal"');
    expect(errorHtml).toContain("Couldn’t unfollow Arsenal. Try again.");
    expect(errorHtml).toMatch(/sp-action-target[\s\S]*Unfollow Arsenal[\s\S]*sp-action-error/);
  });

  it("marks a followed team active", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(CATALOG_KEY, {
      competitions: [TWO_LEAGUES[1]],
      degraded: false
    });
    client.setQueryData(FOLLOWS_KEY, {
      follows: [
        {
          id: "f1",
          competitionKey: "epl",
          teamKey: "team.ars",
          sourceTeamId: "id-team.ars",
          createdAt: "2026-01-01T00:00:00Z"
        }
      ]
    });
    // Followed-chip roster resolution fetches the league's teams via the shared leagueTeams key
    // (#907 spec §4.3) — seed it so the chip can resolve "ARS" instead of falling back to the key.
    client.setQueryData(sportsQueryKeys.leagueTeams("epl"), { teams: [ARS], degraded: false });
    const html = renderWithQuery(client);
    // Followed team renders as a removable chip in the summary row.
    expect(html).toContain("sp-chip");
    expect(html).toContain("ARS");
  });

  it("renders a followed team's crest image in the summary chip when crestUrl exists", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const arsWithCrest = { ...ARS, crestUrl: "https://example.com/crests/ars.png" };
    client.setQueryData(CATALOG_KEY, {
      competitions: [TWO_LEAGUES[1]],
      degraded: false
    });
    client.setQueryData(FOLLOWS_KEY, {
      follows: [
        {
          id: "f1",
          competitionKey: "epl",
          teamKey: "team.ars",
          sourceTeamId: "id-team.ars",
          createdAt: "2026-01-01T00:00:00Z"
        }
      ]
    });
    client.setQueryData(sportsQueryKeys.leagueTeams("epl"), {
      teams: [arsWithCrest],
      degraded: false
    });
    const html = renderWithQuery(client);
    expect(html).toContain("sp-chip");
    expect(html).toContain('src="https://example.com/crests/ars.png"');
  });

  it("renders followed-team summary chips when follows exist", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(CATALOG_KEY, { competitions: TWO_LEAGUES, degraded: false });
    client.setQueryData(FOLLOWS_KEY, {
      follows: [
        {
          id: "f1",
          competitionKey: "epl",
          teamKey: "team.ars",
          sourceTeamId: "id-team.ars",
          createdAt: "2026-01-01T00:00:00Z"
        }
      ]
    });
    client.setQueryData(sportsQueryKeys.leagueTeams("epl"), { teams: [ARS], degraded: false });
    const html = renderWithQuery(client);
    expect(html).toContain("sp-summary");
    expect(html).toContain("sp-chip");
    expect(html).toContain("ARS");
    // removable affordance present
    expect(html).toContain("sp-chip__remove");
  });

  it("renders a whole-league follow as an All-league chip", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(CATALOG_KEY, { competitions: TWO_LEAGUES, degraded: false });
    client.setQueryData(FOLLOWS_KEY, {
      follows: [
        {
          id: "fl",
          competitionKey: "nfl",
          teamKey: null,
          sourceTeamId: null,
          createdAt: "2026-01-01T00:00:00Z"
        }
      ]
    });
    const html = renderWithQuery(client);
    expect(html).toContain("All NFL");
  });

  it("renders an orphan follow (unknown competitionKey) with a notice instead of a raw key", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(CATALOG_KEY, { competitions: TWO_LEAGUES, degraded: false });
    client.setQueryData(FOLLOWS_KEY, {
      follows: [
        {
          id: "orphan1",
          competitionKey: "xyz.retired",
          teamKey: null,
          sourceTeamId: null,
          createdAt: "2026-01-01T00:00:00Z"
        }
      ]
    });
    const html = renderWithQuery(client);
    expect(html).toContain("Unrecognized league (xyz.retired)");
    // still removable
    expect(html).toContain("sp-chip__remove");
  });

  it("leagueMatches returns competitions whose label matches the query", () => {
    expect(leagueMatches("prem", TWO_LEAGUES).map((c) => c.competitionKey)).toEqual(["epl"]);
    expect(leagueMatches("nfl", TWO_LEAGUES).map((c) => c.competitionKey)).toEqual(["nfl"]);
    expect(leagueMatches("zzz", TWO_LEAGUES)).toHaveLength(0);
    expect(leagueMatches("", TWO_LEAGUES)).toHaveLength(0);
  });

  it("groups search results under their own league: a heading when the league itself didn't match, a Follow-all button when it did (#2278)", () => {
    const html = renderToString(
      createElement(SearchResults, {
        query: "premier",
        results: [DAL, ARS],
        partial: false,
        isError: false,
        competitions: TWO_LEAGUES,
        followsByKey: new Map(),
        onToggle: () => {},
        onRetry: () => {},
        actionState: null
      })
    );
    // "premier" matches Premier League's own label, so that group keeps its Follow-all button...
    expect(html).toContain("Follow all of Premier League");
    // ...but NFL only appears because Dallas Cowboys matched, so it gets a plain heading instead.
    expect(html).not.toContain("Follow all of NFL");
    expect(html).toMatch(/class="jds-eyebrow sp-search__group-heading">NFL</);
    // Each league's teams sit directly under its own group, not mixed into one shared grid.
    const eplGroup = html.slice(html.indexOf("Premier League"), html.indexOf(">NFL<"));
    expect(eplGroup).toContain("ARS");
    expect(eplGroup).not.toContain("DAL");
    const nflGroup = html.slice(html.indexOf(">NFL<"));
    expect(nflGroup).toContain("DAL");
    expect(nflGroup).not.toContain("ARS");
  });

  it("a league that matched by name alone keeps its Follow-all row but renders no empty team grid (#2278 review)", () => {
    const html = renderToString(
      createElement(SearchResults, {
        query: "nfl",
        results: [],
        partial: false,
        isError: false,
        competitions: TWO_LEAGUES,
        followsByKey: new Map(),
        onToggle: () => {},
        onRetry: () => {},
        actionState: null
      })
    );
    expect(html).toContain("Follow all of NFL");
    expect(html).not.toContain("sp-teamgrid");
  });

  it("a team whose league is missing from the catalog still sits under its own heading (#2278 review)", () => {
    const ncaaState = { ...DAL, teamKey: "ncst", competitionKey: "ncaa.mbb", name: "NC State" };
    const ncaaFootball = { ...ncaaState, competitionKey: "ncaa.fb" };
    const html = renderToString(
      createElement(SearchResults, {
        query: "state",
        results: [ncaaState, ncaaFootball, DAL],
        partial: false,
        isError: false,
        // Catalog not loaded yet: no league details for any result.
        competitions: [],
        followsByKey: new Map(),
        onToggle: () => {},
        onRetry: () => {},
        actionState: null
      })
    );
    const headings = [...html.matchAll(/sp-search__group-heading">([^<]+)</g)].map((m) => m[1]);
    expect(headings).toEqual([
      "Unrecognized league (ncaa.mbb)",
      "Unrecognized league (ncaa.fb)",
      "Unrecognized league (nfl)"
    ]);
    // Every tile sits in a group with exactly one heading; no group is empty.
    const groups = html.split('<div class="sp-search__group">').slice(1);
    expect(groups).toHaveLength(3);
    for (const group of groups) {
      expect(group.match(/sp-search__group-heading/g)).toHaveLength(1);
      expect(group.match(/class="sp-team[ "]/g)).toHaveLength(1);
    }
    expect(groups[0]).toContain("Follow NC State");
    expect(groups[2]).toContain("Follow Dallas Cowboys");
  });

  it("searchLeagueRows: label match, parent-league derivation from server results, and dedupe", () => {
    // Direct label match, no server results.
    expect(searchLeagueRows("prem", [], TWO_LEAGUES).map((c) => c.competitionKey)).toEqual(["epl"]);
    // A server team result surfaces its parent league even when the label doesn't match.
    expect(searchLeagueRows("cowboys", [DAL], TWO_LEAGUES).map((c) => c.competitionKey)).toEqual([
      "nfl"
    ]);
    // Label match + a same-league team result dedupes to one row.
    expect(searchLeagueRows("nfl", [DAL], TWO_LEAGUES).map((c) => c.competitionKey)).toEqual([
      "nfl"
    ]);
    // No label match and no results.
    expect(searchLeagueRows("zzz", [], TWO_LEAGUES)).toHaveLength(0);
    // A result team whose competitionKey isn't in the catalog is skipped, not crashed on.
    const orphanTeam = { ...DAL, competitionKey: "xyz.retired" };
    expect(searchLeagueRows("zzz", [orphanTeam], TWO_LEAGUES)).toHaveLength(0);
  });
});

// Ben, dev, 2026-09-04: following Pacific never showed as followed. Two teams share the short name
// "PAC", so the team list gives them composite keys ("pac.413", "pac.129700") while the saved follow
// keeps the bare short name "pac" and the permanent id. Matching on the key can never succeed, so
// the tile stayed unfollowed, the chip lost its crest, and a second click re-followed instead of
// unfollowing. These tests match on the permanent id and fail on the key-only page.
describe("follow key mismatch on a colliding team (Ben, dev, 2026-09-04)", () => {
  const TIGERS: TeamRefLite = {
    teamKey: "pac.413",
    competitionKey: "nfl",
    name: "Pacific Tigers",
    shortName: "PAC",
    crestUrl: "https://example.com/crests/413.png",
    sourceTeamId: "413"
  };
  const LUTES: TeamRefLite = {
    teamKey: "pac.129700",
    competitionKey: "nfl",
    name: "Pacific Lutheran Lutes",
    shortName: "PAC",
    crestUrl: "https://example.com/crests/129700.png",
    sourceTeamId: "129700"
  };
  const savedTigers = {
    id: "f-pac",
    competitionKey: "nfl",
    teamKey: "pac",
    sourceTeamId: "413",
    createdAt: "2026-09-04T00:00:00Z"
  };

  it("marks the followed colliding team's tile active, and only that one", () => {
    const html = renderToString(
      createElement(SearchResults, {
        query: "pac",
        results: [TIGERS, LUTES],
        partial: false,
        isError: false,
        competitions: TWO_LEAGUES,
        followsByKey: indexFollows([savedTigers]),
        onToggle: () => {},
        onRetry: () => {},
        actionState: null
      })
    );
    expect(html).toContain('aria-label="Unfollow Pacific Tigers"');
    expect(html).toContain('aria-label="Follow Pacific Lutheran Lutes"');
    expect(html.match(/sp-team is-active/g)).toHaveLength(1);
  });

  it("resolves the tile back to the saved follow, so the next click unfollows instead of re-following", () => {
    const index = indexFollows([savedTigers]);
    expect(followFor(index, "nfl", TIGERS.teamKey, TIGERS.sourceTeamId)?.id).toBe("f-pac");
    expect(followFor(index, "nfl", LUTES.teamKey, LUTES.sourceTeamId)).toBeUndefined();
    // A follow with no permanent id (saved before the id column existed) still matches by key.
    const legacy = indexFollows([{ ...savedTigers, teamKey: "dal", sourceTeamId: null }]);
    expect(followFor(legacy, "nfl", "dal", "id-dal")?.id).toBe("f-pac");
  });

  it("never lends a saved follow to a different team that later takes over its short name (review round 7)", () => {
    // The Tigers were saved as "pac" with id 413. The list then refreshes with only the Lutes,
    // who now hold the bare key "pac" with id 129700. The Lutes tile must not read as followed,
    // and its click must not reach the Tigers follow.
    const index = indexFollows([savedTigers]);
    expect(followFor(index, "nfl", "pac", "129700")).toBeUndefined();
    // The Tigers themselves still resolve, whatever key the list gives them today.
    expect(followFor(index, "nfl", "pac", "413")?.id).toBe("f-pac");
    expect(followFor(index, "nfl", "pac.413", "413")?.id).toBe("f-pac");
    // Only an older save with no id of its own may be claimed through the key.
    const legacy = indexFollows([{ ...savedTigers, sourceTeamId: null }]);
    expect(followFor(legacy, "nfl", "pac", "129700")?.id).toBe("f-pac");
  });

  it("shows the followed colliding team's own crest in the summary chip", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(CATALOG_KEY, { competitions: [TWO_LEAGUES[0]], degraded: false });
    client.setQueryData(FOLLOWS_KEY, { follows: [savedTigers] });
    client.setQueryData(sportsQueryKeys.leagueTeams("nfl"), {
      teams: [LUTES, TIGERS],
      degraded: false
    });
    const html = renderWithQuery(client);
    expect(html).toContain("sp-chip");
    expect(html).toContain('src="https://example.com/crests/413.png"');
    expect(html).not.toContain('src="https://example.com/crests/129700.png"');
    // The chip shows the roster short name, which proves the roster entry was found by id: a
    // follow with no roster match falls back to its bare saved key "pac".
    expect(html).toContain('class="sp-chip__lbl">PAC<');
    expect(html).toContain('aria-label="Unfollow PAC"');
  });
});

describe("is-active styling coverage (#691)", () => {
  const followed = indexFollows([
    {
      id: "f1",
      competitionKey: "epl",
      teamKey: "team.ars",
      sourceTeamId: "id-team.ars",
      createdAt: "2026-01-01T00:00:00Z"
    }
  ]);

  it("marks a followed team is-active in search results, unfollowed team not", () => {
    const html = renderToString(
      createElement(SearchResults, {
        query: "ars",
        results: [ARS],
        partial: false,
        isError: false,
        competitions: TWO_LEAGUES,
        followsByKey: followed,
        onToggle: () => {},
        onRetry: () => {},
        actionState: null
      })
    );
    expect(html).toContain("is-active");
    expect(html).toMatch(/sp-team is-active/);
  });

  it("does not mark an unfollowed team is-active", () => {
    const html = renderToString(
      createElement(SearchResults, {
        query: "ars",
        results: [ARS],
        partial: false,
        isError: false,
        competitions: TWO_LEAGUES,
        followsByKey: new Map(),
        onToggle: () => {},
        onRetry: () => {},
        actionState: null
      })
    );
    expect(html).not.toContain("is-active");
  });

  it("SearchResults shows a partial-coverage note without swallowing existing results", () => {
    const html = renderToString(
      createElement(SearchResults, {
        query: "ars",
        results: [ARS],
        partial: true,
        isError: false,
        competitions: TWO_LEAGUES,
        followsByKey: new Map(),
        onToggle: () => {},
        onRetry: () => {},
        actionState: null
      })
    );
    expect(html).toContain("ARS");
    expect(html).toContain("Still covering more leagues");
  });

  it("SearchResults shows the still-warming note when partial and nothing has matched yet", () => {
    const html = renderToString(
      createElement(SearchResults, {
        query: "zzz",
        results: [],
        partial: true,
        isError: false,
        competitions: TWO_LEAGUES,
        followsByKey: new Map(),
        onToggle: () => {},
        onRetry: () => {},
        actionState: null
      })
    );
    expect(html).toContain("No matches yet");
  });

  it("SearchResults shows the plain no-match note when not partial and nothing matched", () => {
    const html = renderToString(
      createElement(SearchResults, {
        query: "zzz",
        results: [],
        partial: false,
        isError: false,
        competitions: TWO_LEAGUES,
        followsByKey: new Map(),
        onToggle: () => {},
        onRetry: () => {},
        actionState: null
      })
    );
    expect(html).toContain("No teams or leagues match your search.");
  });

  // #907 IMPORTANT (final-review finding 1): a failed search request must render as a retry
  // note, never as the same "no matches" copy a real empty result gets — that's a false
  // negative a user can't tell apart from "this team isn't in our catalog".
  it("SearchResults shows a retry note (not the false 'no matches' copy) when the search request failed", () => {
    const html = renderToString(
      createElement(SearchResults, {
        query: "ars",
        results: [],
        partial: false,
        isError: true,
        competitions: TWO_LEAGUES,
        followsByKey: new Map(),
        onToggle: () => {},
        onRetry: () => {},
        actionState: null
      })
    );
    expect(html).not.toContain("No teams or leagues match your search.");
    expect(html).toContain("Retry");
  });
});

describe("BrowseGroups", () => {
  it("renders an expanded league's teams from expandedTeams", () => {
    const html = renderToString(
      createElement(BrowseGroups, {
        competitions: TWO_LEAGUES,
        followsByKey: new Map(),
        expandedKey: "epl",
        onExpand: () => {},
        expandedTeams: [ARS],
        expandedLoading: false,
        expandedDegraded: false,
        onRetryExpanded: () => {},
        onToggle: () => {},
        actionState: null
      })
    );
    expect(html).toContain("sp-teamgrid");
    expect(html).toContain("ARS");
    expect(html).toContain('aria-expanded="true"');
  });

  it("renders a retry note when the expanded league's roster fetch is degraded", () => {
    const html = renderToString(
      createElement(BrowseGroups, {
        competitions: TWO_LEAGUES,
        followsByKey: new Map(),
        expandedKey: "epl",
        onExpand: () => {},
        expandedTeams: [],
        expandedLoading: false,
        expandedDegraded: true,
        onRetryExpanded: () => {},
        onToggle: () => {},
        actionState: null
      })
    );
    expect(html).toContain("Retry");
  });

  it("skips confederation groups with no leagues", () => {
    const html = renderToString(
      createElement(BrowseGroups, {
        competitions: TWO_LEAGUES,
        followsByKey: new Map(),
        expandedKey: null,
        onExpand: () => {},
        expandedTeams: [],
        expandedLoading: false,
        expandedDegraded: false,
        onRetryExpanded: () => {},
        onToggle: () => {},
        actionState: null
      })
    );
    // TWO_LEAGUES only populates INTL and UEFA — the other five confederation headings must not
    // appear (#907: empty groups are skipped entirely, not rendered with a "no leagues" state).
    expect(html).not.toContain("North & Central America");
    expect(html).not.toContain("South America");
    expect(html).not.toContain("Asia · AFC");
    expect(html).not.toContain("Africa · CAF");
    expect(html).not.toContain("Oceania · OFC");
  });
});

describe("followControlState", () => {
  it("inactive team: visible and aria-label both read 'Follow {team}'", () => {
    expect(followControlState("team", "Arsenal", false, null)).toEqual({
      visible: "",
      ariaLabel: "Follow Arsenal"
    });
  });
  it("active team: visible reads 'Following', aria-label reads 'Unfollow {team}'", () => {
    expect(followControlState("team", "Arsenal", true, null)).toEqual({
      visible: "Following",
      ariaLabel: "Unfollow Arsenal"
    });
  });
  it("inactive league: visible and aria-label both read 'Follow all of {league}'", () => {
    expect(followControlState("league", "Premier League", false, null)).toEqual({
      visible: "Follow all of Premier League",
      ariaLabel: "Follow all of Premier League"
    });
  });
  it("active league: visible reads 'Following all of {league}', aria-label reads 'Unfollow all of {league}'", () => {
    expect(followControlState("league", "Premier League", true, null)).toEqual({
      visible: "Following all of Premier League",
      ariaLabel: "Unfollow all of Premier League"
    });
  });
  it("pending follow (any variant): both read 'Following…'", () => {
    expect(followControlState("team", "Arsenal", false, "follow")).toEqual({
      visible: "Following…",
      ariaLabel: "Following…"
    });
  });
  it("pending unfollow (any variant): both read 'Unfollowing…'", () => {
    expect(followControlState("league", "Premier League", true, "unfollow")).toEqual({
      visible: "Unfollowing…",
      ariaLabel: "Unfollowing…"
    });
  });
});

describe("sportsQueryKeys.teamSearch", () => {
  // #907 MINOR (final-review finding 4): the server matches search case-insensitively (see
  // sports-service.ts's `.toLowerCase()`), but the React Query cache key didn't normalize case —
  // "Arsenal" and "arsenal" landed in separate cache entries and re-fetched needlessly.
  it("normalizes case so differently-cased queries share one cache entry", () => {
    expect(sportsQueryKeys.teamSearch("Arsenal")).toEqual(sportsQueryKeys.teamSearch("arsenal"));
    expect(sportsQueryKeys.teamSearch("ARSENAL")).toEqual(sportsQueryKeys.teamSearch("arsenal"));
  });
});
