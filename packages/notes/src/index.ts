export { notesCommitmentProvider } from "./commitment-provider.js";
export {
  notesModuleManifest,
  notesModuleSqlMigrationDirectory,
  NOTES_MODULE_ID,
  NOTES_SYNC_QUEUE
} from "./manifest.js";
export { NotesSyncFailure, sinkSafeErrorMessage } from "./error-sink.js";
export { NotesPathError, assertWithinRoot } from "./path-guard.js";
export { createNotesRecallPort, type NotesRecallPort, type NotesRecallSnippet } from "./recall.js";
export {
  NOTES_QUEUE_DEFINITIONS,
  handleNotesSyncJob,
  handleNotesSyncJobWithDataContext,
  registerNotesJobWorkers,
  runNotesAfterSyncHook,
  writeNotesLastSync,
  type NotesAfterSyncHook,
  type NotesAfterSyncInput,
  type NotesLastSync,
  type NotesSyncJobPayload,
  type NotesSyncJobResult
} from "./jobs.js";
export { registerNotesSyncRoutes } from "./notes-sync-routes.js";
export { NOTES_SYNC_CRON, reconcileNotesSchedule } from "./schedule.js";
export {
  assertInside,
  notesCreateExecute,
  notesDeleteExecute,
  notesEditExecute,
  recheckInside,
  resolveSource,
  type NotesSyncToolService
} from "./write-tools.js";
export {
  writeDailyChatArchive,
  type ChatArchiveMessage,
  type ChatArchiveSession,
  type WriteDailyChatArchiveResult
} from "./daily-archive-writer.js";
