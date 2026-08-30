/**
 * React Query key conventions for the sports module's web contribution.
 *
 * Values are byte-identical to the keys previously owned by `apps/web/src/api/query-keys.ts`'s
 * `sports` block, so the migration to this package-owned module does not invalidate or duplicate
 * any cached query for existing users (React Query compares keys structurally, not by reference).
 */
export const sportsQueryKeys = {
  overview: ["sports", "overview"] as const,
  catalog: ["sports", "catalog"] as const,
  follows: ["sports", "follows"] as const,
  standingsPreferences: ["sports", "standings-preferences"] as const,
  standings: (competitionKey: string) => ["sports", "standings", competitionKey] as const,
  // Follow picker (#907): keyed per league so browse-expand and the followed-chip roster lookup
  // share one cache entry for the same league (React Query dedupes by structural key equality).
  leagueTeams: (competitionKey: string) => ["sports", "league-teams", competitionKey] as const,
  // Normalized so "Arsenal" and "arsenal " share one cache entry — the server lowercases/trims
  // before matching, so case/padding variants are always the same result set (#907 review).
  teamSearch: (query: string) => ["sports", "team-search", query.trim().toLowerCase()] as const,
  // #1572: the actor's own custom public news sources.
  sources: ["sports", "sources"] as const
};
