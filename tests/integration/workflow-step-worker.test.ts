import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql, type Kysely } from "kysely";
import { createPgBossClient, type Job, type PgBoss } from "@moss/jobs";

import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import { VaultContextRunner } from "@moss/vault";
import {
  enqueueWorkflowStep,
  registerWorkflowWorkers,
  runWorkflowStep,
  WORKFLOW_STEP_DEADLETTER_QUEUE,
  WORKFLOW_STEP_EXECUTE_QUEUE,
  WorkflowsRepository,
  type WorkflowStepJobPayload
} from "@moss/workflows";
import type { ModuleWorkflowDefinition } from "@moss/module-sdk";

import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const ownerUserId = ids.userA;
let db: Kysely<MossDatabase>;
let dataContext: DataContextRunner;
const vaultRunner = new VaultContextRunner("/tmp/jarvis-workflows-test-vault");

function job(jobId: string, workflowRunId: string, stepRunId: string): Job<WorkflowStepJobPayload> {
  return {
    id: jobId,
    data: { actorUserId: ownerUserId, workflowRunId, stepRunId }
  } as Job<WorkflowStepJobPayload>;
}

async function waitForJobState(
  boss: PgBoss,
  queue: string,
  jobId: string,
  state: "retry" | "failed"
) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const current = await boss.getJobById(queue, jobId);
    if (current?.state === state) return current;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Job ${jobId} did not reach ${state}`);
}

async function waitForJobs(boss: PgBoss, data: object) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const jobs = await boss.findJobs(WORKFLOW_STEP_DEADLETTER_QUEUE, { data });
    if (jobs.length > 0) return jobs;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Malformed delivery did not reach the dead-letter queue");
}

beforeAll(async () => {
  await resetFoundationDatabase();
  db = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
  dataContext = new DataContextRunner(db);
});

afterAll(async () => {
  await db?.destroy();
});

describe("workflow step worker", () => {
  it("runs each delivered step once, routes the next step, and finishes the run", async () => {
    const repo = new WorkflowsRepository();
    const sent: Array<{ queue: string; data: unknown; options: unknown }> = [];
    let nextJob = 0;
    const boss = {
      send: async (queue: string, data: unknown, options: unknown) => {
        const id = `job-${++nextJob}`;
        sent.push({ queue, data, options });
        return id;
      }
    } as unknown as PgBoss;
    let firstCalls = 0;
    let secondCalls = 0;
    const definition: ModuleWorkflowDefinition = {
      id: "workflows.integration",
      displayName: "Integration workflow",
      version: 1,
      startStepId: "first",
      trigger: "manual",
      steps: [
        {
          id: "first",
          kind: "task",
          handler: async () => {
            firstCalls += 1;
            return { route: "next" };
          }
        },
        {
          id: "second",
          kind: "task",
          handler: async () => {
            secondCalls += 1;
            return { done: true };
          }
        }
      ],
      edges: [{ from: "first", to: "second", condition: { type: "onSuccess" } }]
    };
    const deps = {
      boss,
      dataContext,
      vaultRunner,
      registry: new Map([[definition.id, { moduleId: "workflows", definition }]])
    };
    const created = await dataContext.withDataContext(
      { actorUserId: ownerUserId, requestId: "workflow-worker-test" },
      (scopedDb) =>
        repo.createRun(scopedDb, {
          ownerUserId,
          workflowId: definition.id,
          workflowVersion: 1,
          moduleId: "workflows",
          startedBy: "user",
          startStepId: "first"
        })
    );
    const firstJobId = await enqueueWorkflowStep(boss, created.firstStepRun);
    await dataContext.withDataContext(
      { actorUserId: ownerUserId, requestId: "workflow-worker-test" },
      (scopedDb) => repo.setStepQueueJobId(scopedDb, created.firstStepRun.id, firstJobId!)
    );

    await runWorkflowStep(job(firstJobId!, created.run.id, created.firstStepRun.id), deps);
    await runWorkflowStep(job(firstJobId!, created.run.id, created.firstStepRun.id), deps);
    expect(firstCalls).toBe(1);
    expect(sent).toHaveLength(2);
    expect(Object.keys(sent[0]!.data as object).sort()).toEqual([
      "actorUserId",
      "stepRunId",
      "workflowRunId"
    ]);

    const afterFirst = await dataContext.withDataContext(
      { actorUserId: ownerUserId, requestId: "workflow-worker-test" },
      (scopedDb) => repo.listStepRuns(scopedDb, ownerUserId, created.run.id)
    );
    expect(afterFirst).toHaveLength(2);
    expect(afterFirst[0]?.status).toBe("succeeded");
    expect(afterFirst[1]?.status).toBe("queued");

    await runWorkflowStep(job("job-2", created.run.id, afterFirst[1]!.id), deps);
    expect(secondCalls).toBe(1);

    const detail = await dataContext.withDataContext(
      { actorUserId: ownerUserId, requestId: "workflow-worker-test" },
      (scopedDb) => repo.getRunDetail(scopedDb, ownerUserId, created.run.id)
    );
    expect(detail?.run.status).toBe("succeeded");
    expect(detail?.stepRuns.map((step) => step.status)).toEqual(["succeeded", "succeeded"]);
  });

  it.each([
    { decision: "approve" as const, branch: "approved" },
    { decision: "deny" as const, branch: "denied" }
  ])("suspends and resumes an approval after $decision", async ({ decision, branch }) => {
    const repo = new WorkflowsRepository();
    const sent: Array<{ queue: string; data: unknown }> = [];
    const boss = {
      send: async (queue: string, data: object) => {
        sent.push({ queue, data });
        return `approval-job-${sent.length}`;
      }
    } as unknown as PgBoss;
    let branchCalls = 0;
    const definition: ModuleWorkflowDefinition = {
      id: `workflows.approval-${decision}`,
      displayName: "Approval workflow",
      version: 1,
      startStepId: "approval",
      trigger: "manual",
      steps: [
        {
          id: "approval",
          kind: "approval",
          approval: { summary: "Approve this workflow" }
        },
        {
          id: branch,
          kind: "task",
          handler: async () => {
            branchCalls += 1;
            return { complete: true };
          }
        }
      ],
      edges: [
        {
          from: "approval",
          to: branch,
          condition: {
            type: "resultEquals",
            field: "status",
            equals: decision === "approve" ? "approved" : "denied"
          }
        }
      ]
    };
    const deps = {
      boss,
      dataContext,
      registry: new Map([[definition.id, { moduleId: "workflows", definition }]]),
      vaultRunner
    };
    const created = await dataContext.withDataContext(
      { actorUserId: ownerUserId, requestId: `workflow-approval-${decision}` },
      (scopedDb) =>
        repo.createRun(scopedDb, {
          ownerUserId,
          workflowId: definition.id,
          workflowVersion: definition.version,
          moduleId: "workflows",
          startedBy: "user",
          startStepId: definition.startStepId
        })
    );
    const initialJobId = await enqueueWorkflowStep(boss, created.firstStepRun);
    await dataContext.withDataContext(
      { actorUserId: ownerUserId, requestId: `workflow-approval-${decision}` },
      (scopedDb) => repo.setStepQueueJobId(scopedDb, created.firstStepRun.id, initialJobId!)
    );

    await expect(
      runWorkflowStep(job(initialJobId!, created.run.id, created.firstStepRun.id), deps)
    ).resolves.toMatchObject({ outcome: "suspended" });
    const pending = await dataContext.withDataContext(
      { actorUserId: ownerUserId, requestId: `workflow-approval-${decision}` },
      (scopedDb) => repo.listApprovals(scopedDb, ownerUserId, created.run.id)
    );
    expect(pending).toHaveLength(1);
    const resolved = await dataContext.withDataContext(
      { actorUserId: ownerUserId, requestId: `workflow-approval-${decision}` },
      (scopedDb) => repo.resolveApproval(scopedDb, ownerUserId, pending[0]!.id, decision)
    );
    expect(resolved.outcome).toBe("resolved");
    if (resolved.outcome !== "resolved") throw new Error("Approval did not resolve");
    const continuationJobId = await enqueueWorkflowStep(boss, resolved.stepRun);
    expect(sent[1]?.data).toEqual({
      actorUserId: ownerUserId,
      workflowRunId: created.run.id,
      stepRunId: created.firstStepRun.id
    });
    await dataContext.withDataContext(
      { actorUserId: ownerUserId, requestId: `workflow-approval-${decision}` },
      (scopedDb) => repo.setStepQueueJobId(scopedDb, created.firstStepRun.id, continuationJobId!)
    );
    await runWorkflowStep(job(continuationJobId!, created.run.id, created.firstStepRun.id), deps);
    const branchRuns = await dataContext.withDataContext(
      { actorUserId: ownerUserId, requestId: `workflow-approval-${decision}` },
      (scopedDb) => repo.listStepRuns(scopedDb, ownerUserId, created.run.id)
    );
    expect(branchCalls).toBe(0);
    expect(branchRuns).toHaveLength(2);
    expect(branchRuns[0]?.resultJson).toEqual({
      status: decision === "approve" ? "approved" : "denied"
    });
    expect(branchRuns[1]?.stepId).toBe(branch);
    await runWorkflowStep(job(`branch-job-${decision}`, created.run.id, branchRuns[1]!.id), deps);
    expect(branchCalls).toBe(1);
  });

  it("claims a step once and reclaims a stale running step", async () => {
    const repo = new WorkflowsRepository();
    const created = await dataContext.withDataContext(
      { actorUserId: ownerUserId, requestId: "workflow-claim-test" },
      (scopedDb) =>
        repo.createRun(scopedDb, {
          ownerUserId,
          workflowId: "workflows.claim",
          workflowVersion: 1,
          moduleId: "workflows",
          startedBy: "user",
          startStepId: "claim"
        })
    );

    const claims = await Promise.all(
      ["claim-a", "claim-b"].map((queueJobId) =>
        dataContext.withDataContext(
          { actorUserId: ownerUserId, requestId: `workflow-claim-${queueJobId}` },
          (scopedDb) => repo.claimStepRun(scopedDb, created.firstStepRun.id, queueJobId)
        )
      )
    );
    expect(claims.filter(Boolean)).toHaveLength(1);

    await dataContext.withDataContext(
      { actorUserId: ownerUserId, requestId: "workflow-stale-test" },
      (scopedDb) =>
        sql`
          update app.workflow_step_runs
          set status = 'running', started_at = now() - interval '1 hour',
              updated_at = now() - interval '1 hour', pgboss_job_id = 'crashed-job'
          where id = ${created.firstStepRun.id}
        `.execute(scopedDb.db)
    );

    const recovered = await dataContext.withDataContext(
      { actorUserId: ownerUserId, requestId: "workflow-recovery-test" },
      (scopedDb) => repo.claimStepRun(scopedDb, created.firstStepRun.id, "recovered-job")
    );
    expect(recovered?.status).toBe("running");
    expect(recovered?.queueJobId).toBe("recovered-job");
  });

  it("does not execute a long-running step twice after the recovery window", async () => {
    vi.useFakeTimers();
    let releaseHandler!: () => void;
    let handlerStarted!: () => void;
    const handlerReady = new Promise<void>((resolve) => {
      handlerStarted = resolve;
    });
    const handlerFinished = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    try {
      const repo = new WorkflowsRepository();
      let calls = 0;
      const definition: ModuleWorkflowDefinition = {
        id: "workflows.active-claim",
        displayName: "Active claim workflow",
        version: 1,
        startStepId: "only",
        trigger: "manual",
        steps: [
          {
            id: "only",
            kind: "task",
            handler: async () => {
              calls += 1;
              handlerStarted();
              await handlerFinished;
              return { calls };
            }
          }
        ],
        edges: []
      };
      const deps = {
        boss: {} as PgBoss,
        dataContext,
        vaultRunner,
        registry: new Map([[definition.id, { moduleId: "workflows", definition }]])
      };
      const created = await dataContext.withDataContext(
        { actorUserId: ownerUserId, requestId: "workflow-active-claim-test" },
        (scopedDb) =>
          repo.createRun(scopedDb, {
            ownerUserId,
            workflowId: definition.id,
            workflowVersion: 1,
            moduleId: "workflows",
            startedBy: "user",
            startStepId: "only"
          })
      );

      const firstDelivery = runWorkflowStep(
        job("active-job", created.run.id, created.firstStepRun.id),
        deps
      );
      await handlerReady;
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

      await expect(
        runWorkflowStep(job("duplicate-job", created.run.id, created.firstStepRun.id), deps)
      ).resolves.toMatchObject({ outcome: "skipped" });
      expect(calls).toBe(1);

      releaseHandler();
      await firstDelivery;
    } finally {
      releaseHandler();
      vi.useRealTimers();
    }
  });

  it("retries and dead-letters malformed deliveries through the real queue", async () => {
    const boss = createPgBossClient(connectionStrings.worker);
    try {
      await boss.start();
      await registerWorkflowWorkers(boss, {
        boss,
        dataContext,
        vaultRunner,
        registry: new Map()
      });

      const jobId = await boss.send(
        WORKFLOW_STEP_EXECUTE_QUEUE,
        {
          actorUserId: ownerUserId,
          workflowRunId: "not-a-uuid",
          stepRunId: "also-not-a-uuid"
        },
        { retryLimit: 1, retryDelay: 1 }
      );
      expect(jobId).not.toBeNull();

      const retried = await waitForJobState(boss, WORKFLOW_STEP_EXECUTE_QUEUE, jobId!, "retry");
      expect(retried.state).toBe("retry");

      await waitForJobState(boss, WORKFLOW_STEP_EXECUTE_QUEUE, jobId!, "failed");
      const deadLetter = await waitForJobs(boss, {
        workflowRunId: "not-a-uuid",
        stepRunId: "also-not-a-uuid"
      });
      expect(deadLetter).toHaveLength(1);
      const processedDeadLetter = await waitForJobState(
        boss,
        WORKFLOW_STEP_DEADLETTER_QUEUE,
        deadLetter[0]!.id,
        "failed"
      );
      expect(processedDeadLetter.state).toBe("failed");
      expect(deadLetter[0]?.data).toMatchObject({
        actorUserId: ownerUserId,
        workflowRunId: "not-a-uuid",
        stepRunId: "also-not-a-uuid"
      });
    } finally {
      await boss.stop({ graceful: false });
    }
  });

  it("does not reclaim a long-running step whose heartbeat is current", async () => {
    const repo = new WorkflowsRepository();
    const created = await dataContext.withDataContext(
      { actorUserId: ownerUserId, requestId: "workflow-heartbeat-test" },
      (scopedDb) =>
        repo.createRun(scopedDb, {
          ownerUserId,
          workflowId: "workflows.heartbeat",
          workflowVersion: 1,
          moduleId: "workflows",
          startedBy: "user",
          startStepId: "heartbeat"
        })
    );

    await dataContext.withDataContext(
      { actorUserId: ownerUserId, requestId: "workflow-heartbeat-test" },
      (scopedDb) => repo.claimStepRun(scopedDb, created.firstStepRun.id, "long-job")
    );
    await dataContext.withDataContext(
      { actorUserId: ownerUserId, requestId: "workflow-heartbeat-test" },
      (scopedDb) =>
        sql`
          update app.workflow_step_runs
          set started_at = now() - interval '1 hour'
          where id = ${created.firstStepRun.id}
        `.execute(scopedDb.db)
    );

    expect(
      await dataContext.withDataContext(
        { actorUserId: ownerUserId, requestId: "workflow-heartbeat-test" },
        (scopedDb) => repo.heartbeatStepRun(scopedDb, created.firstStepRun.id, "long-job")
      )
    ).toBe(true);
    expect(
      await dataContext.withDataContext(
        { actorUserId: ownerUserId, requestId: "workflow-heartbeat-test" },
        (scopedDb) => repo.claimStepRun(scopedDb, created.firstStepRun.id, "duplicate-job")
      )
    ).toBeNull();
  });

  it("ignores late queue bookkeeping for finished and cancelled steps", async () => {
    const repo = new WorkflowsRepository();
    const makeRun = (workflowId: string) =>
      dataContext.withDataContext(
        { actorUserId: ownerUserId, requestId: `workflow-late-${workflowId}` },
        (scopedDb) =>
          repo.createRun(scopedDb, {
            ownerUserId,
            workflowId,
            workflowVersion: 1,
            moduleId: "workflows",
            startedBy: "user",
            startStepId: "only"
          })
      );
    const succeeded = await makeRun("workflows.late-success");
    await dataContext.withDataContext(
      { actorUserId: ownerUserId, requestId: "workflow-late-success" },
      (scopedDb) => repo.recordStepSuccess(scopedDb, succeeded.firstStepRun.id, {})
    );
    const lateSuccess = await dataContext.withDataContext(
      { actorUserId: ownerUserId, requestId: "workflow-late-success" },
      (scopedDb) => repo.setStepQueueJobId(scopedDb, succeeded.firstStepRun.id, "late-success")
    );
    expect(lateSuccess).toBeNull();

    const cancelled = await makeRun("workflows.late-cancel");
    await dataContext.withDataContext(
      { actorUserId: ownerUserId, requestId: "workflow-late-cancel" },
      (scopedDb) => repo.cancelRun(scopedDb, ownerUserId, cancelled.run.id)
    );
    const lateCancel = await dataContext.withDataContext(
      { actorUserId: ownerUserId, requestId: "workflow-late-cancel" },
      (scopedDb) => repo.setStepQueueJobId(scopedDb, cancelled.firstStepRun.id, "late-cancel")
    );
    expect(lateCancel).toBeNull();
  });

  it("rejects a job whose step belongs to another workflow run", async () => {
    const repo = new WorkflowsRepository();
    let calls = 0;
    const definition: ModuleWorkflowDefinition = {
      id: "workflows.run-binding",
      displayName: "Run binding workflow",
      version: 1,
      startStepId: "only",
      trigger: "manual",
      steps: [{ id: "only", kind: "task", handler: async () => ({ calls: ++calls }) }],
      edges: []
    };
    const deps = {
      boss: {} as PgBoss,
      dataContext,
      vaultRunner,
      registry: new Map([[definition.id, { moduleId: "workflows", definition }]])
    };
    const create = (requestId: string) =>
      dataContext.withDataContext({ actorUserId: ownerUserId, requestId }, (scopedDb) =>
        repo.createRun(scopedDb, {
          ownerUserId,
          workflowId: definition.id,
          workflowVersion: 1,
          moduleId: "workflows",
          startedBy: "user",
          startStepId: "only"
        })
      );
    const first = await create("workflow-run-binding-a");
    const second = await create("workflow-run-binding-b");

    await expect(
      runWorkflowStep(job("mismatch", first.run.id, second.firstStepRun.id), deps)
    ).rejects.toThrow(`Workflow step ${second.firstStepRun.id} could not be loaded`);
    expect(calls).toBe(0);
  });

  it("fails a run when a failed branch has no failure edge even if a sibling finishes", async () => {
    const repo = new WorkflowsRepository();
    const sent: string[] = [];
    const boss = {
      send: async () => {
        const id = `branch-job-${sent.length + 1}`;
        sent.push(id);
        return id;
      }
    } as unknown as PgBoss;
    const definition: ModuleWorkflowDefinition = {
      id: "workflows.failed-branch",
      displayName: "Failed branch workflow",
      version: 1,
      startStepId: "start",
      trigger: "manual",
      steps: [
        { id: "start", kind: "task", handler: async () => ({}) },
        {
          id: "failed",
          kind: "task",
          handler: async () => {
            throw new Error("boom");
          }
        },
        { id: "sibling", kind: "task", handler: async () => ({ done: true }) }
      ],
      edges: [
        { from: "start", to: "failed", condition: { type: "onSuccess" } },
        { from: "start", to: "sibling", condition: { type: "onSuccess" } }
      ]
    };
    const deps = {
      boss,
      dataContext,
      vaultRunner,
      registry: new Map([[definition.id, { moduleId: "workflows", definition }]])
    };
    const created = await dataContext.withDataContext(
      { actorUserId: ownerUserId, requestId: "workflow-failed-branch" },
      (scopedDb) =>
        repo.createRun(scopedDb, {
          ownerUserId,
          workflowId: definition.id,
          workflowVersion: 1,
          moduleId: "workflows",
          startedBy: "user",
          startStepId: "start"
        })
    );
    const firstJob = await enqueueWorkflowStep(boss, created.firstStepRun);
    await dataContext.withDataContext(
      { actorUserId: ownerUserId, requestId: "workflow-failed-branch" },
      (scopedDb) => repo.setStepQueueJobId(scopedDb, created.firstStepRun.id, firstJob!)
    );
    await runWorkflowStep(job(firstJob!, created.run.id, created.firstStepRun.id), deps);

    const branches = await dataContext.withDataContext(
      { actorUserId: ownerUserId, requestId: "workflow-failed-branch" },
      (scopedDb) => repo.listStepRuns(scopedDb, ownerUserId, created.run.id)
    );
    const failed = branches.find((step) => step.stepId === "failed")!;
    const sibling = branches.find((step) => step.stepId === "sibling")!;
    await runWorkflowStep(job("failed-job", created.run.id, failed.id), deps);
    await runWorkflowStep(job("sibling-job", created.run.id, sibling.id), deps);

    const detail = await dataContext.withDataContext(
      { actorUserId: ownerUserId, requestId: "workflow-failed-branch" },
      (scopedDb) => repo.getRunDetail(scopedDb, ownerUserId, created.run.id)
    );
    expect(detail?.run.status).toBe("failed");
  });
});
