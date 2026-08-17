import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";

import type { Job, PgBoss } from "pg-boss";

import type { AccessContext, DataContextDb, DataContextRunner } from "@moss/db";
import {
  type ActorScopedJobPayload,
  type QueueDefinition,
  sendJob,
  toAccessContext
} from "@moss/jobs";
import type { EmbeddingProvider } from "@moss/memory";
import {
  createEmbeddingProvider,
  CpuIsolatedEmbeddingProvider,
  embedChunks,
  getEmbeddingProviderConfig,
  MemoryRepository,
  parseDocument,
  type NewChunkData
} from "@moss/memory";
import {
  NOTES_LAST_SYNC_PREFERENCE_KEY,
  NOTES_SOURCE_PREFERENCE_KEY,
  RuntimeConfigResolver,
  resolveNotesRoots
} from "@moss/settings";
import type { PreferencesRepository } from "@moss/structured-state";

import { assertWithinRoot, recheckWithinRoot, NotesPathError } from "./path-guard.js";
import { NOTES_SYNC_QUEUE } from "./manifest.js";

const NOTES_SOURCE_KIND = "notes";
export const NOTES_SYNC_MAX_CHUNKS_PER_RUN = 100;

export interface NotesSyncJobPayload extends ActorScopedJobPayload {
  /**
   * Optional. The manual POST route passes it explicitly; the 15-min scheduled
   * fire omits it and the handler resolves from the `notes-source-path`
   * preference (the single source of truth — a re-point via PUT is picked up on
   * the next tick without rewriting the schedule row).
   */
  readonly sourcePath?: string;
  readonly filePath?: string;
  readonly chunkOffset?: number;
  readonly fileHash?: string;
}

export interface NotesSyncJobResult {
  readonly ingested: number;
  readonly skipped: number;
  readonly errors: number;
  /**
   * Fix 6 (#449): when true, the run was a deliberate no-op (e.g. no source
   * configured — a stale 15-min schedule firing after an unlink). The worker
   * wrapper MUST NOT write a `notes-last-sync` row in this case, otherwise a
   * stray schedule tick overwrites a real run's stats with zeros.
   */
  readonly noOp?: boolean;
  readonly deferred?: boolean;
  readonly continuation?: {
    readonly sourcePath: string;
    readonly filePath: string;
    readonly chunkOffset: number;
    readonly fileHash: string;
  };
}

export interface NotesLastSync {
  readonly at: string;
  readonly ingested: number;
  readonly skipped: number;
  readonly errors: number;
  readonly lastError?: string;
}

export interface NotesAfterSyncInput {
  readonly actorUserId: string;
  readonly sourcePath: string | null;
}

export type NotesAfterSyncHook = (input: NotesAfterSyncInput) => Promise<void>;

type NotesFileIngestStatus = "ingested" | "skipped";
interface NotesFileIngestResult {
  readonly status: NotesFileIngestStatus;
  readonly chunksProcessed: number;
  readonly continuation?: { readonly chunkOffset: number; readonly fileHash: string };
}
export type EmbeddingProviderFactory = (scopedDb: DataContextDb) => Promise<EmbeddingProvider>;

export const NOTES_QUEUE_DEFINITIONS: readonly QueueDefinition[] = [
  {
    name: NOTES_SYNC_QUEUE,
    options: {
      policy: "exclusive",
      retryLimit: 0,
      deleteAfterSeconds: 300,
      retentionSeconds: 300
    }
  }
];

async function collectMarkdownFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await collectMarkdownFiles(entryPath)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      result.push(entryPath);
    }
  }
  return result;
}

/**
 * Resolve the notes source path for this run. If the payload carries one (the
 * manual POST route), use it. Otherwise (the 15-min scheduled fire) look it up
 * from the `notes-source-path` preference — the preference stays the single
 * source of truth and a re-point via PUT reconciles on the next tick.
 *
 * Returns `null` when no source is configured. Fix 6 (#449): a stale schedule
 * firing after an unlink used to throw here every 15 min, surfacing as a
 * perpetual error. Now the handler treats `null` as a clean no-op.
 */
