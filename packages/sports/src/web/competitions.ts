// Per-competition display facts shared across the sports web surfaces.

/** Soccer renders home-first ("Home v Away"); US sports render away-first ("Away at Home"). */
export const SOCCER_COMPETITIONS: ReadonlySet<string> = new Set([
  "eng.1",
  "usa.1",
  "uefa.champions",
  "fifa.world",
  // #2661 women's football. The set is only consulted to order a scoreline, so every soccer
  // competition added here reads home-first like the rest of the sport.
  "eng.w.1",
  "esp.w.1",
  "fra.w.1",
  "ned.w.1",
  "aus.w.1",
  "fifa.wwc",
  "uefa.wchampions",
  "uefa.weuro",
  "concacaf.w.gold",
  "fifa.w.olympics"
]);

/**
 * Knockout tournaments: a group-stage standing line ("#1 · 6 pts") reads as a league
 * position — misleading once the bracket starts, so compact surfaces hide it.
 */
export const TOURNAMENT_COMPETITIONS: ReadonlySet<string> = new Set([
  "uefa.champions",
  "fifa.world",
  // #2661, and the reviewer follow-up from #2660: the Women's World Cup was missing, and the
  // new women's tournaments belong here too. A group-stage line under a knockout bracket reads
  // as a league position, so compact surfaces hide it.
  "fifa.wwc",
  "uefa.wchampions",
  "uefa.weuro",
  "concacaf.w.gold",
  "fifa.w.olympics"
]);

/**
 * Static league-mark map (sanctioned asset map keyed by competitionKey — CompetitionRef
 * carries no logo field). Soccer numeric ids are best-effort; a bad id 404s and the
 * <img> hides itself via onError, leaving the text label.
 */
export const LEAGUE_LOGOS: Readonly<Record<string, string>> = {
  nfl: "https://a.espncdn.com/i/teamlogos/leagues/500/nfl.png",
  nba: "https://a.espncdn.com/i/teamlogos/leagues/500/nba.png",
  nhl: "https://a.espncdn.com/i/teamlogos/leagues/500/nhl.png",
  mlb: "https://a.espncdn.com/i/teamlogos/leagues/500/mlb.png",
  "eng.1": "https://a.espncdn.com/i/leaguelogos/soccer/500/23.png",
  "usa.1": "https://a.espncdn.com/i/leaguelogos/soccer/500/19.png",
  "uefa.champions": "https://a.espncdn.com/i/leaguelogos/soccer/500/2.png",
  "fifa.world": "https://a.espncdn.com/i/leaguelogos/soccer/500/4.png"
};
