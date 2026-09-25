import { describe, expect, it } from "vitest";
import type { StandingsGroup } from "@moss/shared";

import {
  defaultStandingsKey,
  resolveDefaultStandingsKey,
  resolveStandingsViewKey
} from "../../packages/sports/src/web/sports-standings.js";

function group(competitionKey: string): StandingsGroup {
  return {
    competitionKey,
    competitionLabel: competitionKey,
    standingsShape: "table",
    sections: []
  };
}

function view(key: string, label: string) {
  return { key, label, conference: null, sections: [] };
}

describe("resolveDefaultStandingsKey (#2661)", () => {
  it("opens a remembered competition when it is still in the picker", () => {
    expect(resolveDefaultStandingsKey("nba", [], ["nba", "nfl"], [])).toBe("nba");
  });

  it("opens a remembered finished tournament, beating the finished-tournament rule", () => {
    // Without the remembered pick, defaultStandingsKey skips an inactive tournament and picks nba.
    expect(defaultStandingsKey([], ["nba", "fifa.wwc"], [])).toBe("nba");
    expect(resolveDefaultStandingsKey("fifa.wwc", [], ["nba", "fifa.wwc"], [])).toBe("fifa.wwc");
  });

  it("falls back to the default when the remembered competition is gone", () => {
    expect(resolveDefaultStandingsKey("fifa.wwc", [], ["nba"], [])).toBe("nba");
    // A followed-but-hidden competition is gone too; the inactive tournament next to it is skipped.
    expect(resolveDefaultStandingsKey("eng.1", [], ["nba", "fifa.world"], [])).toBe("nba");
  });

  it("uses the derived default when nothing was ever remembered", () => {
    expect(resolveDefaultStandingsKey(null, [], ["nba", "uefa.champions"], [])).toBe("nba");
    expect(resolveDefaultStandingsKey(null, [], ["uefa.champions"], ["uefa.champions"])).toBe(
      "uefa.champions"
    );
  });

  it("prefers a followed competition's group when groups are provided", () => {
    // The derived default walks groups before the visible list.
    expect(resolveDefaultStandingsKey(null, [group("nfl")], ["nfl", "nba"], [])).toBe("nfl");
  });
});

describe("resolveStandingsViewKey (#2661)", () => {
  const views = [view("all", "All"), view("conf:AFC", "AFC"), view("sec:0", "AFC East")];

  it("opens the remembered view by label, then by key", () => {
    expect(
      resolveStandingsViewKey(
        { competitionKey: "nfl", viewKey: "stale", viewLabel: "AFC East" },
        views,
        "all"
      )
    ).toBe("sec:0");
    expect(
      resolveStandingsViewKey(
        { competitionKey: "nfl", viewKey: "conf:AFC", viewLabel: null },
        views,
        "all"
      )
    ).toBe("conf:AFC");
  });

  it("falls back quietly when the remembered view no longer exists", () => {
    expect(
      resolveStandingsViewKey(
        { competitionKey: "nfl", viewKey: "sec:9", viewLabel: "Gone" },
        views,
        "all"
      )
    ).toBe("all");
    expect(resolveStandingsViewKey(null, views, "all")).toBe("all");
  });
});
