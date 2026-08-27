import type { Job } from "@moss/jobs";
import type { DataContextDb, DataContextRunner, MossDatabase } from "@moss/db";
import {
  type ActorScopedJobPayload,
  type PgBoss,
  type QueueDefinition,
  registerDataContextWorker,
  sendJob
} from "@moss/jobs";
import { VaultContextRunner, deleteVaultFile, getVaultBaseDir, writeVaultFile } from "@moss/vault";
import { createDatabase, getMossDatabaseUrls } from "@moss/db";
import type { MossModuleManifest } from "@moss/module-sdk";
import { sql, type Kysely } from "kysely";

import { exportUserData } from "./data-export.js";
import { DataExportRepository } from "./data-export-repository.js";
import {
  EXPORT_CLEANUP_QUEUE,
  reconcileDataExportCleanupSchedule
} from "./data-export-schedule.js";

export const EXPORT_BUILD_QUEUE = "export.build";
export { EXPORT_CLEANUP_QUEUE } from "./data-export-schedule.js";

export interface ExportBuildJobPayload extends ActorScopedJobPayload {
  readonly kind: "export.build";
  readonly jobId: string;
}

export interface ExportCleanupJobPayload {
  readonly kind: "export.cleanup";
}

export const EXPORT_QUEUE_DEFINITIONS: readonly QueueDefinition[] = [
  {
    name: EXPORT_BUILD_QUEUE,
    options: {
      retryLimit: 0,
      deleteAfterSeconds: 300,
      retentionSeconds: 300
    }
  },
  {
    name: EXPORT_CLEANUP_QUEUE,
    options: {
      retryLimit: 0,
      deleteAfterSeconds: 300,
      retentionSeconds: 300
    }
  }
];

export async function enqueueExportBuildJob(
  boss: PgBoss,
  actorUserId: string,
  jobId: string
): Promise<void> {
  await sendJob<ExportBuildJobPayload>(boss, EXPORT_BUILD_QUEUE, {
    kind: "export.build",
    jobId,
    actorUserId
  });
}

export async function handleExportBuildJob(
  job: Job<ExportBuildJobPayload>,
  scopedDb: DataContextDb,
  listModuleManifests: () => readonly MossModuleManifest[]
): Promise<void> {
  const { actorUserId, jobId } = job.data;
  const repository = new DataExportRepository();

  const authDb = createDatabase({
    connectionString: getMossDatabaseUrls().auth,
    maxConnections: 1
  });

  try {
    await repository.workerUpdateJobStatus(scopedDb, jobId, "building");

    const userExport = await exportUserData({
      scopedDb,
      authDb,
      userId: actorUserId,
      listModuleManifests,
      requestId: `export:${jobId}`
    });

    const archive = {
      format: "jarvis-archive/v1",
      exportedAt: userExport.exportedAt,
      userId: userExport.userId,
      sections: {
        profile: {
          user: userExport.tables.users[0] ?? null,
          authAccounts: userExport.tables.authAccounts,
          authSessions: userExport.tables.betterAuthSessions
        },
        preferences: userExport.tables.preferences,
        tasks: userExport.tables.tasks,
        memory: {
          chunks: userExport.tables.memoryChunks,
          facts: userExport.tables.chatMemoryFacts
        },
        structured_state: {
          commitments: userExport.tables.commitments,
          entities: userExport.tables.entities,
          medications: userExport.tables.medications,
          medication_logs: userExport.tables.medicationLogs
        },
        wellness: {
          checkins: userExport.tables.wellnessCheckins,
          therapy_notes: userExport.tables.wellnessTherapyNotes
        },
        // #953 Task 6: authored News preferences only — snapshots/fingerprints excluded by
        // the news module's collector, never re-read here.
        newsPersonalization: userExport.tables.newsPersonalization,
        sportsSources: userExport.tables.sportsSources,
        connector_metadata: userExport.tables.connectorAccounts,
        calendar_cache: userExport.tables.calendarEvents,
        email_cache: userExport.tables.emailMessages,
        ai_metadata: {
          providers: userExport.tables.aiProviderConfigs,
          models: userExport.tables.aiConfiguredModels,
          assistantActionRequests: userExport.tables.aiAssistantActionRequests
        },
        chat: {
          threads: userExport.tables.chatThreads,
          messages: userExport.tables.chatMessages
        },
        briefings: {
          definitions: userExport.tables.briefingDefinitions,
          runs: userExport.tables.briefingRuns
        },
        vault_files: []
      }
    };

    const vaultRunner = new VaultContextRunner(getVaultBaseDir());
    const accessContext = { actorUserId, requestId: `export:${jobId}` };
    await vaultRunner.withVaultContext(accessContext, async (vaultCtx) => {
      await writeVaultFile(vaultCtx, `exports/${jobId}.json`, JSON.stringify(archive, null, 2));
    });

    const completedAt = new Date();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await repository.workerCompleteJob(scopedDb, jobId, completedAt, expiresAt);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    await repository.workerFailJob(scopedDb, jobId, message.slice(0, 500));
  } finally {
    await authDb.destroy();
  }
}

