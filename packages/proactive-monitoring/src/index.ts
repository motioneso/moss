export type {
  ProactiveMonitorStateRow,
  ProactiveCardRow,
  ResolvedMonitoringConfig
} from "./types.js";
export {
  proactiveMonitoringModuleManifest,
  proactiveMonitoringSqlMigrationDirectory
} from "./manifest.js";
export {
  ProactiveMonitoringPreferencesRepository,
  ProactivePreferenceRevisionConflictError,
  isProactiveSourceEnabled,
  resolveAutomaticEmailAlertsEnabled,
  type SavedProactiveMonitoringPreference,
  validateProactiveMonitoringPreference,
  resolveSourcePreference
} from "./preferences-repository.js";
export { MonitorStateRepository } from "./monitor-state-repository.js";
export { CardRepository, serializeCard } from "./card-repository.js";
export { AntiSpamPolicy, type AntiSpamVerdict } from "./anti-spam.js";
export { mapSignalType, isAllowedSignalType } from "./signal-mapper.js";
export {
  ProactiveScanner,
  resolveMonitoringConfig,
  type ScanReason,
  type ScanResult
} from "./scanner.js";
export {
  PROACTIVE_SCAN_SOURCE_QUEUE,
  enqueueProactiveScan,
  registerProactiveMonitoringWorkers,
  type ProactiveScanSourceJobPayload
} from "./jobs.js";
export {
  registerProactiveMonitoringRoutes,
  type ProactiveMonitoringRoutesDependencies
} from "./routes.js";
export { makeProactiveCardVerifier } from "./target-verifier.js";
