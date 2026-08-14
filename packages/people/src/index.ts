export {
  peopleModuleManifest,
  peopleModuleSqlMigrationDirectory,
  PEOPLE_MODULE_ID,
  PEOPLE_MODULE_VERSION
} from "./manifest.js";

export { registerPeopleRoutes } from "./routes.js";
export type { PeopleRouteDependencies } from "./routes.js";

export { registerPersonIndexWorker, registerSyncPersonMemoryWorker } from "./workers.js";
export type { PersonIndexWorkerDeps } from "./workers.js";

export { createPeopleVaultIngestProvider } from "./vault-ingest-provider.js";

export {
  enqueuePersonIndex,
  enqueuePersonIndexBatch,
  enqueueSyncPersonMemory,
  assertMetadataOnlyPersonPayload,
  PERSON_INDEX_QUEUE,
  SYNC_PERSON_MEMORY_QUEUE
} from "./jobs.js";
export type {
  PersonIndexPayload,
  SyncPersonMemoryPayload,
  EnqueuePersonIndexParams
} from "./jobs.js";

export { PeopleRepository } from "./repository.js";
export type {
  UpsertPersonParams,
  UpsertIdentityParams,
  UpsertLinkParams,
  UpsertLinkSourceParams,
  UpsertMatchCandidateParams,
  InsertEventParams,
  UpsertIndexingStateParams
} from "./repository.js";

export { PersonContextService, RequiresExplicitActionError } from "./service.js";

export {
  PeopleNotesService,
  PEOPLE_NOTES_FOLDER_PREFERENCE_KEY,
  PeopleNotesFolderUnavailableError
} from "./notes-service.js";
export type {
  CreatePersonNoteInput,
  UpdatePersonNoteInput,
  PeopleNoteWriteResult
} from "./notes-service.js";

export { PEOPLE_TOOLS } from "./tools.js";

export type {
  Person,
  PersonIdentity,
  PersonLink,
  PersonLinkSource,
  MatchCandidate,
  PersonEvent,
  PersonIndexingState,
  PersonDetail,
  ListPeopleParams,
  ListLinksParams,
  RefreshIndexParams,
  PersonStatus,
  PersonIdentityKind,
  PersonSourceKind,
  PersonIdentityStatus,
  PersonProvenance,
  PersonLinkKind,
  PersonCandidateKind,
  PersonCandidateStatus,
  PersonEventKind,
  PeopleNotesSettings,
  PeopleNotesRefreshResult
} from "./types.js";