export interface ExpiredExportJob {
  readonly id: string;
  readonly ownerUserId: string;
  readonly format: "json" | "html";
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

export async function listExpiredExportJobs(
  workerDb: Kysely<MossDatabase>,
  cutoff: Date
): Promise<readonly ExpiredExportJob[]> {
  const result = await sql<ExpiredExportJob>`
    SELECT id, "ownerUserId", format
    FROM app.list_expired_data_export_jobs(${cutoff})
  `.execute(workerDb);
  return result.rows;
}

export async function handleExportCleanupJob(
  _job: Job<ExportCleanupJobPayload>,
  workerDb: Kysely<MossDatabase>,
  dataContext: DataContextRunner
): Promise<void> {
  const repository = new DataExportRepository();
  const vaultRunner = new VaultContextRunner(getVaultBaseDir());
  const expiredJobs = await listExpiredExportJobs(workerDb, new Date());

  for (const expiredJob of expiredJobs) {
    await vaultRunner.withVaultContext(
      {
        actorUserId: expiredJob.ownerUserId,
        requestId: `export-cleanup:${expiredJob.id}`
      },
      async (vaultCtx) => {
        try {
          await deleteVaultFile(vaultCtx, `exports/${expiredJob.id}.${expiredJob.format}`);
        } catch (error) {
          if (!isMissingPathError(error)) {
            throw error;
          }
        }
      }
    );

    await dataContext.withDataContext(
      {
        actorUserId: expiredJob.ownerUserId,
        requestId: `export-cleanup:${expiredJob.id}`
      },
      async (scopedDb) => {
        await repository.workerUpdateJobStatus(scopedDb, expiredJob.id, "expired");
      }
    );
  }
}

export async function registerSettingsJobWorkers(
  boss: PgBoss,
  dataContext: DataContextRunner,
  workerDb: Kysely<MossDatabase>,
  listModuleManifests: () => readonly MossModuleManifest[]
): Promise<readonly string[]> {
  await reconcileDataExportCleanupSchedule(boss);
  const workId = await registerDataContextWorker<ExportBuildJobPayload, void>(
    boss,
    EXPORT_BUILD_QUEUE,
    dataContext,
    (job, scopedDb) => handleExportBuildJob(job, scopedDb, listModuleManifests)
  );
  const cleanupWorkId = await boss.work<ExportCleanupJobPayload, void>(
    EXPORT_CLEANUP_QUEUE,
    { pollingIntervalSeconds: 2 },
    async ([job]) => {
      if (!job) {
        throw new Error(`pg-boss invoked ${EXPORT_CLEANUP_QUEUE} without a job`);
      }
      await handleExportCleanupJob(job, workerDb, dataContext);
    }
  );
  return [workId, cleanupWorkId];
}
