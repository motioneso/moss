import type { PgBoss } from "pg-boss";

import type { AccessContext, DataContextDb, DataContextRunner } from "@moss/db";
import {
  type ActorScopedJobPayload,
  type QueueDefinition,
  assertMetadataOnlyPayload,
  sendJob,
  toAccessContext
} from "@moss/jobs";
import { listVaultFilesRecursive, listVaultOwnerIds, VaultContextRunner } from "@moss/vault";
import type { VaultContext } from "@moss/vault";

import type { EmbeddingProvider } from "./embedding-provider.js";
import { MemoryIngestPipeline } from "./ingest.js";
import type { IngestFailure } from "./ingestion-service.js";
import { MemoryRepository } from "./repository.js";
import {
  isPathIngestable,
  listVaultIngestRootProviders,
  resolveIngestRoots
} from "./vault-ingest-registry.js";

const VAULT_SOURCE_KIND = "vault";

export const VAULT_INGEST_SWEEP_QUEUE = "memory.vault-ingest-sweep";
export const VAULT_INGEST_NUDGE_QUEUE = "memory.vault-ingest-nudge";
/**
 * Global (non-actor-scoped) queue: the tick handler lists ALL owner dirs and fans out one
 * VAULT_INGEST_SWEEP_QUEUE job per owner via sendJob(). This is the only clean way to do
 * cross-owner enumeration under pg-boss's per-actor RLS worker pattern — the tick, by
 * definition, has no single owning actor.
 */
export const VAULT_INGEST_TICK_QUEUE = "memory.vault-ingest-tick";

export const VAULT_INGEST_QUEUE_DEFINITIONS: readonly QueueDefinition[] = [
  { name: VAULT_INGEST_SWEEP_QUEUE },
  { name: VAULT_INGEST_NUDGE_QUEUE },
  { name: VAULT_INGEST_TICK_QUEUE }
];

export interface VaultIngestSweepPayload extends ActorScopedJobPayload {}

export interface VaultIngestNudgePayload extends ActorScopedJobPayload {
  readonly sourcePath: string;
  readonly op: "upsert" | "delete";
}

export interface VaultIngestSweepStats {
  processed: number;
  skipped: number;
  deleted: number;
  failed: IngestFailure[];
}

export interface VaultIngestWorkerDeps {
  readonly vaultRunner: VaultContextRunner;
  readonly vaultsBaseDir: string;
  readonly embeddingProviderFactory: (scopedDb: DataContextDb) => Promise<EmbeddingProvider>;
  readonly repository?: MemoryRepository;
  readonly sweepCron?: string;
}

const DEFAULT_SWEEP_CRON = "*/15 * * * *";

/**
 * Pure, directly-testable sweep. Each file gets its OWN withDataContext transaction — never one
 * shared transaction for the whole sweep — matching IngestionService.ingestVault's existing
 * per-file-txn design and avoiding the serialize/deadlock risk documented on
 * notes/jobs.ts's registerNotesJobWorkers.
 */
