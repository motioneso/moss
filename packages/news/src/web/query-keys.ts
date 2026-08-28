/**
 * React Query key conventions for the news module's web contribution (same package-owned
 * pattern as packages/sports/src/web/query-keys.ts — module code, not apps/web, owns its keys).
 */
export const newsQueryKeys = {
  overview: ["news", "overview"] as const,
  catalog: ["news", "catalog"] as const,
  prefs: ["news", "prefs"] as const,
  personalization: ["news", "personalization"] as const,
  feedback: ["news", "feedback"] as const,
  /**
   * #2008: the credential STATUS list only - which sources have a key, and whether it is still
   * good. No key material is ever returned by that route, so nothing secret enters the cache.
   */
  credentials: ["news", "credentials"] as const
};
