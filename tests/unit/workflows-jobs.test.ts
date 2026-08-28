import { describe, expect, it } from "vitest";
import type { PgBoss } from "@moss/jobs";
import {
  WORKFLOW_QUEUE_DEFINITIONS,
  WORKFLOW_STEP_EXECUTE_QUEUE,
  assertWorkflowStepJobPayload,
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
      id: "00000000-0000-4000-8000-000000000003",
      workflowRunId: "00000000-0000-4000-8000-000000000002",
      ownerUserId: "00000000-0000-4000-8000-000000000001",
      status: "pending" as const,
      attemptCount: 2,
      queueJobId: null
    };

    await expect(enqueueWorkflowStep(boss, step, { startAfter: 100 })).resolves.toBe("job-1");
    expect(calls).toEqual([
      [
        WORKFLOW_STEP_EXECUTE_QUEUE,
        {
          actorUserId: "00000000-0000-4000-8000-000000000001",
          workflowRunId: "00000000-0000-4000-8000-000000000002",
          stepRunId: "00000000-0000-4000-8000-000000000003"
        },
        { singletonKey: "00000000-0000-4000-8000-000000000003:2", startAfter: 0.1 }
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
      options: {
        policy: "exclusive",
        deadLetter: "workflow.step.deadletter",
        expireInSeconds: 23 * 60 * 60,
        heartbeatSeconds: 10 * 60
      }
    });
  });

  it.each(["workflowRunId", "stepRunId"] as const)(
    "rejects a malformed %s before it reaches the database",
    (field) => {
      const payload = {
        actorUserId: "00000000-0000-4000-8000-000000000001",
        workflowRunId: "00000000-0000-4000-8000-000000000002",
        stepRunId: "00000000-0000-4000-8000-000000000003"
      };
      payload[field] = "not-a-uuid";

      expect(() => assertWorkflowStepJobPayload(payload)).toThrow(`${field} must be a UUID`);
    }
  );
});
