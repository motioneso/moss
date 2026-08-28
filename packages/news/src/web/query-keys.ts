/**
 * React Query key conventions for the news module's web contribution (same package-owned
 * pattern as packages/sports/src/web/query-keys.ts — module code, not apps/web, owns its keys).
 */
export const newsQueryKeys = {
  overview: ["news", "overview"] as const,
  catalog: ["news", "catalog"] as const,
  prefs: ["news", "prefs"] as const,
  personalization: ["news", "personalization"] as const,
  feedback: ["news", "feedback"] as const
};
