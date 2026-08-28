import type { DataContextDb, DataContextRunner } from "@moss/db";
import { toAccessContext, type Job, type PgBoss } from "@moss/jobs";
import type { ModuleWorkflowDefinition, WorkflowEdgeDefinition } from "@moss/module-sdk";
import {
  assertWorkflowStepJobPayload,
  enqueueWorkflowStep,
  workflowStepBackoffMs,
  WORKFLOW_STEP_DEADLETTER_QUEUE,
  WORKFLOW_STEP_EXECUTE_QUEUE,
  type WorkflowStepJobPayload
} from "./jobs.js";
import { WorkflowsRepository } from "./repository.js";
import {
  TERMINAL_RUN_STATUSES,
  TERMINAL_STEP_RUN_STATUSES,
  type WorkflowJson,
  type WorkflowRun,
  type WorkflowStepRun
} from "./types.js";

export interface WorkflowRegistryLike {
  get(
    workflowId: string
  ): { readonly moduleId: string; readonly definition: ModuleWorkflowDefinition } | undefined;
}

export interface WorkflowWorkerDependencies {
  readonly boss: PgBoss;
  readonly dataContext: DataContextRunner;
  readonly registry: WorkflowRegistryLike;
  readonly repository?: WorkflowsRepository;
}

export interface WorkflowStepWorkerResult {
  readonly stepRunId: string;
  readonly outcome: "skipped" | "suspended" | "succeeded" | "retrying" | "failed";
}

interface RouteResult {
  readonly outcome: WorkflowStepWorkerResult["outcome"];
  readonly successors: readonly WorkflowStepRun[];
}

