import type { ActorScopedJobPayload, PgBoss, QueueDefinition } from "@moss/jobs";
import { assertMetadataOnlyPayload, sendJob } from "@moss/jobs";
import type { WorkflowStepRetryPolicy } from "@moss/module-sdk";
import type { WorkflowStepRun } from "./types.js";

export const WORKFLOW_STEP_EXECUTE_QUEUE = "workflow.step.execute";
export const WORKFLOW_STEP_DEADLETTER_QUEUE = "workflow.step.deadletter";

export interface WorkflowStepJobPayload extends ActorScopedJobPayload {
  readonly workflowRunId: string;
  readonly stepRunId: string;
}

export const WORKFLOW_QUEUE_DEFINITIONS: readonly QueueDefinition[] = [
  {
    name: WORKFLOW_STEP_DEADLETTER_QUEUE,
    options: { retryLimit: 0, deleteAfterSeconds: 60, retentionSeconds: 60 }
  },
  {
    name: WORKFLOW_STEP_EXECUTE_QUEUE,
    options: {
      policy: "exclusive",
      retryLimit: 3,
      deadLetter: WORKFLOW_STEP_DEADLETTER_QUEUE,
      deleteAfterSeconds: 60,
      retentionSeconds: 60
    }
  }
];

export function assertWorkflowStepJobPayload(
  payload: unknown
): asserts payload is WorkflowStepJobPayload {
  assertMetadataOnlyPayload(payload);
  if (
    typeof (payload as WorkflowStepJobPayload).actorUserId !== "string" ||
    typeof (payload as WorkflowStepJobPayload).workflowRunId !== "string" ||
    typeof (payload as WorkflowStepJobPayload).stepRunId !== "string"
  ) {
    throw new Error("Workflow step job payload is missing an id");
  }
}

export function workflowStepSingletonKey(stepRunId: string, attemptCount: number): string {
  return `${stepRunId}:${attemptCount}`;
}

export function workflowStepBackoffMs(
  policy: WorkflowStepRetryPolicy | undefined,
  attemptCount: number
): number {
  const base = policy?.backoffMs ?? 0;
  return policy?.backoff === "exponential" ? base * 2 ** Math.max(0, attemptCount - 1) : base;
}

export async function enqueueWorkflowStep(
  boss: PgBoss,
  stepRun: Pick<
    WorkflowStepRun,
    "id" | "status" | "queueJobId" | "attemptCount" | "ownerUserId" | "workflowRunId"
  >,
  options?: { readonly startAfter?: number }
): Promise<string | null> {
  if (
    stepRun.queueJobId ||
    stepRun.status === "succeeded" ||
    stepRun.status === "failed" ||
    stepRun.status === "cancelled" ||
    stepRun.status === "suspended"
  ) {
    return null;
  }

  const payload: WorkflowStepJobPayload = {
    actorUserId: stepRun.ownerUserId,
    workflowRunId: stepRun.workflowRunId,
    stepRunId: stepRun.id
  };
  assertWorkflowStepJobPayload(payload);
  return sendJob(boss, WORKFLOW_STEP_EXECUTE_QUEUE, payload, {
    singletonKey: workflowStepSingletonKey(stepRun.id, stepRun.attemptCount),
    ...(options?.startAfter === undefined ? {} : { startAfter: options.startAfter })
  });
}
