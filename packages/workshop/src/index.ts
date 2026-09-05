import { fileURLToPath } from "node:url";
export const workshopModuleSqlMigrationDirectory = fileURLToPath(
  new URL("../sql", import.meta.url)
);
export {
  WorkshopProjectsRepository,
  WorkshopProjectConflictError,
  WorkshopInputError,
  collectWorkshopProjects
} from "./projects-repository.js";
export { WORKSHOP_MODULE_ID, workshopModuleManifest } from "./manifest.js";
export {
  workshopBuildModuleExecute,
  MODULE_BUILD_START_SERVICE_KEY,
  type ModuleBuildStartService,
  type WorkshopModuleBuildPlan,
  type WorkshopModuleBuildStartResult
} from "./assistant-tools.js";

export {
  WorkshopProjectFeed,
  WorkshopMessageConflictError,
  collectWorkshopProjectFeed
} from "./project-feed.js";
export { registerWorkshopProjectRoutes } from "./project-routes.js";
export {
  createWorkshopProject,
  requireWorkshopAdmin,
  WorkshopAdminRequiredError
} from "./project-service.js";
