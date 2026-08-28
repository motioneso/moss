import { describe, expect, it } from "vitest";
import type { PgBoss } from "@moss/jobs";
import {
  WORKFLOW_QUEUE_DEFINITIONS,
  WORKFLOW_STEP_EXECUTE_QUEUE,
  enqueueWorkflowStep,
  workflowStepBackoffMs,
  workflowStepSingletonKey
} from "@moss/workflows";

describe("workflow step jobs", () => {
  it("uses a fresh singleton key for each attempt and bounded backoff", () => {
    expect(workflowStepSingletonKey("step-1", 2)).toBe("step-1:2");
    expect(
      workflowStepBackoffMs({ maxAttempts: 3, backoffMs: 100, backoff: "exponential" }, 3)
    ).toBe(400);
  });

  it("sends only actor and workflow ids, and skips terminal or claimed steps", async () => {
    const calls: unknown[][] = [];
    const boss = {
      send: async (...args: unknown[]) => {
        calls.push(args);
        return "job-1";
      }
    } as unknown as PgBoss;
    const step = {
      id: "step-1",
      workflowRunId: "run-1",
      ownerUserId: "user-1",
      status: "pending" as const,
      attemptCount: 2,
      queueJobId: null
    };

    await expect(enqueueWorkflowStep(boss, step, { startAfter: 100 })).resolves.toBe("job-1");
    expect(calls).toEqual([
      [
        WORKFLOW_STEP_EXECUTE_QUEUE,
        { actorUserId: "user-1", workflowRunId: "run-1", stepRunId: "step-1" },
        { singletonKey: "step-1:2", startAfter: 100 }
      ]
    ]);
    await expect(enqueueWorkflowStep(boss, { ...step, status: "succeeded" })).resolves.toBeNull();
    await expect(enqueueWorkflowStep(boss, { ...step, queueJobId: "job-2" })).resolves.toBeNull();
  });

  it("declares the execute queue as exclusive and dead-lettered", () => {
    expect(
      WORKFLOW_QUEUE_DEFINITIONS.find((queue) => queue.name === WORKFLOW_STEP_EXECUTE_QUEUE)
    ).toMatchObject({
      name: WORKFLOW_STEP_EXECUTE_QUEUE,
      options: { policy: "exclusive", deadLetter: "workflow.step.deadletter" }
    });
  });
});