async function resolveSourcePath(
  scopedDb: DataContextDb,
  payloadPath: string | undefined,
  preferencesRepository: PreferencesRepository
): Promise<string | null> {
  if (payloadPath && payloadPath.length > 0) return payloadPath;
  const stored = await preferencesRepository.get(scopedDb, NOTES_SOURCE_PREFERENCE_KEY);
  if (typeof stored !== "string" || stored.length === 0) {
    return null;
  }
  return stored;
}

async function ingestResolvedMarkdownFile(
  resolvedRoot: string,
  scopedDb: DataContextDb,
  actorUserId: string,
  resolvedFile: string,
  repository: MemoryRepository,
  embeddingProvider: EmbeddingProvider,
  chunkOffset = 0,
  chunkLimit = NOTES_SYNC_MAX_CHUNKS_PER_RUN,
  expectedFileHash?: string
): Promise<NotesFileIngestResult> {
  await recheckWithinRoot(resolvedRoot, resolvedFile);
  const content = await readFile(resolvedFile, "utf-8");
  const fileHash = createHash("sha256").update(content).digest("hex");
  const effectiveChunkOffset = expectedFileHash === fileHash ? chunkOffset : 0;

  const existing = await repository.getFileIndex(
    scopedDb,
    actorUserId,
    NOTES_SOURCE_KIND,
    resolvedFile
  );

  if (
    effectiveChunkOffset === 0 &&
    existing &&
    existing.fileHash === fileHash &&
    existing.embedModelName === embeddingProvider.modelName
  ) {
    return { status: "skipped", chunksProcessed: 0 };
  }

  const { chunks, wikilinks } = parseDocument(content);
  const chunkEnd = Math.min(effectiveChunkOffset + chunkLimit, chunks.length);

  const newChunks: NewChunkData[] = await embedChunks(
    embeddingProvider,
    chunks.slice(effectiveChunkOffset, chunkEnd),
    resolvedFile
  );

  await repository.upsertFileChunks(
    scopedDb,
    actorUserId,
    resolvedFile,
    newChunks,
    embeddingProvider.modelName,
    embeddingProvider.modelVersion,
    NOTES_SOURCE_KIND,
    effectiveChunkOffset === 0
  );

  if (chunkEnd < chunks.length) {
    return {
      status: "ingested",
      chunksProcessed: newChunks.length,
      continuation: { chunkOffset: chunkEnd, fileHash }
    };
  }

  await repository.replaceFileLinks(scopedDb, actorUserId, resolvedFile, wikilinks);

  await repository.upsertFileIndex(
    scopedDb,
    actorUserId,
    NOTES_SOURCE_KIND,
    resolvedFile,
    fileHash,
    newChunks.length,
    embeddingProvider.modelName,
    embeddingProvider.modelVersion
  );

  return { status: "ingested", chunksProcessed: newChunks.length };
}

async function resolveAndValidateNoteFile(
  resolvedRoot: string,
  absolutePath: string
): Promise<string> {
  const resolvedFile = await realpath(absolutePath);
  assertWithinRoot(resolvedRoot, resolvedFile);
  return resolvedFile;
}

