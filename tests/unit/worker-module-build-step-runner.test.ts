// #1975 Task 3: a build cancelled by the owner while its step is mid-flight must not get
// silently flipped back to "building"/"awaiting_change"/"failed" once that step resolves. The
// job handler re-fetches the build right before every status write and skips the write (and the
// notification) if someone cancelled it in the meantime. Same fake-dependency style as
// external-module-job-handler's own tests: every collaborator is a plain injected function, so
// no real database or live agent is needed to prove the guard.
import { describe, expect, it, vi } from "vitest";

import { dataContextBrand, type AccessContext, type DataContextDb } from "@moss/db";
import type { ModuleBuildPayload, ModuleBuildStepResult } from "@moss/jobs";
import type { ModuleBuild } from "@moss/settings";

import {
  createRunModuleBuildStepForJob,
  ModuleBuildSafeError
} from "../../apps/worker/src/module-build-step-runner.js";

function fakeScopedDb(): DataContextDb {
  return { db: {}, [dataContextBrand]: true } as unknown as DataContextDb;
}

function build(overrides: Partial<ModuleBuild> = {}): ModuleBuild {
  return {
    id: "b-1",
    ownerUserId: "owner-1",
    conversationId: null,
    status: "building",
    plan: null,
    step: null,
    moduleId: null,
    fetchedUrls: [],
    writtenFiles: [],
    costCents: 0,
    error: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides
  };
}

function payload(): ModuleBuildPayload {
  return { actorUserId: "owner-1", buildId: "b-1" };
}

/** Runs `work` against a fresh fake scoped db, mirroring DataContextRunner.withDataContext. */
function fakeDataContext() {
  return {
    withDataContext: async <T>(
      _access: AccessContext,
      work: (scopedDb: DataContextDb) => Promise<T>
    ): Promise<T> => work(fakeScopedDb())
  };
}

