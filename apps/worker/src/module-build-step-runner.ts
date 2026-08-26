// apps/worker/src/module-build-step-runner.ts
//
// #1975 Task 3: extracted from the inline closure that used to live in worker.ts (the
// `createExternalModuleJobHandler` factory shape below is that same file's precedent for
// making a worker job handler unit-testable with fakes instead of a real database or live
// agent). The one behavior this extraction adds on top of the original closure: a build can
// be cancelled (see cancelModuleBuild in @moss/settings) by the owner clicking "Stop" while
// its current step is still running in a live agent. Without a re-check right before each
// status write, that write would land after the cancel and flip the build straight back to
// "building"/"awaiting_change"/"failed" — silently undoing the cancel the user just asked for.
import type { AccessContext, DataContextDb, DataContextRunner } from "@moss/db";
import type { ModuleBuildPayload, ModuleBuildStepResult } from "@moss/jobs";
import type {
  ModuleBuild,
  UpdateModuleBuildStatusInput,
  getModuleBuild as getModuleBuildFn,
  updateModuleBuildStatus as updateModuleBuildStatusFn
} from "@moss/settings";
import type { RunModuleBuildStepDeps } from "@moss/ai";

export interface RunModuleBuildStepForJobDeps {
  readonly dataContext: Pick<DataContextRunner, "withDataContext">;
  readonly getModuleBuild: typeof getModuleBuildFn;
  readonly updateModuleBuildStatus: typeof updateModuleBuildStatusFn;
  /** Builds the step deps (live agent, working dir, fetched/written recorders) for this build. */
  readonly prepareRunStepDeps: (scopedDb: DataContextDb) => Promise<RunModuleBuildStepDeps>;
  readonly runStep: (
    deps: RunModuleBuildStepDeps,
    build: ModuleBuild
  ) => Promise<ModuleBuildStepResult>;
  readonly notifyFinished: (scopedDb: DataContextDb, buildId: string) => Promise<unknown>;
  readonly notifyFailed: (scopedDb: DataContextDb, buildId: string) => Promise<unknown>;
}

export function createRunModuleBuildStepForJob(
  deps: RunModuleBuildStepForJobDeps
): (payload: ModuleBuildPayload) => Promise<ModuleBuildStepResult> {
  return async (payload) => {
    const access: AccessContext = {
      actorUserId: payload.actorUserId,
      requestId: `module-build:${payload.buildId}`
    };
    return deps.dataContext.withDataContext(access, async (scopedDb) => {
      const build = await deps.getModuleBuild(scopedDb, payload.buildId);
      if (!build) throw new Error("module build was not found");
      if (build.status === "cancelled") {
        return { deferred: false };
      }

      const stepDeps = await deps.prepareRunStepDeps(scopedDb);

      try {
        const result = await deps.runStep(stepDeps, build);
        if (await wasCancelledSince(deps, scopedDb, build.id)) {
          return { deferred: false };
        }
        const statusInput: UpdateModuleBuildStatusInput = {
          status: result.continuation ? "building" : "awaiting_change",
          ...(result.continuation
            ? { step: result.continuation.step }
            : { step: null, moduleId: result.moduleId })
        };
        await deps.updateModuleBuildStatus(scopedDb, build.id, statusInput);
        if (!result.continuation) {
          await deps.notifyFinished(scopedDb, build.id);
        }
        return result;
      } catch (error) {
        if (await wasCancelledSince(deps, scopedDb, build.id)) {
          throw error;
        }
        await deps.updateModuleBuildStatus(scopedDb, build.id, {
          status: "failed",
          error: error instanceof Error ? error.name : "unknown error"
        });
        await deps.notifyFailed(scopedDb, build.id);
        throw error;
      }
    });
  };
}

async function wasCancelledSince(
  deps: Pick<RunModuleBuildStepForJobDeps, "getModuleBuild">,
  scopedDb: DataContextDb,
  buildId: string
): Promise<boolean> {
  const current = await deps.getModuleBuild(scopedDb, buildId);
  return current?.status === "cancelled";
}