export async function handleNotesSyncJob(
  job: Job<NotesSyncJobPayload>,
  scopedDb: DataContextDb,
  embeddingProvider: EmbeddingProvider,
  preferencesRepository: PreferencesRepository
): Promise<NotesSyncJobResult> {
  const { actorUserId, sourcePath, filePath, chunkOffset = 0, fileHash } = job.data;

  const sourcePathToUse = await resolveSourcePath(scopedDb, sourcePath, preferencesRepository);

  // Fix 6 (#449): no source configured — a stale 15-min schedule tick after an
  // unlink. Clean no-op: do NOT throw (that would write `lastError` every tick
  // and surface as a perpetual failure), and do NOT write a last-sync row (that
  // would clobber a real run's stats with zeros).
  if (sourcePathToUse === null) {
    return { ingested: 0, skipped: 0, errors: 0, noOp: true };
  }

  const allowedRoots = resolveNotesRoots();
  if (allowedRoots.length === 0) {
    throw new Error("JARVIS_NOTES_ROOTS not configured — notes sync aborted");
  }

  let resolvedRoot: string;
  try {
    resolvedRoot = await realpath(sourcePathToUse);
  } catch {
    throw new Error(`Notes source path does not exist: ${sourcePathToUse}`);
  }

  const isWithinAllowed = allowedRoots.some(
    (root) => resolvedRoot === root || resolvedRoot.startsWith(root + "/")
  );
  if (!isWithinAllowed) {
    throw new Error(`Notes source path "${resolvedRoot}" is not within any allowed root`);
  }

  const repository = new MemoryRepository();
  const mdFiles = await collectMarkdownFiles(resolvedRoot);

  let ingested = 0;
  let skipped = 0;
  let errors = 0;
  // Fix 2 (#449): track the last per-file failure message. When EVERY attempted
  // file fails (nothing ingested, nothing skipped, errors>0) the run must
  // surface as a failure, not a silent success-with-error-count — otherwise the
  // card frames a total wipe as a healthy sync. A run that skipped unchanged
  // files (skipped>0) is a partial success even if a new file errored, so it
  // stays a success. Partial success (some ingested) likewise stays a success.
  let lastErrorMessage: string | undefined;

  let chunkBudget = NOTES_SYNC_MAX_CHUNKS_PER_RUN;
  const requestedFileIndex = filePath ? mdFiles.indexOf(filePath) : 0;
  const startFileIndex = Math.max(0, requestedFileIndex);
  for (let fileIndex = startFileIndex; fileIndex < mdFiles.length; fileIndex += 1) {
    if (chunkBudget === 0) {
      return {
        ingested,
        skipped,
        errors,
        deferred: true,
        continuation: {
          sourcePath: sourcePathToUse,
          filePath: mdFiles[fileIndex]!,
          chunkOffset: 0,
          fileHash: ""
        }
      };
    }
    const absolutePath = mdFiles[fileIndex]!;
    try {
      let resolvedFile: string;
      try {
        resolvedFile = await realpath(absolutePath);
      } catch (err) {
        errors += 1;
        lastErrorMessage = err instanceof Error ? err.message : String(err);
        continue;
      }

      try {
        assertWithinRoot(resolvedRoot, resolvedFile);
      } catch (e) {
        if (e instanceof NotesPathError) {
          errors += 1;
          lastErrorMessage = e.message;
          continue;
        }
        throw e;
      }

      const status = await ingestResolvedMarkdownFile(
        resolvedRoot,
        scopedDb,
        actorUserId,
        resolvedFile,
        repository,
        embeddingProvider,
        fileIndex === startFileIndex ? chunkOffset : 0,
        chunkBudget,
        fileIndex === startFileIndex ? fileHash : undefined
      );
      chunkBudget -= status.chunksProcessed;

      if (status.continuation) {
        return {
          ingested,
          skipped,
          errors,
          deferred: true,
          continuation: {
            sourcePath: sourcePathToUse,
            filePath: resolvedFile,
            chunkOffset: status.continuation.chunkOffset,
            fileHash: status.continuation.fileHash
          }
        };
      }

      if (status.status === "skipped") {
        skipped += 1;
        continue;
      }

      ingested += 1;
      if (chunkBudget === 0 && fileIndex + 1 < mdFiles.length) {
        return {
          ingested,
          skipped,
          errors,
          deferred: true,
          continuation: {
            sourcePath: sourcePathToUse,
            filePath: mdFiles[fileIndex + 1]!,
            chunkOffset: 0,
            fileHash: ""
          }
        };
      }
    } catch (err) {
      errors += 1;
      lastErrorMessage = err instanceof Error ? err.message : String(err);
    }
  }

  // Total failure: surface as a thrown error so the worker catch-path writes
  // `lastError` and the card renders the failure line (Fix 2). Partial success
  // (some ingested OR some skipped-unchanged) is intentionally NOT thrown — that
  // stays a success with an error count, matching the existing UX.
  if (ingested === 0 && skipped === 0 && errors > 0) {
    throw new Error(
      `notes sync: all ${errors} file(s) failed; last error: ${lastErrorMessage ?? "unknown"}`
    );
  }

  return { ingested, skipped, errors };
}

