import type { ActiveModulesResolver } from "@moss/ai";
import type { VoiceRequestService } from "@moss/chat";
import type { DataContextRunner } from "@moss/db";
import type { PgBoss } from "@moss/jobs";
import {
  createRecordingImportWorkerRuntime,
  createVoiceRequestWorkerRuntime
} from "@moss/module-registry";

export interface CompanionDeliveryOverrides {
  readonly recordingImportWorker?: ReturnType<typeof createRecordingImportWorkerRuntime>;
  readonly voiceRequestWorker?: ReturnType<typeof createVoiceRequestWorkerRuntime>;
}

/** The API owns both consumers and binds voice work to this server's ordinary Chat runtime. */
export function createCompanionDeliveryRuntime(
  deps: {
    readonly workerConnectionString: string;
    readonly dataContext: DataContextRunner;
    readonly boss: PgBoss;
    readonly resolveActiveModules: ActiveModulesResolver;
  },
  overrides: CompanionDeliveryOverrides = {}
) {
  let voiceRequests: VoiceRequestService | undefined;
  const recording =
    overrides.recordingImportWorker ??
    createRecordingImportWorkerRuntime(deps.workerConnectionString, deps);
  const voice =
    overrides.voiceRequestWorker ??
    createVoiceRequestWorkerRuntime(deps.workerConnectionString, () => voiceRequests);
  const close = async () => {
    const results = await Promise.allSettled([recording.close(), voice.close()]);
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    );
    if (errors.length) throw new AggregateError(errors, "Companion delivery shutdown failed");
  };
  return {
    adoptVoiceRequestService(service: VoiceRequestService) {
      voiceRequests = service;
    },
    async start() {
      try {
        await recording.start();
        await voice.start();
      } catch (error) {
        await close();
        throw error;
      }
    },
    close
  };
}
export type CompanionDeliveryRuntime = ReturnType<typeof createCompanionDeliveryRuntime>;
