import type { FastifyBaseLogger } from "fastify";
import { sql, type Kysely } from "kysely";
import type { PgBoss } from "pg-boss";

import type { DataContextDb, DataContextRunner, MossDatabase } from "@moss/db";
import {
  assertMetadataOnlyPayload,
  registerDataContextWorker,
  sendJob,
  type ActorScopedJobPayload
} from "@moss/jobs";
import { embedChunks, MemoryRepository, type EmbeddingProvider } from "@moss/memory";

import { splitSegmentText } from "./chunking.js";
import { BACKTRACK_INDEX_QUEUE, BACKTRACK_UPKEEP_QUEUE } from "./manifest.js";
import { BacktrackRepository } from "./repository.js";

/** Memory's source kind for screen history, and the path every chunk of a segment shares. */
export const BACKTRACK_CHUNK_SOURCE_KIND = "screen";
export function backtrackChunkSourcePath(segmentId: string): string {
  return `backtrack/${segmentId}`;
}

/** Hourly, at minute 7 (plan §4.6); off the other hourly jobs' minutes. */
export const BACKTRACK_UPKEEP_CRON = "7 * * * *";
const BACKTRACK_UPKEEP_PAYLOAD = { kind: "backtrack-upkeep" } as const;

/** The most ids one `backtrack.index` job carries (the ingest route's own batch cap). */
export const BACKTRACK_INDEX_BATCH = 200;
/** `deleteChunksForSources` takes at most this many paths per call. */
const CHUNK_DELETE_BATCH = 500;
/** Decision 10: markers outlive any segment ingest still accepts. */
const MARKER_RETENTION_MS = 38 * 24 * 60 * 60 * 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface BacktrackIndexJobPayload extends ActorScopedJobPayload {
  readonly segmentIds: readonly string[];
}

type JobLogger = Pick<FastifyBaseLogger, "info" | "warn" | "error">;

/** Remove the `screen` chunks of deleted segments, in the batches memory's API accepts. */
export async function deleteScreenChunksForSegments(
  memory: Pick<MemoryRepository, "deleteChunksForSources">,
  scopedDb: DataContextDb,
  ownerUserId: string,
  segmentIds: readonly string[]
): Promise<number> {
  let removed = 0;
  for (let i = 0; i < segmentIds.length; i += CHUNK_DELETE_BATCH) {
    const paths = segmentIds.slice(i, i + CHUNK_DELETE_BATCH).map(backtrackChunkSourcePath);
    removed += await memory.deleteChunksForSources(
      scopedDb,
      ownerUserId,
      paths,
      BACKTRACK_CHUNK_SOURCE_KIND
    );
  }
  return removed;
}

export interface BacktrackIndexDeps {
  readonly repository: BacktrackRepository;
  readonly memory: Pick<MemoryRepository, "upsertFileChunks">;
  readonly embeddingProviderFactory: (scopedDb: DataContextDb) => Promise<EmbeddingProvider>;
}

/**
 * Plan §4.5. Runs in the owner's data context. Under the owner lock (decision 3) it re-reads the
 * listed segments, keeps those still present and inside retention, embeds each one's text and
 * replaces its chunks, then stamps `indexed_at`. A segment a purge or delete removed before the
 * lock was taken is simply absent, so it gets no chunk; one removed after waits on this lock.
 * Returns how many segments were indexed.
 */
export async function indexBacktrackSegments(
  scopedDb: DataContextDb,
  ownerUserId: string,
  segmentIds: readonly string[],
  deps: BacktrackIndexDeps
): Promise<number> {
  if (
    !Array.isArray(segmentIds) ||
    segmentIds.length > BACKTRACK_INDEX_BATCH ||
    !segmentIds.every((id) => typeof id === "string" && UUID_RE.test(id))
  ) {
    throw new Error(`backtrack.index payload segmentIds must be at most 200 UUIDs`);
  }

  await deps.repository.lockOwner(scopedDb, ownerUserId);
  const segments = await deps.repository.selectLiveSegmentsByIds(scopedDb, ownerUserId, segmentIds);
  if (segments.length === 0) return 0;

  const provider = await deps.embeddingProviderFactory(scopedDb);
  for (const segment of segments) {
    const sourcePath = backtrackChunkSourcePath(segment.id);
    const chunks = await embedChunks(
      provider,
      splitSegmentText(segment.windowTitle, segment.address, segment.body),
      sourcePath
    );
    await deps.memory.upsertFileChunks(
      scopedDb,
      ownerUserId,
      sourcePath,
      chunks,
      provider.modelName,
      provider.modelVersion,
      BACKTRACK_CHUNK_SOURCE_KIND
    );
  }
  await deps.repository.markIndexed(
    scopedDb,
    ownerUserId,
    segments.map((segment) => segment.id)
  );
  return segments.length;
}

export interface BacktrackUpkeepDeps {
  /** The worker-role connection: its only reach across owners is EXECUTE on the owner-list function. */
  readonly rootDb: Kysely<MossDatabase>;
  readonly dataContext: DataContextRunner;
  readonly boss: PgBoss;
  readonly repository?: BacktrackRepository;
  readonly memory?: Pick<MemoryRepository, "deleteChunksForSources">;
  readonly logger?: Pick<JobLogger, "warn">;
}