export async function handleNotesSyncJobWithDataContext(
  job: Job<NotesSyncJobPayload>,
  dataContextRunner: DataContextRunner,
  embeddingProviderFactory: EmbeddingProviderFactory,
  preferencesRepository: PreferencesRepository
): Promise<NotesSyncJobResult> {
  const accessContext = toAccessContext(job);
  const { actorUserId, sourcePath, filePath, chunkOffset = 0, fileHash } = job.data;

  const [sourcePathToUse, embeddingProvider] = await dataContextRunner.withDataContext(
    accessContext,
    async (scopedDb) => [
      await resolveSourcePath(scopedDb, sourcePath, preferencesRepository),
      await embeddingProviderFactory(scopedDb)
    ]
  );

  if (sourcePathToUse === null) {
    return { ingested: 0, skipped: 0, errors: 0, noOp: true };
  }

  const allowedRoots = resolveNotesRoots();
  if (allowedRoots.length === 0) {
    throw new Error("JARVIS_NOTES_ROOTS not configured — notes sync aborted");
  }

  let resolvedRoot: string;
  try {
    resolvedRoot = await realpath(sourcePathToUse);
  } catch {
    throw new Error(`Notes source path does not exist: ${sourcePathToUse}`);
  }

  const isWithinAllowed = allowedRoots.some(
    (root) => resolvedRoot === root || resolvedRoot.startsWith(root + "/")
  );
  if (!isWithinAllowed) {
    throw new Error(`Notes source path "${resolvedRoot}" is not within any allowed root`);
  }

  const repository = new MemoryRepository();
  const mdFiles = await collectMarkdownFiles(resolvedRoot);

  let ingested = 0;
  let skipped = 0;
  let errors = 0;
  let lastErrorMessage: string | undefined;

  let chunkBudget = NOTES_SYNC_MAX_CHUNKS_PER_RUN;
  const requestedFileIndex = filePath ? mdFiles.indexOf(filePath) : 0;
  const startFileIndex = Math.max(0, requestedFileIndex);
  for (let fileIndex = startFileIndex; fileIndex < mdFiles.length; fileIndex += 1) {
    if (chunkBudget === 0) {
      return {
        ingested,
        skipped,
        errors,
        deferred: true,
        continuation: {
          sourcePath: sourcePathToUse,
          filePath: mdFiles[fileIndex]!,
          chunkOffset: 0,
          fileHash: ""
        }
      };
    }
    const absolutePath = mdFiles[fileIndex]!;
    let resolvedFile: string;
    try {
      resolvedFile = await resolveAndValidateNoteFile(resolvedRoot, absolutePath);
    } catch (err) {
      errors += 1;
      lastErrorMessage = err instanceof Error ? err.message : String(err);
      continue;
    }

    try {
      const status = await dataContextRunner.withDataContext(accessContext, (scopedDb) =>
        ingestResolvedMarkdownFile(
          resolvedRoot,
          scopedDb,
          actorUserId,
          resolvedFile,
          repository,
          embeddingProvider,
          fileIndex === startFileIndex ? chunkOffset : 0,
          chunkBudget,
          fileIndex === startFileIndex ? fileHash : undefined
        )
      );
      chunkBudget -= status.chunksProcessed;

      if (status.continuation) {
        return {
          ingested,
          skipped,
          errors,
          deferred: true,
          continuation: {
            sourcePath: sourcePathToUse,
            filePath: resolvedFile,
            chunkOffset: status.continuation.chunkOffset,
            fileHash: status.continuation.fileHash
          }
        };
      }

      if (status.status === "ingested") ingested += 1;
      else skipped += 1;
      if (chunkBudget === 0 && fileIndex + 1 < mdFiles.length) {
        return {
          ingested,
          skipped,
          errors,
          deferred: true,
          continuation: {
            sourcePath: sourcePathToUse,
            filePath: mdFiles[fileIndex + 1]!,
            chunkOffset: 0,
            fileHash: ""
          }
        };
      }
    } catch (err) {
      errors += 1;
      lastErrorMessage = err instanceof Error ? err.message : String(err);
    }
  }

  if (ingested === 0 && skipped === 0 && errors > 0) {
    throw new Error(
      `notes sync: all ${errors} file(s) failed; last error: ${lastErrorMessage ?? "unknown"}`
    );
  }

  return { ingested, skipped, errors };
}

/**
 * Write the last-sync outcome to the `notes-last-sync` preference. Runs in its
 * OWN withDataContext (separate transaction) AFTER the ingest transaction has
 * committed or rolled back — a same-transaction write would be lost on failure
 * (the case we most need to surface) and would deadlock on the row lock.
 *
 * With retryLimit:0 + deleteAfterSeconds:300, a heartbeat failure self-deletes
 * in 5 min with no trace; this write is the only surface that distinguishes
 * "never synced" from "failing every 15 min". Best-effort: a write failure is
 * logged and swallowed so it never masks the real result.
 */
