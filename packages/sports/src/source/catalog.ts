import type { Confederation, SportsSportKey, StandingsShape } from "@moss/shared";

export interface CatalogEntry {
  readonly competitionKey: string;
  readonly label: string;
  readonly sportLabel: string;
  readonly regionLabel: string | null;
  readonly kind: "league" | "tournament";
  readonly marquee: boolean;
  readonly standingsShape: StandingsShape;
  readonly espnSport: SportsSportKey;
  readonly espnLeague: string;
  // Official competition logo URL (Ben 2026-07-09 /today: "I'd prefer to have the logo to be clear",
  // then "pull the official logos from somewhere else if needed for World Cup, Champions League etc").
  // Optional and explicit per-entry: ESPN serves logos under TWO unrelated schemes — US leagues at
  // /i/teamlogos/leagues/500/{slug}.png, but soccer competitions only under
  // /i/leaguelogos/soccer/500/{numericId}.png (the slug path 404s for eng.1/usa.1/uefa.champions/
  // fifa.world) — so no single resolver can derive it. Most #907 leagues carry no configured logo;
  // omitted/undefined/null → <Crest> renders the initials swatch. A literal field also lets any one
  // competition point at a non-ESPN source later without touching the resolver.
  readonly logoUrl?: string | null;
  // FIFA confederation grouping for the follow picker's browse mode (#907).
  readonly confederation: Confederation;
}

// Base paths for the two ESPN logo schemes, factored out so the entries below read as data.
const ESPN_LEAGUE = "https://a.espncdn.com/i/teamlogos/leagues/500"; // US leagues, keyed by slug
const ESPN_SOCCER = "https://a.espncdn.com/i/leaguelogos/soccer/500"; // soccer, keyed by numeric id

