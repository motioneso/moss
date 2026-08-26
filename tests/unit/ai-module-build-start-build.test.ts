import { describe, expect, it, vi } from "vitest";

import {
  approveModuleBuildPlan,
  cancelModuleBuild,
  startModuleBuild,
  ModuleBuildNotFoundError,
  type ApproveModuleBuildPlanDeps,
  type StartModuleBuildDeps
} from "../../packages/ai/src/module-build/start-build.js";
import type { ModuleBuildPlan } from "../../packages/ai/src/module-build/write-plan.js";

const fakePlan: ModuleBuildPlan = {
  whatItDoes: "Tracks videos",
  whatItReaches: [],
  whatItKeeps: "titles and URLs",
  whenItRuns: "on request",
  roughCost: { time: "5 minutes", budgetCents: 20 }
};

function makeDeps(overrides: { yoloActive: boolean }): StartModuleBuildDeps & {
  sendBuildJob: ReturnType<typeof vi.fn>;
  statuses: string[];
} {
  const statuses: string[] = [];
  return {
    writeModuleBuildPlan: vi.fn(async () => fakePlan),
    createModuleBuild: vi.fn(async () => ({ id: "b1" })),
    updateModuleBuildPlan: vi.fn(async () => {}),
    updateModuleBuildStatus: vi.fn(async (_buildId: string, status: string) => {
      statuses.push(status);
    }),
    isYoloActiveForActor: vi.fn(async () => overrides.yoloActive),
    sendBuildJob: vi.fn(async () => {}),
    statuses
  };
}

describe("startModuleBuild", () => {
  it("with YOLO off, writes the plan and waits for approval without starting the build job", async () => {
    const deps = makeDeps({ yoloActive: false });

    const result = await startModuleBuild(deps, {
      actorUserId: "user-a",
      conversationId: "thread-a",
      description: "GMM videos"
    });

    expect(result.awaitingApproval).toBe(true);
    expect(result.buildId).toBe("b1");
    expect(deps.sendBuildJob).not.toHaveBeenCalled();
    expect(deps.statuses).toEqual(["awaiting_plan_approval"]);
  });

  it("with YOLO on, writes the plan and starts building immediately", async () => {
    const deps = makeDeps({ yoloActive: true });

    const result = await startModuleBuild(deps, {
      actorUserId: "user-a",
      conversationId: "thread-a",
      description: "GMM videos"
    });

    expect(result.awaitingApproval).toBe(false);
    expect(deps.sendBuildJob).toHaveBeenCalledOnce();
    expect(deps.sendBuildJob).toHaveBeenCalledWith("b1", "user-a");
    expect(deps.statuses).toEqual(["building"]);
  });
});

describe("approveModuleBuildPlan", () => {
  function makeApproveDeps(
    build: { id: string; ownerUserId: string } | null
  ): ApproveModuleBuildPlanDeps & { sendBuildJob: ReturnType<typeof vi.fn> } {
    return {
      getModuleBuild: vi.fn(async () => build),
      updateModuleBuildStatus: vi.fn(async () => {}),
      sendBuildJob: vi.fn(async () => {})
    };
  }

  it("approving a plan starts the build job", async () => {
    const deps = makeApproveDeps({ id: "b1", ownerUserId: "user-a" });

    await approveModuleBuildPlan(deps, "b1", "user-a");

    expect(deps.updateModuleBuildStatus).toHaveBeenCalledWith("b1", "building");
    expect(deps.sendBuildJob).toHaveBeenCalledWith("b1", "user-a");
  });

  it("refuses a build that does not exist", async () => {
    const deps = makeApproveDeps(null);
    await expect(approveModuleBuildPlan(deps, "missing", "user-a")).rejects.toThrow(
      ModuleBuildNotFoundError
    );
    expect(deps.sendBuildJob).not.toHaveBeenCalled();
  });

  it("refuses a build owned by someone else, same error as a missing build", async () => {
    const deps = makeApproveDeps({ id: "b1", ownerUserId: "user-b" });
    await expect(approveModuleBuildPlan(deps, "b1", "user-a")).rejects.toThrow(
      ModuleBuildNotFoundError
    );
    expect(deps.sendBuildJob).not.toHaveBeenCalled();
  });
});

describe("cancelModuleBuild", () => {
  it("cancels an owner's in-progress build", async () => {
    const updateModuleBuildStatus = vi.fn(async () => {});
    const cancelled = await cancelModuleBuild(
      {
        getModuleBuild: vi.fn(async () => ({
          id: "b1",
          ownerUserId: "user-a",
          status: "building" as const,
          moduleId: null
        })),
        updateModuleBuildStatus
      },
      "b1",
      "user-a"
    );

    expect(cancelled).toBe(true);
    expect(updateModuleBuildStatus).toHaveBeenCalledWith("b1", "cancelled");
  });

  it("does not reveal or cancel another owner's build", async () => {
    const updateModuleBuildStatus = vi.fn(async () => {});
    const cancelled = await cancelModuleBuild(
      {
        getModuleBuild: vi.fn(async () => ({
          id: "b1",
          ownerUserId: "user-b",
          status: "building" as const,
          moduleId: null
        })),
        updateModuleBuildStatus
      },
      "b1",
      "user-a"
    );

    expect(cancelled).toBe(false);
    expect(updateModuleBuildStatus).not.toHaveBeenCalled();
  });

  it("lets an owner clear a legacy finished build that never installed a module", async () => {
    const updateModuleBuildStatus = vi.fn(async () => {});
    const cancelled = await cancelModuleBuild(
      {
        getModuleBuild: vi.fn(async () => ({
          id: "b1",
          ownerUserId: "user-a",
          status: "awaiting_change" as const,
          moduleId: null
        })),
        updateModuleBuildStatus
      },
      "b1",
      "user-a"
    );
    expect(cancelled).toBe(true);
  });
});
