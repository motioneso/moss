import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SearchResults } from "../../packages/sports/src/settings/index.js";

// Split out of settings-sports-pane.test.tsx to keep that file under the 1000-line cap
// (check:file-size). Fixtures mirror the ones there.
type TeamRefLite = {
  readonly teamKey: string;
  readonly competitionKey: string;
  readonly name: string;
  readonly shortName: string;
  readonly crestUrl: string | null;
  readonly sourceTeamId: string | null;
};
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

describe("SearchResults league grouping (#2278)", () => {
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
});
