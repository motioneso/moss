export { registerSportsRoutes } from "./routes.js";
export { collectSportsSourcesExportSection } from "./data-lifecycle.js";
// #1025: re-exported so root-level tests/uat/seed/* can write follows through the real
// repository (same precedent as @moss/auth's hashPassword / @moss/news's NewsPrefsRepository).
export { SportsFollowsRepository } from "./repository.js";
export type { SportsRoutesDependencies } from "./routes.js";
export { SportsService, type SportsFollowsWriter } from "./sports-service.js";
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
export { SportsBrowserBroker, SportsBrowserBrokerServer } from "./source/browser-broker.js";
export { SportsBrowserClient } from "./source/browser-client.js";
export { SPORTS_BROWSER_SOCKETS } from "./source/browser-protocol.js";
export { SportsPublicSourceReader } from "./source/public-source-reader.js";
export { createSportsPreviewStore } from "./source/preview-store.js";
export { SportsSourcesRepository } from "./source/repository.js";
export { SportsEspnCoverageRepository } from "./source/espn-coverage-repository.js";
export { SportsSourceService } from "./source/service.js";
