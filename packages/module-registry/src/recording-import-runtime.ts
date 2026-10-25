import type { DataContextRunner } from "@moss/db";
import { sql } from "kysely";
import { createPgBossClient, startJobQueueWakeup, type PgBoss } from "@moss/jobs";
import {
  ConfiguredTranscriptionError,
  createConfiguredTranscription,
  type ActiveModulesResolver
} from "@moss/ai";
import {
  createRecordingImportScheduler,
  createImportedMeetingSummaryScheduler,
  registerRecordingImportWorker,
  RECORDING_IMPORT_QUEUE,
  type RecordingImportDependencies
} from "@moss/meetings";
import { HttpError } from "@moss/module-sdk";
import { getVaultBaseDir, VaultContextRunner } from "@moss/vault";
export function createRecordingImportRuntime(deps: {
  dataContext: DataContextRunner;
  boss: PgBoss;
  resolveActiveModules: ActiveModulesResolver;
  admitVoiceRequest?: RecordingImportDependencies["admitVoiceRequest"];
}): RecordingImportDependencies {
  const transcription = createConfiguredTranscription({ dataContext: deps.dataContext });
  return {
    dataContext: deps.dataContext,
    admitVoiceRequest: deps.admitVoiceRequest,
    vault: new VaultContextRunner(getVaultBaseDir()),
    schedule: createRecordingImportScheduler(deps.boss),
    scheduleSummary: createImportedMeetingSummaryScheduler(deps.boss),
    availability: transcription.availability,
    transcribe: transcription.transcribe,
    async assertAvailable(actor) {
      const owner = await deps.dataContext.withDataContext(
        actor,
        async (db) =>
          (
            await sql<{
              status: string;
            }>`SELECT status FROM app.get_user_by_id(${actor.actorUserId}::uuid)`.execute(db.db)
          ).rows[0]
      );
      if (owner?.status !== "active") throw new HttpError(403, "Recording owner unavailable");
      if (
        !(await deps.resolveActiveModules(actor.actorUserId)).some(
          (module) => module.id === "meetings"
        )
      )
        throw new HttpError(404, "Meetings unavailable");
    },
    describeFailure(error) {
      return {
        retryable: error instanceof ConfiguredTranscriptionError && error.retryable,
        unavailable:
          error instanceof HttpError ||
          (error instanceof ConfiguredTranscriptionError &&
            (error.code === "unavailable" || error.code === "route-changed"))
      };
    }
  };
}

/** Queue claims use worker credentials; private work uses the API's app actor context. */
export function createRecordingImportWorkerRuntime(
  workerConnectionString: string,
  deps: Parameters<typeof createRecordingImportRuntime>[0]
) {
  const consumer = createPgBossClient(workerConnectionString);
  let started = false;
  let wakeup: ReturnType<typeof startJobQueueWakeup> | undefined;
  return {
    async start() {
      try {
        await consumer.start();
        const ids = await registerRecordingImportWorker(
          consumer,
          createRecordingImportRuntime(deps)
        );
        wakeup = startJobQueueWakeup(workerConnectionString, RECORDING_IMPORT_QUEUE, consumer, ids);
        await wakeup.ready;
        started = true;
      } catch (error) {
        await wakeup?.stop();
        await consumer.stop({ graceful: true });
        throw error;
      }
    },
    async close() {
      if (!started) return;
      await wakeup?.stop();
      await consumer.offWork(RECORDING_IMPORT_QUEUE, { wait: true });
      await consumer.stop({ graceful: true });
      started = false;
    }
  };
}
