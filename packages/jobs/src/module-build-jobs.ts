import type { PgBoss } from "pg-boss";
import { sendJob, MODULE_BUILD_QUEUE } from "./pg-boss.js";

export { MODULE_BUILD_QUEUE };

export interface ModuleBuildPayload {
  readonly actorUserId: string;
  readonly buildId: string;
  readonly step?: string;
}

export interface ModuleBuildStepResult {
  readonly deferred: boolean;
  readonly continuation?: { readonly buildId: string; readonly step: string };
}

export function createModuleBuildWorker(deps: {
  sendJob: typeof sendJob;
  boss: PgBoss;
  runStep: (payload: ModuleBuildPayload) => Promise<ModuleBuildStepResult>;
}) {
  return async ([job]: [{ data: ModuleBuildPayload }]) => {
    const result = await deps.runStep(job.data);
    if (result.deferred && result.continuation) {
      await deps.sendJob(
        deps.boss,
        MODULE_BUILD_QUEUE,
        { ...job.data, ...result.continuation },
        { singletonKey: `build:${result.continuation.buildId}` }
      );
    }
  };
}