export async function runWorkflowStep(
  job: Job<WorkflowStepJobPayload>,
  deps: WorkflowWorkerDependencies,
  mode: "execute" | "deadletter" = "execute"
): Promise<WorkflowStepWorkerResult> {
  assertWorkflowStepJobPayload(job.data);
  const repo = deps.repository ?? new WorkflowsRepository();
  const accessContext = toAccessContext(job);
  const { actorUserId, workflowRunId, stepRunId } = job.data;

  const claim = await deps.dataContext.withDataContext(accessContext, async (scopedDb) => {
    const run = await repo.getRun(scopedDb, actorUserId, workflowRunId);
    const step = await repo.getStepRun(scopedDb, actorUserId, stepRunId);
    if (!run || !step) throw new Error(`Workflow step ${stepRunId} could not be loaded`);
    if (run.status === "cancelled" || TERMINAL_RUN_STATUSES.includes(run.status)) {
      return { action: "skip" as const, run, step };
    }
    const entry = deps.registry.get(run.workflowId);
    const definition = entry?.definition;
    const stepDefinition = definition?.steps.find((candidate) => candidate.id === step.stepId);
    if (!definition || definition.version !== run.workflowVersion || !stepDefinition) {
      await repo.recordStepFailure(scopedDb, step.id, "definition_missing");
      await repo.completeRun(scopedDb, actorUserId, run.id, "failed", {
        error: "definition_missing"
      });
      return { action: "skip" as const, run, step };
    }
    if (TERMINAL_STEP_RUN_STATUSES.includes(step.status)) {
      return { action: "route" as const, run, step, definition, stepDefinition };
    }
    if (step.status === "suspended") {
      const approvals = await repo.listApprovals(scopedDb, actorUserId, run.id);
      if (
        approvals.some(
          (approval) => approval.stepRunId === step.id && approval.status === "pending"
        )
      ) {
        return { action: "skip" as const, run, step };
      }
    }
    if (step.status === "running") return { action: "skip" as const, run, step };
    await repo.markRunRunning(scopedDb, run.id);
    const claimed = await repo.claimStepRun(scopedDb, step.id, job.id);
    return { action: "run" as const, run, step: claimed, definition, stepDefinition };
  });

  if (claim.action === "skip") return { stepRunId, outcome: "skipped" };
  if (claim.action === "route") {
    const routed = await routeStep(
      deps,
      repo,
      accessContext,
      claim.run,
      claim.step,
      claim.definition,
      claim.step.status === "failed" ? "failure" : "success"
    );
    await enqueueSuccessors(deps, repo, accessContext, routed.successors);
    return { stepRunId, outcome: routed.outcome };
  }

  if (
    mode !== "deadletter" &&
    claim.stepDefinition.kind === "approval" &&
    claim.step.resultJson.status === undefined
  ) {
    await deps.dataContext.withDataContext(accessContext, (scopedDb) =>
      repo.createApproval(scopedDb, {
        workflowRunId,
        stepRunId,
        ownerUserId: actorUserId,
        summary: claim.stepDefinition.approval!.summary,
        detailsJson: claim.stepDefinition.approval!.details
      })
    );
    return { stepRunId, outcome: "suspended" };
  }

  let result: WorkflowJson;
  let handlerError = false;
  if (mode === "deadletter") {
    result = { error: "transport_failure" };
    handlerError = true;
  } else if (claim.stepDefinition.kind === "approval") {
    result = claim.step.resultJson;
  } else {
    try {
      result = await claim.stepDefinition.handler!({
        actorUserId,
        requestId: accessContext.requestId ?? `pgboss:${job.id}`,
        workflowRunId,
        stepRunId,
        runInput: claim.run.inputJson,
        stepInput: claim.step.inputJson,
        getStepResult: (stepId) =>
          deps.dataContext.withDataContext(accessContext, (scopedDb) =>
            repo.getStepResult(scopedDb, actorUserId, workflowRunId, stepId)
          ),
        artifacts: {
          write: async () => {
            throw new Error("Workflow artifacts are not available in this slice");
          },
          read: async () => {
            throw new Error("Workflow artifacts are not available in this slice");
          }
        }
      });
    } catch (error) {
      result = { error: error instanceof Error ? error.name : "handler_error" };
      handlerError = true;
    }
  }

  if (handlerError && mode !== "deadletter" && claim.stepDefinition.kind === "task") {
    const retry = await deps.dataContext.withDataContext(accessContext, async (scopedDb) => {
      const run = await repo.lockRun(scopedDb, actorUserId, workflowRunId);
      if (!run || TERMINAL_RUN_STATUSES.includes(run.status)) return null;
      const step = await repo.getStepRun(scopedDb, actorUserId, stepRunId);
      if (!step || TERMINAL_STEP_RUN_STATUSES.includes(step.status)) return null;
      const maxAttempts = claim.stepDefinition.retry?.maxAttempts ?? 1;
      if (step.attemptCount < maxAttempts) {
        await repo.queueStepRetry(scopedDb, stepRunId, "handler_error");
        return workflowStepBackoffMs(claim.stepDefinition.retry, step.attemptCount);
      }
      return -1;
    });
    if (retry !== null && retry >= 0) {
      const queued = await deps.dataContext.withDataContext(accessContext, (scopedDb) =>
        repo.getStepRun(scopedDb, actorUserId, stepRunId)
      );
      if (!queued) throw new Error(`Workflow step ${stepRunId} disappeared before retry`);
      const jobId = await enqueueWorkflowStep(deps.boss, queued, { startAfter: retry });
      if (jobId) {
        await deps.dataContext.withDataContext(accessContext, (scopedDb) =>
          repo.setStepQueueJobId(scopedDb, stepRunId, jobId)
        );
      }
      return { stepRunId, outcome: "retrying" };
    }
    result = { error: "handler_error" };
  }

  const routed = await deps.dataContext.withDataContext(accessContext, async (scopedDb) => {
    const run = await repo.lockRun(scopedDb, actorUserId, workflowRunId);
    if (!run || TERMINAL_RUN_STATUSES.includes(run.status)) {
      return { outcome: "skipped" as const, successors: [] };
    }
    const step = await repo.getStepRun(scopedDb, actorUserId, stepRunId);
    if (!step || TERMINAL_STEP_RUN_STATUSES.includes(step.status)) {
      return { outcome: "skipped" as const, successors: [] };
    }
    if (!handlerError) {
      const recorded = await repo.recordStepSuccess(scopedDb, stepRunId, result);
      return routeStepInTransaction(
        repo,
        scopedDb,
        run,
        recorded,
        claim.definition,
        "success",
        true
      );
    }
    const recorded = await repo.recordStepFailure(
      scopedDb,
      stepRunId,
      result.error === "transport_failure" ? "transport_failure" : "handler_error",
      result
    );
    return routeStepInTransaction(repo, scopedDb, run, recorded, claim.definition, "failure", true);
  });
  await enqueueSuccessors(deps, repo, accessContext, routed.successors);
  return { stepRunId, outcome: routed.outcome };
}

