export { registerSportsRoutes } from "./routes.js";
// #1025: re-exported so root-level tests/uat/seed/* can write follows through the real
// repository (same precedent as @moss/auth's hashPassword / @moss/news's NewsPrefsRepository).
export { SportsFollowsRepository } from "./repository.js";
export type { SportsRoutesDependencies } from "./routes.js";
export type { SportsFollowsWriter } from "./sports-service.js";
export {
  SPORTS_MODULE_ID,
  sportsAddSourceRequirement,
  sportsModuleManifest,
  sportsModuleSqlMigrationDirectory
} from "./manifest.js";
export {
  configureSportsBriefingService,
  sportsFollowedFactsTodayExecute
} from "./briefing-tool.js";
export { configureSportsChatTools, resetSportsChatToolsForTests } from "./chat-tools.js";
export { createEspnDatasetAdapter } from "./source/espn-source.js";