export async function runVaultIngestSweep(
  accessContext: AccessContext,
  vaultCtx: VaultContext,
  dataContext: DataContextRunner,
  pipeline: MemoryIngestPipeline,
  repository: MemoryRepository
): Promise<VaultIngestSweepStats> {
  const ownerUserId = accessContext.actorUserId;
  const stats: VaultIngestSweepStats = { processed: 0, skipped: 0, deleted: 0, failed: [] };

  const roots = await dataContext.withDataContext(accessContext, async (scopedDb) => {
    const all: string[] = [];
    for (const provider of listVaultIngestRootProviders()) {
      all.push(...(await resolveIngestRoots(provider, scopedDb, ownerUserId)));
    }
    return all;
  });

  const allFiles = (await listVaultFilesRecursive(vaultCtx)).filter((f) =>
    isPathIngestable(f, roots)
  );

  for (const path of allFiles) {
    try {
      const result = await dataContext.withDataContext(accessContext, (scopedDb) =>
        pipeline.ingestFile(scopedDb, vaultCtx, path)
      );
      if (result.status === "ingested") stats.processed += 1;
      else stats.skipped += 1;
    } catch (err) {
      stats.failed.push({ path, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Purge: any indexed 'vault' path NOT in the current allowlisted file set covers true deletes
  // AND files that left the allowlist (root prefix changed/shrunk). allFiles IS "should be
  // indexed", so a diff against it is simpler than re-checking isPathIngestable per indexed row.
  await dataContext.withDataContext(accessContext, async (scopedDb) => {
    const indexed = await repository.listIndexedPaths(scopedDb, ownerUserId, VAULT_SOURCE_KIND);
    const present = new Set(allFiles);
    for (const path of indexed) {
      if (!present.has(path)) {
        await pipeline.deleteFile(scopedDb, ownerUserId, path);
        stats.deleted += 1;
      }
    }
  });

  return stats;
}

/**
 * Best-effort nudge apply: catches everything and never throws — a permanently-failing nudge
 * must not retry-storm; the periodic sweep is the correctness backstop. Re-checks
 * isPathIngestable against freshly-resolved roots as defense in depth (don't trust the caller).
 */
export async function applyVaultIngestNudge(
  accessContext: AccessContext,
  vaultCtx: VaultContext,
  dataContext: DataContextRunner,
  pipeline: MemoryIngestPipeline,
  sourcePath: string,
  op: "upsert" | "delete"
): Promise<void> {
  try {
    const ownerUserId = accessContext.actorUserId;
    const roots = await dataContext.withDataContext(accessContext, async (scopedDb) => {
      const all: string[] = [];
      for (const provider of listVaultIngestRootProviders()) {
        all.push(...(await resolveIngestRoots(provider, scopedDb, ownerUserId)));
      }
      return all;
    });
    if (!isPathIngestable(sourcePath, roots)) return;

    if (op === "delete") {
      await dataContext.withDataContext(accessContext, (scopedDb) =>
        pipeline.deleteFile(scopedDb, ownerUserId, sourcePath)
      );
    } else {
      await dataContext.withDataContext(accessContext, (scopedDb) =>
        pipeline.ingestFile(scopedDb, vaultCtx, sourcePath)
      );
    }
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "vault_ingest_nudge_failed",
        actorUserId: accessContext.actorUserId,
        sourcePath,
        op,
        error: err instanceof Error ? err.message : String(err)
      })
    );
  }
}

/**
 * Best-effort scheduling wrapper — callers (e.g. notes-service.ts after a vault write) must not
 * fail their own operation because nudge scheduling failed.
 */
export async function scheduleVaultIngestNudge(
  boss: PgBoss,
  payload: VaultIngestNudgePayload
): Promise<void> {
  try {
    assertMetadataOnlyPayload(payload);
    await sendJob(boss, VAULT_INGEST_NUDGE_QUEUE, payload);
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "vault_ingest_nudge_schedule_failed",
        actorUserId: payload.actorUserId,
        sourcePath: payload.sourcePath,
        error: err instanceof Error ? err.message : String(err)
      })
    );
  }
}

export async function registerVaultIngestWorkers(
  boss: PgBoss,
  dataContext: DataContextRunner,
  deps: VaultIngestWorkerDeps
): Promise<readonly string[]> {
  const repository = deps.repository ?? new MemoryRepository();

  const sweepWorkId = await boss.work<VaultIngestSweepPayload, VaultIngestSweepStats>(
    VAULT_INGEST_SWEEP_QUEUE,
    { pollingIntervalSeconds: 2 },
    async ([job]) => {
      if (!job) throw new Error(`pg-boss invoked ${VAULT_INGEST_SWEEP_QUEUE} without a job`);
      const accessContext = toAccessContext(job);
      return dataContext.withDataContext(accessContext, async (scopedDb) => {
        const embeddingProvider = await deps.embeddingProviderFactory(scopedDb);
        const pipeline = new MemoryIngestPipeline(embeddingProvider, repository);
        return deps.vaultRunner.withVaultContext(accessContext, (vaultCtx) =>
          runVaultIngestSweep(accessContext, vaultCtx, dataContext, pipeline, repository)
        );
      });
    }
  );

  const nudgeWorkId = await boss.work<VaultIngestNudgePayload, void>(
    VAULT_INGEST_NUDGE_QUEUE,
    { pollingIntervalSeconds: 2 },
    async ([job]) => {
      if (!job) throw new Error(`pg-boss invoked ${VAULT_INGEST_NUDGE_QUEUE} without a job`);
      const accessContext = toAccessContext(job);
      return dataContext.withDataContext(accessContext, async (scopedDb) => {
        const embeddingProvider = await deps.embeddingProviderFactory(scopedDb);
        const pipeline = new MemoryIngestPipeline(embeddingProvider, repository);
        return deps.vaultRunner.withVaultContext(accessContext, (vaultCtx) =>
          applyVaultIngestNudge(
            accessContext,
            vaultCtx,
            dataContext,
            pipeline,
            job.data.sourcePath,
            job.data.op
          )
        );
      });
    }
  );

  const tickWorkId = await boss.work<Record<string, never>, void>(
    VAULT_INGEST_TICK_QUEUE,
    { pollingIntervalSeconds: 2 },
    async () => {
      const ownerIds = await listVaultOwnerIds(deps.vaultsBaseDir);
      for (const actorUserId of ownerIds) {
        await sendJob(boss, VAULT_INGEST_SWEEP_QUEUE, { actorUserId });
      }
    }
  );

  const scheduleData: Record<string, never> = {};
  assertMetadataOnlyPayload(scheduleData);
  await boss.schedule(VAULT_INGEST_TICK_QUEUE, deps.sweepCron ?? DEFAULT_SWEEP_CRON, scheduleData, {
    tz: "UTC"
  });

  return [sweepWorkId, nudgeWorkId, tickWorkId];
}
