import { describe, expect, it } from "vitest";
import { SPORTS_CATALOG, catalogEntry } from "../../packages/sports/src/source/catalog.js";

describe("sports catalog", () => {
  it("covers the approved competitions (#907 slice 4: AFC/CAF + remaining Americas feeders)", () => {
    expect(SPORTS_CATALOG.map((c) => c.competitionKey).sort()).toEqual(
      [
        "arg.1",
        "aus.1",
        "aut.1",
        "bel.1",
        "bol.1",
        "bra.1",
        "chi.1",
        "chn.1",
        "col.1",
        "crc.1",
        "den.1",
        "ecu.1",
        "eng.1",
        "eng.2",
        "eng.3",
        "eng.4",
        "eng.5",
        "esp.1",
        "fifa.world",
        "fra.1",
        "ger.1",
        "gre.1",
        "gua.1",
        "hon.1",
        "ita.1",
        "jpn.1",
        "ksa.1",
        "mex.1",
        "mlb",
        "nba",
        "ned.1",
        "nfl",
        "nhl",
        "par.1",
        "per.1",
        "por.1",
        "rsa.1",
        "sco.1",
        "slv.1",
        "sui.1",
        "tha.1",
        "tur.1",
        "uefa.champions",
        "uru.1",
        "usa.1",
        "usa.nwsl",
        "ven.1",
        "wnba",
        "ncaaf",
        "ncaam",
        "ncaaw",
        "ncaa-baseball",
        "ncaa-hockey"
      ].sort()
    );
  });
  it("adds women's pro and major college leagues as ESPN record leagues (Ben, 2026-09-03)", () => {
    const expected: Record<string, [string, string, string]> = {
      wnba: ["basketball", "wnba", "Basketball"],
      ncaaf: ["football", "college-football", "Football"],
      ncaam: ["basketball", "mens-college-basketball", "Basketball"],
      ncaaw: ["basketball", "womens-college-basketball", "Basketball"],
      "ncaa-baseball": ["baseball", "college-baseball", "Baseball"],
      "ncaa-hockey": ["hockey", "mens-college-hockey", "Hockey"]
    };
    for (const [key, [espnSport, espnLeague, sportLabel]] of Object.entries(expected)) {
      const entry = catalogEntry(key);
      expect(entry?.espnSport).toBe(espnSport);
      expect(entry?.espnLeague).toBe(espnLeague);
      expect(entry?.sportLabel).toBe(sportLabel);
      // Region-less so the settings checklist lists them directly under the sport heading.
      expect(entry?.regionLabel).toBeNull();
      expect(entry?.standingsShape).toBe("record");
      expect(entry?.kind).toBe("league");
    }
    // Only the WNBA slug resolves on ESPN's league-logo path; the college slugs all 404.
    expect(catalogEntry("wnba")?.logoUrl).toContain("/wnba.png");
    for (const key of ["ncaaf", "ncaam", "ncaaw", "ncaa-baseball", "ncaa-hockey"]) {
      expect(catalogEntry(key)?.logoUrl).toBeUndefined();
    }
    // NWSL sits with MLS under United States in the Soccer group.
    const nwsl = catalogEntry("usa.nwsl");
    expect(nwsl?.espnSport).toBe("soccer");
    expect(nwsl?.regionLabel).toBe("United States");
    expect(nwsl?.standingsShape).toBe("table");
    expect(nwsl?.confederation).toBe("CONCACAF");
    // ESPN serves no standings for these, so they must stay out of the catalog.
    for (const key of ["pwhl", "wpbl", "nba-g-league"]) expect(catalogEntry(key)).toBeUndefined();
  });
  it("groups the new top flights into their confederations (#907 slice 3)", () => {
    expect(catalogEntry("bra.1")?.confederation).toBe("CONMEBOL");
    expect(catalogEntry("mex.1")?.confederation).toBe("CONCACAF");
    expect(catalogEntry("esp.1")?.confederation).toBe("UEFA");
    for (const key of [
      "esp.1",
      "ger.1",
      "ita.1",
      "fra.1",
      "ned.1",
      "por.1",
      "sco.1",
      "tur.1",
      "bel.1",
      "gre.1",
      "sui.1",
      "aut.1",
      "den.1"
    ]) {
      expect(catalogEntry(key)?.confederation).toBe("UEFA");
    }
    for (const key of ["mex.1", "crc.1"]) {
      expect(catalogEntry(key)?.confederation).toBe("CONCACAF");
    }
    for (const key of ["bra.1", "arg.1", "col.1", "chi.1", "uru.1"]) {
      expect(catalogEntry(key)?.confederation).toBe("CONMEBOL");
    }
    for (const entry of SPORTS_CATALOG) {
      expect(entry.standingsShape).not.toBeNull();
    }
    // Each of the 20 new top-flight leagues must be a soccer table standings entry —
    // a plain not.toBeNull() above would not catch a regression that flips one of
    // these to "groups"/"record" (e.g. a copy-paste from a tournament entry).
    for (const key of [
      "esp.1",
      "ger.1",
      "ita.1",
      "fra.1",
      "ned.1",
      "por.1",
      "sco.1",
      "tur.1",
      "bel.1",
      "gre.1",
      "sui.1",
      "aut.1",
      "den.1",
      "mex.1",
      "crc.1",
      "bra.1",
      "arg.1",
      "col.1",
      "chi.1",
      "uru.1"
    ]) {
      const entry = catalogEntry(key);
      expect(entry?.standingsShape).toBe("table");
      expect(entry?.espnSport).toBe("soccer");
    }
  });
  it("groups AFC, CAF, and the remaining Americas feeders (#907 slice 4)", () => {
    expect(catalogEntry("jpn.1")?.confederation).toBe("AFC");
    expect(catalogEntry("rsa.1")?.confederation).toBe("CAF");
    expect(catalogEntry("ksa.1")).toBeDefined(); // the sau.1 trap — spec §4.6
    for (const key of ["jpn.1", "ksa.1", "chn.1", "aus.1", "tha.1"]) {
      expect(catalogEntry(key)?.confederation).toBe("AFC");
    }
    for (const key of ["rsa.1"]) {
      expect(catalogEntry(key)?.confederation).toBe("CAF");
    }
    for (const key of ["ecu.1", "par.1", "per.1", "bol.1", "ven.1"]) {
      expect(catalogEntry(key)?.confederation).toBe("CONMEBOL");
    }
    for (const key of ["hon.1", "gua.1", "slv.1"]) {
      expect(catalogEntry(key)?.confederation).toBe("CONCACAF");
    }
    // Confirm the alt-slug chase for kor/egy/mar/nzl (and OFC generally) came up empty:
    // no ESPN-served league exists for any of these, so none may appear in the catalog.
    for (const droppedKey of ["kor.1", "egy.1", "mar.1", "nzl.1"]) {
      expect(catalogEntry(droppedKey)).toBeUndefined();
    }
    expect(SPORTS_CATALOG.some((e) => e.confederation === "OFC")).toBe(false);
    // Each of these 14 new leagues must be a soccer table standings entry — a plain
    // truthy check would not catch a regression that flips one to "groups"/"record".
    for (const key of [
      "jpn.1",
      "ksa.1",
      "chn.1",
      "aus.1",
      "tha.1",
      "rsa.1",
      "ecu.1",
      "par.1",
      "per.1",
      "bol.1",
      "ven.1",
      "hon.1",
      "gua.1",
      "slv.1"
    ]) {
      const entry = catalogEntry(key);
      expect(entry?.standingsShape).toBe("table");
      expect(entry?.espnSport).toBe("soccer");
    }
  });
  it("gives England its full pyramid, all UEFA table leagues (#907)", () => {
    for (const key of ["eng.2", "eng.3", "eng.4", "eng.5"]) {
      const entry = catalogEntry(key);
      expect(entry?.confederation).toBe("UEFA");
      expect(entry?.standingsShape).toBe("table");
      expect(entry?.espnSport).toBe("soccer");
    }
  });
  it("maps nfl to ESPN football/nfl as a league", () => {
    const e = catalogEntry("nfl");
    expect(e?.espnSport).toBe("football");
    expect(e?.espnLeague).toBe("nfl");
    expect(e?.kind).toBe("league");
  });
  it("flags the World Cup as a marquee tournament", () => {
    const e = catalogEntry("fifa.world");
    expect(e?.kind).toBe("tournament");
    expect(e?.marquee).toBe(true);
  });
  it("tags every entry with a confederation (#907)", () => {
    for (const entry of SPORTS_CATALOG) expect(entry.confederation).toBeTruthy();
    expect(catalogEntry("eng.1")?.confederation).toBe("UEFA");
    expect(catalogEntry("usa.1")?.confederation).toBe("CONCACAF");
    expect(catalogEntry("uefa.champions")?.confederation).toBe("UEFA");
    expect(catalogEntry("fifa.world")?.confederation).toBe("INTL");
    expect(catalogEntry("nfl")?.confederation).toBe("INTL");
  });
});