describe("createRunModuleBuildStepForJob", () => {
  it("publishes fresh activity while a real build step is still running", async () => {
    vi.useFakeTimers();
    let finishStep!: (result: ModuleBuildStepResult) => void;
    const touchModuleBuildActivity = vi.fn(async () => {});
    const dependencies = {
      dataContext: fakeDataContext(),
      getModuleBuild: vi.fn(async () => build({ status: "building" })),
      updateModuleBuildStatus: vi.fn(async () => {}),
      touchModuleBuildActivity,
      prepareRunStepDeps: async () => ({}) as never,
      runStep: vi.fn(
        async () =>
          new Promise<ModuleBuildStepResult>((resolve) => {
            finishStep = resolve;
          })
      ),
      notifyFinished: vi.fn(async () => {}),
      notifyFailed: vi.fn(async () => {})
    };

    try {
      const pending = createRunModuleBuildStepForJob(dependencies)(payload());
      await vi.advanceTimersByTimeAsync(15_000);

      expect(touchModuleBuildActivity).toHaveBeenCalledWith(expect.anything(), "b-1");

      finishStep({ deferred: false });
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });

  it("never runs the step or writes a status for a build that is already cancelled", async () => {
    const getModuleBuild = vi.fn(async () => build({ status: "cancelled" }));
    const updateModuleBuildStatus = vi.fn(async () => {});
    const runStep = vi.fn(async () => ({ deferred: false }));
    const notifyFinished = vi.fn(async () => {});
    const notifyFailed = vi.fn(async () => {});

    const runJob = createRunModuleBuildStepForJob({
      dataContext: fakeDataContext(),
      getModuleBuild,
      touchModuleBuildActivity: vi.fn(async () => {}),
      updateModuleBuildStatus,
      prepareRunStepDeps: async () => ({}) as never,
      runStep,
      notifyFinished,
      notifyFailed
    });

    const result = await runJob(payload());

    expect(result).toEqual({ deferred: false });
    expect(runStep).not.toHaveBeenCalled();
    expect(updateModuleBuildStatus).not.toHaveBeenCalled();
    expect(notifyFinished).not.toHaveBeenCalled();
  });

  it("does not overwrite the status when the build was cancelled while the step was running", async () => {
    let call = 0;
    const getModuleBuild = vi.fn(async () => {
      call += 1;
      // First read (before the step): still building. Second read (right before the
      // status write): the cancel landed while runStep was in flight.
      return call === 1 ? build({ status: "building" }) : build({ status: "cancelled" });
    });
    const updateModuleBuildStatus = vi.fn(async () => {});
    const runStep = vi.fn(async () => ({ deferred: false }));
    const notifyFinished = vi.fn(async () => {});
    const notifyFailed = vi.fn(async () => {});

    const runJob = createRunModuleBuildStepForJob({
      dataContext: fakeDataContext(),
      getModuleBuild,
      touchModuleBuildActivity: vi.fn(async () => {}),
      updateModuleBuildStatus,
      prepareRunStepDeps: async () => ({}) as never,
      runStep,
      notifyFinished,
      notifyFailed
    });

    const result = await runJob(payload());

    expect(runStep).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ deferred: false });
    expect(updateModuleBuildStatus).not.toHaveBeenCalled();
    expect(notifyFinished).not.toHaveBeenCalled();
  });

  it("does not overwrite a cancelled build after the step fails, and still rethrows", async () => {
    let call = 0;
    const getModuleBuild = vi.fn(async () => {
      call += 1;
      return call === 1 ? build({ status: "building" }) : build({ status: "cancelled" });
    });
    const updateModuleBuildStatus = vi.fn(async () => {});
    const runStep = vi.fn(async () => {
      throw new Error("live agent crashed");
    });
    const notifyFinished = vi.fn(async () => {});
    const notifyFailed = vi.fn(async () => {});

    const runJob = createRunModuleBuildStepForJob({
      dataContext: fakeDataContext(),
      getModuleBuild,
      touchModuleBuildActivity: vi.fn(async () => {}),
      updateModuleBuildStatus,
      prepareRunStepDeps: async () => ({}) as never,
      runStep,
      notifyFinished,
      notifyFailed
    });

    await expect(runJob(payload())).rejects.toThrow("live agent crashed");
    expect(updateModuleBuildStatus).not.toHaveBeenCalled();
    expect(notifyFailed).not.toHaveBeenCalled();
  });

  it("writes the finished status and notifies when the build was not cancelled (regression)", async () => {
    const getModuleBuild = vi.fn(async () => build({ status: "building" }));
    const updateModuleBuildStatus = vi.fn(async () => {});
    const runStep = vi.fn(async () => ({ deferred: false }));
    const notifyFinished = vi.fn(async () => {});
    const notifyFailed = vi.fn(async () => {});

    const runJob = createRunModuleBuildStepForJob({
      dataContext: fakeDataContext(),
      getModuleBuild,
      touchModuleBuildActivity: vi.fn(async () => {}),
      updateModuleBuildStatus,
      prepareRunStepDeps: async () => ({}) as never,
      runStep,
      notifyFinished,
      notifyFailed
    });

    const result = await runJob(payload());

    expect(result).toEqual({ deferred: false });
    expect(updateModuleBuildStatus).toHaveBeenCalledWith(
      expect.anything(),
      "b-1",
      expect.objectContaining({ status: "awaiting_change" })
    );
    expect(notifyFinished).toHaveBeenCalledTimes(1);
    expect(notifyFailed).not.toHaveBeenCalled();
  });

  it("writes the continuation status without notifying when the step defers to another step (regression)", async () => {
    const getModuleBuild = vi.fn(async () => build({ status: "building" }));
    const updateModuleBuildStatus = vi.fn(async () => {});
    const runStep = vi.fn(async () => ({
      deferred: true,
      continuation: { buildId: "b-1", step: "writing_tests" }
    }));
    const notifyFinished = vi.fn(async () => {});
    const notifyFailed = vi.fn(async () => {});

    const runJob = createRunModuleBuildStepForJob({
      dataContext: fakeDataContext(),
      getModuleBuild,
      touchModuleBuildActivity: vi.fn(async () => {}),
      updateModuleBuildStatus,
      prepareRunStepDeps: async () => ({}) as never,
      runStep,
      notifyFinished,
      notifyFailed
    });

    const result = await runJob(payload());

    expect(result).toEqual({
      deferred: true,
      continuation: { buildId: "b-1", step: "writing_tests" }
    });
    expect(updateModuleBuildStatus).toHaveBeenCalledWith(
      expect.anything(),
      "b-1",
      expect.objectContaining({ status: "building", step: "writing_tests" })
    );
    expect(notifyFinished).not.toHaveBeenCalled();
  });

  it("writes the failed status and notifies when the step throws on a build that was not cancelled (regression)", async () => {
    const getModuleBuild = vi.fn(async () => build({ status: "building" }));
    const updateModuleBuildStatus = vi.fn(async () => {});
    const runStep = vi.fn(async () => {
      throw new Error("boom");
    });
    const notifyFinished = vi.fn(async () => {});
    const notifyFailed = vi.fn(async () => {});

    const runJob = createRunModuleBuildStepForJob({
      dataContext: fakeDataContext(),
      getModuleBuild,
      touchModuleBuildActivity: vi.fn(async () => {}),
      updateModuleBuildStatus,
      prepareRunStepDeps: async () => ({}) as never,
      runStep,
      notifyFinished,
      notifyFailed
    });

    await expect(runJob(payload())).rejects.toThrow("boom");
    expect(updateModuleBuildStatus).toHaveBeenCalledWith(
      expect.anything(),
      "b-1",
      expect.objectContaining({ status: "failed", error: "module build failed (Error)" })
    );
    expect(notifyFailed).toHaveBeenCalledTimes(1);
  });

  it("preserves the thrown error's real message instead of just its name (#2154)", async () => {
    const getModuleBuild = vi.fn(async () => build({ status: "building" }));
    const updateModuleBuildStatus = vi.fn(async () => {});
    const runStep = vi.fn(async () => {
      throw new ModuleBuildSafeError(
        "generated module failed validation: jarvis.module.json is too large"
      );
    });
    const notifyFinished = vi.fn(async () => {});
    const notifyFailed = vi.fn(async () => {});

    const runJob = createRunModuleBuildStepForJob({
      dataContext: fakeDataContext(),
      getModuleBuild,
      touchModuleBuildActivity: vi.fn(async () => {}),
      updateModuleBuildStatus,
      prepareRunStepDeps: async () => ({}) as never,
      runStep,
      notifyFinished,
      notifyFailed
    });

    await expect(runJob(payload())).rejects.toThrow();
    expect(updateModuleBuildStatus).toHaveBeenCalledWith(
      expect.anything(),
      "b-1",
      expect.objectContaining({
        status: "failed",
        error: "generated module failed validation: jarvis.module.json is too large"
      })
    );
  });

  it("does not retry against a build already marked failed (#2154)", async () => {
    const getModuleBuild = vi.fn(async () => build({ status: "failed" }));
    const updateModuleBuildStatus = vi.fn(async () => {});
    const prepareRunStepDeps = vi.fn(async () => ({}) as never);
    const runStep = vi.fn(async () => ({ deferred: false }) as ModuleBuildStepResult);
    const notifyFinished = vi.fn(async () => {});
    const notifyFailed = vi.fn(async () => {});

    const runJob = createRunModuleBuildStepForJob({
      dataContext: fakeDataContext(),
      getModuleBuild,
      touchModuleBuildActivity: vi.fn(async () => {}),
      updateModuleBuildStatus,
      prepareRunStepDeps,
      runStep,
      notifyFinished,
      notifyFailed
    });

    const result = await runJob(payload());

    expect(result).toEqual({ deferred: false });
    expect(prepareRunStepDeps).not.toHaveBeenCalled();
    expect(runStep).not.toHaveBeenCalled();
    expect(updateModuleBuildStatus).not.toHaveBeenCalled();
    expect(notifyFinished).not.toHaveBeenCalled();
    expect(notifyFailed).not.toHaveBeenCalled();
  });

  it("commits the failed status after the step transaction rolls back", async () => {
    let committedStatus = "building";
    let stagedStatus: string | null = null;
    const dataContext = {
      withDataContext: async <T>(
        _access: AccessContext,
        work: (scopedDb: DataContextDb) => Promise<T>
      ): Promise<T> => {
        stagedStatus = null;
        try {
          const result = await work(fakeScopedDb());
          if (stagedStatus) committedStatus = stagedStatus;
          return result;
        } finally {
          stagedStatus = null;
        }
      }
    };
    const runJob = createRunModuleBuildStepForJob({
      dataContext,
      getModuleBuild: vi.fn(async () => build({ status: committedStatus as "building" })),
      touchModuleBuildActivity: vi.fn(async () => {}),
      updateModuleBuildStatus: vi.fn(async (_db, _id, input) => {
        stagedStatus = input.status;
      }),
      prepareRunStepDeps: async () => ({}) as never,
      runStep: vi.fn(async () => {
        throw new Error("live agent crashed");
      }),
      notifyFinished: vi.fn(async () => {}),
      notifyFailed: vi.fn(async () => {})
    });

    await expect(runJob(payload())).rejects.toThrow("live agent crashed");
    expect(committedStatus).toBe("failed");
  });

  it("throws when the build cannot be found, without touching status or notifications", async () => {
    const getModuleBuild = vi.fn(async () => null);
    const updateModuleBuildStatus = vi.fn(async () => {});
    const runStep = vi.fn(async () => ({ deferred: false }));
    const notifyFinished = vi.fn(async () => {});
    const notifyFailed = vi.fn(async () => {});

    const runJob = createRunModuleBuildStepForJob({
      dataContext: fakeDataContext(),
      getModuleBuild,
      touchModuleBuildActivity: vi.fn(async () => {}),
      updateModuleBuildStatus,
      prepareRunStepDeps: async () => ({}) as never,
      runStep,
      notifyFinished,
      notifyFailed
    });

    await expect(runJob(payload())).rejects.toThrow("module build was not found");
    expect(runStep).not.toHaveBeenCalled();
    expect(updateModuleBuildStatus).not.toHaveBeenCalled();
  });
});
