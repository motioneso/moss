import type { Job, PgBoss } from "pg-boss";
import { MODULE_BUILD_QUEUE } from "./pg-boss.js";
import type { sendJob } from "./pg-boss.js";

export { MODULE_BUILD_QUEUE };

export interface ModuleBuildPayload {
  readonly actorUserId: string;
  readonly buildId: string;
  readonly step?: string;
}

export interface ModuleBuildStepResult {
  readonly deferred: boolean;
  readonly continuation?: { readonly buildId: string; readonly step: string };
  readonly moduleId?: string;
}

type ModuleBuildJob = Pick<Job<ModuleBuildPayload>, "data">;

export function createModuleBuildWorker(deps: {
  sendJob: typeof sendJob;
  boss: PgBoss;
  runStep: (payload: ModuleBuildPayload) => Promise<ModuleBuildStepResult>;
}) {
  return async (jobs: ModuleBuildJob[]) => {
    const job = jobs[0];
    if (!job) throw new Error("module build worker received no job");
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