export interface BacktrackUpkeepStats {
  readonly owners: number;
  readonly failedOwners: number;
  readonly deletedSegments: number;
  readonly deletedChunks: number;
  readonly deletedMarkers: number;
  readonly enqueuedSegments: number;
}

/**
 * Plan §4.6. One `SECURITY DEFINER` call names the owners that need work (ids only); each owner
 * is then handled in their own data context and transaction, under the owner lock: expired
 * segments (by `started_at` or `created_at`) and their `screen` chunks go together, old deletion
 * markers go, and segments still unindexed after ten minutes are queued for indexing again after
 * the transaction commits. Runs whether or not the storage switch is on. One owner's failure
 * never blocks the rest; it is counted, and the job fails at the end so pg-boss retries it.
 */
export async function runBacktrackUpkeep(deps: BacktrackUpkeepDeps): Promise<BacktrackUpkeepStats> {
  const repository = deps.repository ?? new BacktrackRepository();
  const memory = deps.memory ?? new MemoryRepository();

  const owners = await sql<{ owner_user_id: string }>`
    SELECT owner_user_id FROM app.backtrack_owners_needing_upkeep()
  `.execute(deps.rootDb);

  let failedOwners = 0;
  let deletedSegments = 0;
  let deletedChunks = 0;
  let deletedMarkers = 0;
  let enqueuedSegments = 0;

  for (const { owner_user_id: ownerUserId } of owners.rows) {
    try {
      const outcome = await deps.dataContext.withDataContext(
        { actorUserId: ownerUserId, requestId: "backtrack-upkeep" },
        async (scopedDb) => {
          await repository.lockOwner(scopedDb, ownerUserId);
          const expired = await repository.deleteExpiredSegments(scopedDb, ownerUserId);
          const chunks = await deleteScreenChunksForSegments(
            memory,
            scopedDb,
            ownerUserId,
            expired
          );
          const markers = await repository.deleteExpiredDeletionMarkers(
            scopedDb,
            ownerUserId,
            new Date(Date.now() - MARKER_RETENTION_MS)
          );
          const stale = await repository.listStaleUnindexedSegmentIds(scopedDb, ownerUserId);
          return {
            expired: expired.length,
            chunks,
            markers: markers.length,
            stale
          };
        }
      );

      deletedSegments += outcome.expired;
      deletedChunks += outcome.chunks;
      deletedMarkers += outcome.markers;

      for (let i = 0; i < outcome.stale.length; i += BACKTRACK_INDEX_BATCH) {
        const segmentIds = outcome.stale.slice(i, i + BACKTRACK_INDEX_BATCH);
        await sendJob(deps.boss, BACKTRACK_INDEX_QUEUE, {
          actorUserId: ownerUserId,
          segmentIds
        });
        enqueuedSegments += segmentIds.length;
      }
    } catch (error) {
      failedOwners += 1;
      // The error name only: a database error's message can quote row values.
      deps.logger?.warn(
        { ownerUserId, errorName: error instanceof Error ? error.name : "unknown" },
        "backtrack upkeep failed for one owner; the job will retry"
      );
    }
  }

  const stats: BacktrackUpkeepStats = {
    owners: owners.rows.length,
    failedOwners,
    deletedSegments,
    deletedChunks,
    deletedMarkers,
    enqueuedSegments
  };
  if (failedOwners > 0) {
    throw new Error(`backtrack upkeep failed for ${failedOwners} of ${stats.owners} owners`);
  }
  return stats;
}

export interface BacktrackWorkerDeps {
  readonly dataContext: DataContextRunner;
  readonly rootDb: Kysely<MossDatabase>;
  readonly embeddingProviderFactory: (scopedDb: DataContextDb) => Promise<EmbeddingProvider>;
  readonly logger?: JobLogger;
}

/** Registers the index worker and schedules and works the hourly upkeep (plan §4.5 and §4.6). */
export async function registerBacktrackWorkers(
  boss: PgBoss,
  deps: BacktrackWorkerDeps
): Promise<readonly string[]> {
  const repository = new BacktrackRepository();
  const memory = new MemoryRepository();

  const indexWorkId = await registerDataContextWorker<BacktrackIndexJobPayload, number>(
    boss,
    BACKTRACK_INDEX_QUEUE,
    deps.dataContext,
    (job, scopedDb) =>
      indexBacktrackSegments(scopedDb, job.data.actorUserId, job.data.segmentIds, {
        repository,
        memory,
        embeddingProviderFactory: deps.embeddingProviderFactory
      })
  );

  assertMetadataOnlyPayload(BACKTRACK_UPKEEP_PAYLOAD);
  await boss.schedule(BACKTRACK_UPKEEP_QUEUE, BACKTRACK_UPKEEP_CRON, BACKTRACK_UPKEEP_PAYLOAD, {
    tz: "UTC",
    key: BACKTRACK_UPKEEP_QUEUE
  });
  const upkeepWorkId = await boss.work(BACKTRACK_UPKEEP_QUEUE, async () =>
    runBacktrackUpkeep({
      rootDb: deps.rootDb,
      dataContext: deps.dataContext,
      boss,
      repository,
      memory,
      logger: deps.logger
    })
  );

  return [indexWorkId, upkeepWorkId];
}