export async function writeNotesLastSync(
  dataContextRunner: DataContextRunner,
  accessContext: AccessContext,
  preferencesRepository: PreferencesRepository,
  outcome: NotesLastSync
): Promise<void> {
  try {
    await dataContextRunner.withDataContext(accessContext, (freshDb) =>
      preferencesRepository.upsert(freshDb, NOTES_LAST_SYNC_PREFERENCE_KEY, outcome)
    );
  } catch (error) {
    const e = error instanceof Error ? error : new Error(String(error));
    console.error(
      JSON.stringify({
        event: "notes_last_sync_write_failed",
        actorUserId: accessContext.actorUserId,
        error: e.name,
        message: e.message.slice(0, 200)
      })
    );
  }
}

export interface RegisterNotesJobWorkersOptions {
  readonly embeddingProviderFactory?: EmbeddingProviderFactory;
  readonly preferencesRepository: PreferencesRepository;
  readonly afterSync?: NotesAfterSyncHook;
}

async function defaultEmbeddingProviderFactory(
  scopedDb: DataContextDb
): Promise<EmbeddingProvider> {
  const config = await getEmbeddingProviderConfig(new RuntimeConfigResolver(scopedDb));
  return config.kind === "local"
    ? new CpuIsolatedEmbeddingProvider(config.modelId)
    : createEmbeddingProvider(config);
}

export async function runNotesAfterSyncHook(
  result: NotesSyncJobResult,
  hook: NotesAfterSyncHook | undefined,
  input: NotesAfterSyncInput
): Promise<void> {
  if (!hook || result.noOp) return;
  await hook(input);
}

export async function registerNotesJobWorkers(
  boss: PgBoss,
  dataContext: DataContextRunner,
  options: RegisterNotesJobWorkersOptions
): Promise<readonly string[]> {
  // Notes uses boss.work directly (not registerDataContextWorker) so the last-sync
  // preference write can run in its OWN withDataContext AFTER the ingest transaction
  // commits/rolls back. A same-transaction write would be lost on failure (the case
  // we most need to surface) and nesting a fresh withDataContext inside the handler
  // deadlocks on the preferences row lock. The pattern: run ingest in one
  // withDataContext, then run the outcome write in a second, non-overlapping one.
  const workId = await boss.work<NotesSyncJobPayload, NotesSyncJobResult>(
    NOTES_SYNC_QUEUE,
    { pollingIntervalSeconds: 2 },
    async ([job]) => {
      if (!job) throw new Error(`pg-boss invoked ${NOTES_SYNC_QUEUE} without a job`);
      const accessContext = toAccessContext(job);
      try {
        const result = await handleNotesSyncJobWithDataContext(
          job,
          dataContext,
          options.embeddingProviderFactory ?? defaultEmbeddingProviderFactory,
          options.preferencesRepository
        );
        if (result.continuation) {
          await sendJob(
            boss,
            NOTES_SYNC_QUEUE,
            { ...job.data, ...result.continuation },
            {
              singletonKey: `notes-sync:${accessContext.actorUserId}:${result.continuation.filePath}:${result.continuation.chunkOffset}`
            }
          );
          return result;
        }
        // Fix 6 (#449): a no-op run (no source configured — stale schedule tick
        // after unlink) must NOT write a last-sync row, otherwise it clobbers a
        // real run's stats with zeros.
        if (!result.noOp && !result.deferred) {
          await runNotesAfterSyncHook(result, options.afterSync, {
            actorUserId: accessContext.actorUserId,
            sourcePath: job.data.sourcePath ?? null
          });
          await writeNotesLastSync(dataContext, accessContext, options.preferencesRepository, {
            at: new Date().toISOString(),
            ingested: result.ingested,
            skipped: result.skipped,
            errors: result.errors
          });
        }
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await writeNotesLastSync(dataContext, accessContext, options.preferencesRepository, {
          at: new Date().toISOString(),
          ingested: 0,
          skipped: 0,
          errors: 0,
          lastError: message
        });
        throw error;
      }
    }
  );
  return [workId];
}
