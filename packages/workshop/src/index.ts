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
  workshopRunCommandExecute,
  WORKSHOP_RUN_COMMAND_SERVICE_KEY,
  WORKSHOP_RUN_COMMAND_DEFAULT_TIMEOUT_MS,
  WORKSHOP_RUN_COMMAND_MAX_TIMEOUT_MS,
  WORKSHOP_RUN_COMMAND_MIN_TIMEOUT_MS,
  type WorkshopRunCommandService,
  type WorkshopRunCommandStart,
  type WorkshopRunCommandState
} from "./run-command.js";

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