export const SPORTS_CATALOG: readonly CatalogEntry[] = [
  {
    competitionKey: "nfl",
    label: "NFL",
    sportLabel: "Football",
    regionLabel: null,
    kind: "league",
    marquee: false,
    standingsShape: "record",
    espnSport: "football",
    espnLeague: "nfl",
    logoUrl: `${ESPN_LEAGUE}/nfl.png`,
    confederation: "INTL"
  },
  {
    competitionKey: "nba",
    label: "NBA",
    sportLabel: "Basketball",
    regionLabel: null,
    kind: "league",
    marquee: false,
    standingsShape: "record",
    espnSport: "basketball",
    espnLeague: "nba",
    logoUrl: `${ESPN_LEAGUE}/nba.png`,
    confederation: "INTL"
  },
  {
    competitionKey: "nhl",
    label: "NHL",
    sportLabel: "Hockey",
    regionLabel: null,
    kind: "league",
    marquee: false,
    standingsShape: "record",
    espnSport: "hockey",
    espnLeague: "nhl",
    logoUrl: `${ESPN_LEAGUE}/nhl.png`,
    confederation: "INTL"
  },
  {
    competitionKey: "mlb",
    label: "MLB",
    sportLabel: "Baseball",
    regionLabel: null,
    kind: "league",
    marquee: false,
    standingsShape: "record",
    espnSport: "baseball",
    espnLeague: "mlb",
    logoUrl: `${ESPN_LEAGUE}/mlb.png`,
    confederation: "INTL"
  },
  {
    competitionKey: "eng.1",
    label: "Premier League",
    sportLabel: "Soccer",
    regionLabel: "England",
    kind: "league",
    marquee: false,
    standingsShape: "table",
    espnSport: "soccer",
    espnLeague: "eng.1",
    logoUrl: `${ESPN_SOCCER}/23.png`, // ESPN soccer id 23 = Premier League
    confederation: "UEFA"
  },
  // English pyramid tiers 2-5, below the Premier League — all UEFA, all standard tables
  // (#907 slice 2). IDs/team counts verified live via scripts/probe-espn-leagues.mjs.
  {
    competitionKey: "eng.2",
    label: "EFL Championship",
    sportLabel: "Soccer",
    regionLabel: "England",
    kind: "league",
    marquee: false,
    standingsShape: "table",
    espnSport: "soccer",
    espnLeague: "eng.2",
    confederation: "UEFA"
  },
  {
    competitionKey: "eng.3",
    label: "EFL League One",
    sportLabel: "Soccer",
    regionLabel: "England",
    kind: "league",
    marquee: false,
    standingsShape: "table",
    espnSport: "soccer",
    espnLeague: "eng.3",
    confederation: "UEFA"
  },
  {
    competitionKey: "eng.4",
    label: "EFL League Two",
    sportLabel: "Soccer",
    regionLabel: "England",
    kind: "league",
    marquee: false,
    standingsShape: "table",
    espnSport: "soccer",
    espnLeague: "eng.4",
    confederation: "UEFA"
  },
  {
    competitionKey: "eng.5",
    label: "National League",
    sportLabel: "Soccer",
    regionLabel: "England",
    kind: "league",
    marquee: false,
    standingsShape: "table",
    espnSport: "soccer",
    espnLeague: "eng.5",
    confederation: "UEFA"
  },
  {
    competitionKey: "usa.1",
    label: "MLS",
    sportLabel: "Soccer",
    regionLabel: "United States",
    kind: "league",
    marquee: false,
    standingsShape: "table",
    espnSport: "soccer",
    espnLeague: "usa.1",
    logoUrl: `${ESPN_SOCCER}/19.png`, // ESPN soccer id 19 = MLS
    confederation: "CONCACAF"
  },
  // Remaining UEFA top flights, plus Americas (#907 slice 3). All live-probed via
  // scripts/probe-espn-leagues.mjs (see task-9 report for the full run) before landing here.
  {
    competitionKey: "esp.1",
    label: "LaLiga",
    sportLabel: "Soccer",
    regionLabel: "Spain",
    kind: "league",
    marquee: false,
    standingsShape: "table",
    espnSport: "soccer",
    espnLeague: "esp.1",
    confederation: "UEFA"
  },
  {
    competitionKey: "ger.1",
    label: "Bundesliga",
    sportLabel: "Soccer",
    regionLabel: "Germany",
    kind: "league",
    marquee: false,
    standingsShape: "table",
    espnSport: "soccer",
    espnLeague: "ger.1",
    confederation: "UEFA"
  },
  {
    competitionKey: "ita.1",
    label: "Serie A",
    sportLabel: "Soccer",
    regionLabel: "Italy",
    kind: "league",
    marquee: false,
    standingsShape: "table",
    espnSport: "soccer",
    espnLeague: "ita.1",
    confederation: "UEFA"
  },
  {
    competitionKey: "fra.1",
    label: "Ligue 1",
    sportLabel: "Soccer",
    regionLabel: "France",
    kind: "league",
    marquee: false,
    standingsShape: "table",
    espnSport: "soccer",
    espnLeague: "fra.1",
    confederation: "UEFA"
  },
  {
    competitionKey: "ned.1",
    label: "Eredivisie",
    sportLabel: "Soccer",
    regionLabel: "Netherlands",
    kind: "league",
    marquee: false,
    standingsShape: "table",
    espnSport: "soccer",
    espnLeague: "ned.1",
    confederation: "UEFA"
  },
  {
    competitionKey: "por.1",
    label: "Primeira Liga",
    sportLabel: "Soccer",
    regionLabel: "Portugal",
    kind: "league",
    marquee: false,
    standingsShape: "table",
    espnSport: "soccer",
    espnLeague: "por.1",
    confederation: "UEFA"
  },
  {
    competitionKey: "sco.1",
    label: "Scottish Premiership",
    sportLabel: "Soccer",
    regionLabel: "Scotland",
    kind: "league",
    marquee: false,
    standingsShape: "table",
    espnSport: "soccer",
    espnLeague: "sco.1",
    confederation: "UEFA"
  },
  {
    competitionKey: "tur.1",
    label: "Süper Lig",
    sportLabel: "Soccer",
    regionLabel: "Turkey",
    kind: "league",
    marquee: false,
    standingsShape: "table",
    espnSport: "soccer",
    espnLeague: "tur.1",
    confederation: "UEFA"
  },
  {
    competitionKey: "bel.1",
    label: "Belgian Pro League",
    sportLabel: "Soccer",
    regionLabel: "Belgium",
    kind: "league",
    marquee: false,
    standingsShape: "table",
    espnSport: "soccer",
    espnLeague: "bel.1",
    confederation: "UEFA"
  },
  {
    competitionKey: "gre.1",
    label: "Super League Greece",
    sportLabel: "Soccer",
    regionLabel: "Greece",
    kind: "league",
    marquee: false,
    standingsShape: "table",
    espnSport: "soccer",
    espnLeague: "gre.1",
    confederation: "UEFA"
  },
  {
    competitionKey: "sui.1",
    label: "Swiss Super League",
    sportLabel: "Soccer",
    regionLabel: "Switzerland",
    kind: "league",
    marquee: false,
    standingsShape: "table",
    espnSport: "soccer",
    espnLeague: "sui.1",
    confederation: "UEFA"
  },
  {
    competitionKey: "aut.1",
    label: "Austrian Bundesliga",
    sportLabel: "Soccer",
    regionLabel: "Austria",
    kind: "league",
    marquee: false,
    standingsShape: "table",
    espnSport: "soccer",
    espnLeague: "aut.1",
    confederation: "UEFA"
  },
  {
    competitionKey: "den.1",
    label: "Danish Superliga",
    sportLabel: "Soccer",
    regionLabel: "Denmark",
    kind: "league",
    marquee: false,
    standingsShape: "table",
    espnSport: "soccer",
    espnLeague: "den.1",
    confederation: "UEFA"
  },
  {
    competitionKey: "mex.1",
    label: "Liga MX",
    sportLabel: "Soccer",
    regionLabel: "Mexico",
    kind: "league",
    marquee: false,
    standingsShape: "table",
    espnSport: "soccer",
    espnLeague: "mex.1",
    confederation: "CONCACAF"
  },
  {
    competitionKey: "crc.1",
    label: "Primera División de Costa Rica",
    sportLabel: "Soccer",
    regionLabel: "Costa Rica",
    kind: "league",
    marquee: false,
    standingsShape: "table",
    espnSport: "soccer",
    espnLeague: "crc.1",
    confederation: "CONCACAF"
  },
  {
    competitionKey: "bra.1",
    label: "Brasileirão",
    sportLabel: "Soccer",
    regionLabel: "Brazil",
    kind: "league",
    marquee: false,
    standingsShape: "table",
    espnSport: "soccer",
    espnLeague: "bra.1",
    confederation: "CONMEBOL"
  },
  {
    competitionKey: "arg.1",
    label: "Liga Profesional de Fútbol",
    sportLabel: "Soccer",
    regionLabel: "Argentina",
    kind: "league",
    marquee: false,
    standingsShape: "table",
    espnSport: "soccer",
    espnLeague: "arg.1",
    confederation: "CONMEBOL"
  },
  {
    competitionKey: "col.1",
    label: "Primera A",
    sportLabel: "Soccer",
    regionLabel: "Colombia",
    kind: "league",
    marquee: false,
    standingsShape: "table",
    espnSport: "soccer",
    espnLeague: "col.1",
    confederation: "CONMEBOL"
  },
  {
    competitionKey: "chi.1",
    label: "Primera División de Chile",
    sportLabel: "Soccer",
    regionLabel: "Chile",
    kind: "league",
    marquee: false,
    standingsShape: "table",
    espnSport: "soccer",
    espnLeague: "chi.1",
    confederation: "CONMEBOL"
  },
  {
    competitionKey: "uru.1",
    label: "Liga AUF Uruguaya",
    sportLabel: "Soccer",
    regionLabel: "Uruguay",
    kind: "league",
    marquee: false,
    standingsShape: "table",
    espnSport: "soccer",
    espnLeague: "uru.1",
    confederation: "CONMEBOL"
  },
  {
    competitionKey: "uefa.champions",
    label: "Champions League",
    sportLabel: "Soccer",
    regionLabel: "Europe",
    kind: "tournament",
    marquee: false,
    standingsShape: "groups",
    espnSport: "soccer",
    espnLeague: "uefa.champions",
    logoUrl: `${ESPN_SOCCER}/2.png`, // ESPN soccer id 2 = UEFA Champions League
    // The CL is unambiguously UEFA-run despite fielding clubs from multiple domestic leagues
    // within Europe — spec §4.1 (#907).
    confederation: "UEFA"
  },
  {
    competitionKey: "fifa.world",
    label: "FIFA World Cup",
    sportLabel: "Soccer",
    regionLabel: "International",
    kind: "tournament",
    marquee: true,
    standingsShape: "groups",
    espnSport: "soccer",
    espnLeague: "fifa.world",
    logoUrl: `${ESPN_SOCCER}/4.png`, // ESPN soccer id 4 = FIFA World Cup
    // Cross-confederation tournament — no single confederation runs it (#907).
    confederation: "INTL"
  },
  // AFC, CAF, and the remaining CONMEBOL/CONCACAF feeder leagues from spec Appendix A
  // (#907 slice 4 — the final batch). All live-probed via scripts/probe-espn-leagues.mjs;
  // see task-10-report.md for the full run including every failed alt-slug attempt.
  //
  // kor.1/egy.1/mar.1/nzl.1 (plus alt-slug guesses rok.1, kr.1, mor.1, egy.prem, egy.premier,
  // mar.botola, nzl.premiership, nzl.national) all 404 on ESPN's site API — dropped, not
  // silently capped. uae.1/qat.1/irn.1/alg.1/tun.1/pan.1 also 404 and are dropped for the
  // same reason. OFC has zero ESPN-served leagues after the nzl.1 alt-slug chase came up
  // empty, so OFC is absent from the catalog entirely (spec §4.6 permits this).
  {
    competitionKey: "jpn.1",
    label: "J.League",
    sportLabel: "Soccer",
    regionLabel: "Japan",
    kind: "league",
    marquee: false,
    standingsShape: "table",
    espnSport: "soccer",
    espnLeague: "jpn.1",
    confederation: "AFC"
  },
  {
    // ESPN uses ksa.1, not the ISO-3166 sau.1 — the "sau.1 trap" from spec §4.6.
    competitionKey: "ksa.1",
    label: "Saudi Pro League",
    sportLabel: "Soccer",
    regionLabel: "Saudi Arabia",
    kind: "league",
    marquee: false,
    standingsShape: "table",
    espnSport: "soccer",
    espnLeague: "ksa.1",
    confederation: "AFC"
  },
  {
    competitionKey: "chn.1",
    label: "Chinese Super League",
    sportLabel: "Soccer",
    regionLabel: "China",
    kind: "league",
    marquee: false,
    standingsShape: "table",
    espnSport: "soccer",
    espnLeague: "chn.1",
    confederation: "AFC"
  },
  {
    competitionKey: "aus.1",
    label: "A-League Men",
    sportLabel: "Soccer",
    regionLabel: "Australia",
    kind: "league",
    marquee: false,
    standingsShape: "table",
    espnSport: "soccer",
    espnLeague: "aus.1",
    confederation: "AFC"
  },
  {
    competitionKey: "tha.1",
    label: "Thai League 1",
    sportLabel: "Soccer",
    regionLabel: "Thailand",
    kind: "league",
    marquee: false,
    standingsShape: "table",
    espnSport: "soccer",
    espnLeague: "tha.1",
    confederation: "AFC"
  },
  {
    competitionKey: "rsa.1",
    label: "South African Premiership",
    sportLabel: "Soccer",
    regionLabel: "South Africa",
    kind: "league",
    marquee: false,
    standingsShape: "table",
    espnSport: "soccer",
    espnLeague: "rsa.1",
    confederation: "CAF"
  },
  {
    competitionKey: "ecu.1",
    label: "LigaPro Ecuador",
    sportLabel: "Soccer",
    regionLabel: "Ecuador",
    kind: "league",
    marquee: false,
    standingsShape: "table",
    espnSport: "soccer",
    espnLeague: "ecu.1",
    confederation: "CONMEBOL"
  },
  {
    competitionKey: "par.1",
    label: "Paraguayan Primera División",
    sportLabel: "Soccer",
    regionLabel: "Paraguay",
    kind: "league",
    marquee: false,
    standingsShape: "table",
    espnSport: "soccer",
    espnLeague: "par.1",
    confederation: "CONMEBOL"
  },
  {
    competitionKey: "per.1",
    label: "Peruvian Liga 1",
    sportLabel: "Soccer",
    regionLabel: "Peru",
    kind: "league",
    marquee: false,
    standingsShape: "table",
    espnSport: "soccer",
    espnLeague: "per.1",
    confederation: "CONMEBOL"
  },
  {
    competitionKey: "bol.1",
    label: "Bolivian Liga Profesional",
    sportLabel: "Soccer",
    regionLabel: "Bolivia",
    kind: "league",
    marquee: false,
    standingsShape: "table",
    espnSport: "soccer",
    espnLeague: "bol.1",
    confederation: "CONMEBOL"
  },
  {
    competitionKey: "ven.1",
    label: "Venezuelan Primera División",
    sportLabel: "Soccer",
    regionLabel: "Venezuela",
    kind: "league",
    marquee: false,
    standingsShape: "table",
    espnSport: "soccer",
    espnLeague: "ven.1",
    confederation: "CONMEBOL"
  },
  {
    competitionKey: "hon.1",
    label: "Honduran Liga Nacional",
    sportLabel: "Soccer",
    regionLabel: "Honduras",
    kind: "league",
    marquee: false,
    standingsShape: "table",
    espnSport: "soccer",
    espnLeague: "hon.1",
    confederation: "CONCACAF"
  },
  {
    competitionKey: "gua.1",
    label: "Guatemalan Liga Nacional",
    sportLabel: "Soccer",
    regionLabel: "Guatemala",
    kind: "league",
    marquee: false,
    standingsShape: "table",
    espnSport: "soccer",
    espnLeague: "gua.1",
    confederation: "CONCACAF"
  },
  {
    competitionKey: "slv.1",
    label: "Salvadoran Primera División",
    sportLabel: "Soccer",
    regionLabel: "El Salvador",
    kind: "league",
    marquee: false,
    standingsShape: "table",
    espnSport: "soccer",
    espnLeague: "slv.1",
    confederation: "CONCACAF"
  }
];

const BY_KEY = new Map(SPORTS_CATALOG.map((e) => [e.competitionKey, e]));

export function catalogEntry(competitionKey: string): CatalogEntry | undefined {
  return BY_KEY.get(competitionKey);
}

// Official competition logo (Ben 2026-07-09 /today). A direct read of the per-entry `logoUrl` — no
// slug-building, since ESPN's two logo schemes don't share a derivation (see CatalogEntry.logoUrl).
// Unknown key or an entry with no configured logo → null, and <Crest> falls back to the initials
// swatch.
export function competitionLogoUrl(competitionKey: string): string | null {
  return BY_KEY.get(competitionKey)?.logoUrl ?? null;
}