export async function registerWorkflowWorkers(
  boss: PgBoss,
  deps: WorkflowWorkerDependencies
): Promise<string[]> {
  const workerIds = await Promise.all([
    boss.work<WorkflowStepJobPayload>(
      WORKFLOW_STEP_EXECUTE_QUEUE,
      { pollingIntervalSeconds: 2 },
      async ([job]) => {
        if (!job) throw new Error(`pg-boss invoked ${WORKFLOW_STEP_EXECUTE_QUEUE} without a job`);
        return runWorkflowStep(job, { ...deps, boss });
      }
    ),
    boss.work<WorkflowStepJobPayload>(
      WORKFLOW_STEP_DEADLETTER_QUEUE,
      { pollingIntervalSeconds: 2 },
      async ([job]) => {
        if (!job)
          throw new Error(`pg-boss invoked ${WORKFLOW_STEP_DEADLETTER_QUEUE} without a job`);
        return runWorkflowStep(job, { ...deps, boss }, "deadletter");
      }
    )
  ]);
  return workerIds;
}

async function routeStep(
  deps: WorkflowWorkerDependencies,
  repo: WorkflowsRepository,
  accessContext: Parameters<DataContextRunner["withDataContext"]>[0],
  run: WorkflowRun,
  step: WorkflowStepRun,
  definition: ModuleWorkflowDefinition,
  status: "success" | "failure"
): Promise<RouteResult> {
  return deps.dataContext.withDataContext(accessContext, async (scopedDb) => {
    const lockedRun = await repo.lockRun(scopedDb, run.ownerUserId, run.id);
    if (!lockedRun || TERMINAL_RUN_STATUSES.includes(lockedRun.status)) {
      return { outcome: "skipped" as const, successors: [] };
    }
    return routeStepInTransaction(repo, scopedDb, lockedRun, step, definition, status, false);
  });
}

async function routeStepInTransaction(
  repo: WorkflowsRepository,
  scopedDb: DataContextDb,
  run: WorkflowRun,
  step: WorkflowStepRun,
  definition: ModuleWorkflowDefinition,
  status: "success" | "failure",
  alreadyRecorded: boolean
): Promise<RouteResult> {
  if (!alreadyRecorded && !TERMINAL_STEP_RUN_STATUSES.includes(step.status)) {
    throw new Error("Workflow routing requires a recorded terminal step");
  }
  const edges = definition.edges.filter(
    (edge) => edge.from === step.stepId && edgeMatches(edge, status, step.resultJson)
  );
  const successors: WorkflowStepRun[] = [];
  for (const edge of edges) {
    const created = await repo.createStepRun(scopedDb, {
      workflowRunId: run.id,
      ownerUserId: run.ownerUserId,
      stepId: edge.to
    });
    if (
      (created.stepRun.status === "pending" || created.stepRun.status === "queued") &&
      !created.stepRun.queueJobId
    ) {
      successors.push(created.stepRun);
    }
  }
  const live = (await repo.listStepRuns(scopedDb, run.ownerUserId, run.id)).some(
    (candidate) => !TERMINAL_STEP_RUN_STATUSES.includes(candidate.status)
  );
  if (successors.length === 0 && !live) {
    const finalStatus = status === "failure" && edges.length === 0 ? "failed" : "succeeded";
    await repo.completeRun(scopedDb, run.ownerUserId, run.id, finalStatus, {});
    return { outcome: finalStatus === "failed" ? "failed" : "succeeded", successors };
  }
  return { outcome: status === "failure" ? "failed" : "succeeded", successors };
}

function edgeMatches(
  edge: WorkflowEdgeDefinition,
  status: "success" | "failure",
  result: WorkflowJson
): boolean {
  const condition = edge.condition;
  if (condition.type === "always") return true;
  if (condition.type === "onSuccess") return status === "success";
  if (condition.type === "onFailure") return status === "failure";
  return result[condition.field] === condition.equals;
}

async function enqueueSuccessors(
  deps: WorkflowWorkerDependencies,
  repo: WorkflowsRepository,
  accessContext: Parameters<DataContextRunner["withDataContext"]>[0],
  successors: readonly WorkflowStepRun[]
): Promise<void> {
  for (const successor of successors) {
    const jobId = await enqueueWorkflowStep(deps.boss, successor);
    if (jobId) {
      await deps.dataContext.withDataContext(accessContext, (scopedDb) =>
        repo.setStepQueueJobId(scopedDb, successor.id, jobId)
      );
    }
  }
}
