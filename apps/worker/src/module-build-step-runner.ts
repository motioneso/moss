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
  touchModuleBuildActivity as touchModuleBuildActivityFn,
  updateModuleBuildStatus as updateModuleBuildStatusFn
} from "@moss/settings";
import type { RunModuleBuildStepDeps } from "@moss/ai";

/**
 * #2154. The `module_builds.error` column is a sink — it is read back and shown to the build's
 * owner, so an arbitrary caught `error.message` can leak a filesystem path or other raw detail
 * (the same trap `packages/notes/src/error-sink.ts` was written to close). A throw site marks its
 * own message safe by using this class instead of a plain `Error`; anything else degrades to a
 * generic sentence naming only the error's class name, never its message.
 */
export class ModuleBuildSafeError extends Error {
  constructor(safeMessage: string) {
    super(safeMessage);
    this.name = "ModuleBuildSafeError";
  }
}

const SAFE_CLASS_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

function safeModuleBuildErrorMessage(error: unknown): string {
  if (error instanceof ModuleBuildSafeError) return error.message;
  const name = error instanceof Error ? error.name : undefined;
  return name && SAFE_CLASS_NAME.test(name)
    ? `module build failed (${name})`
    : "module build failed";
}

export interface RunModuleBuildStepForJobDeps {
  readonly dataContext: Pick<DataContextRunner, "withDataContext">;
  readonly getModuleBuild: typeof getModuleBuildFn;
  readonly touchModuleBuildActivity: typeof touchModuleBuildActivityFn;
  readonly updateModuleBuildStatus: typeof updateModuleBuildStatusFn;
  readonly prepareRunStepDeps: (
    scopedDb: DataContextDb,
    access: AccessContext
  ) => Promise<RunModuleBuildStepDeps>;
  readonly runStep: (
    deps: RunModuleBuildStepDeps,
    build: ModuleBuild,
    signal?: AbortSignal
  ) => Promise<ModuleBuildStepResult>;
  readonly notifyFinished: (scopedDb: DataContextDb, buildId: string) => Promise<unknown>;
  readonly notifyFailed: (scopedDb: DataContextDb, buildId: string) => Promise<unknown>;
}

export function createRunModuleBuildStepForJob(
  deps: RunModuleBuildStepForJobDeps
): (payload: ModuleBuildPayload) => Promise<ModuleBuildStepResult> {
  return async (payload) => {
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let heartbeatPending = false;
    const controller = new AbortController();
    const access: AccessContext = {
      actorUserId: payload.actorUserId,
      requestId: `module-build:${payload.buildId}`
    };
    try {
      return await deps.dataContext.withDataContext(access, async (scopedDb) => {
        const build = await deps.getModuleBuild(scopedDb, payload.buildId);
        if (!build || build.ownerUserId !== access.actorUserId)
          throw new ModuleBuildSafeError("module build was not found");
        if (build.status === "cancelled" || build.status === "failed") {
          return { deferred: false };
        }

        const stepDeps = await deps.prepareRunStepDeps(scopedDb, access);
        heartbeat = setInterval(() => {
          if (heartbeatPending) return;
          heartbeatPending = true;
          void deps.dataContext
            .withDataContext(access, async (heartbeatDb) => {
              const current = await deps.getModuleBuild(heartbeatDb, build.id);
              if (controller.signal.aborted) return;
              if (
                !current ||
                current.ownerUserId !== access.actorUserId ||
                current.status === "cancelled" ||
                current.status === "failed"
              ) {
                controller.abort();
                return;
              }
              await deps.touchModuleBuildActivity(heartbeatDb, build.id);
            })
            .catch(() => controller.abort())
            .finally(() => {
              heartbeatPending = false;
            });
        }, 5_000);
        const result = await deps.runStep(stepDeps, build, controller.signal);
        if (await wasCancelledSince(deps, scopedDb, build.id)) {
          return { deferred: false };
        }
        controller.signal.throwIfAborted();
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
      });
    } catch (error) {
      await deps.dataContext.withDataContext(access, async (scopedDb) => {
        const build = await deps.getModuleBuild(scopedDb, payload.buildId);
        if (!build || build.ownerUserId !== access.actorUserId || build.status === "cancelled")
          return;
        await deps.updateModuleBuildStatus(scopedDb, build.id, {
          status: "failed",
          error: safeModuleBuildErrorMessage(error)
        });
        await deps.notifyFailed(scopedDb, build.id);
      });
      throw error;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      controller.abort();
    }
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
