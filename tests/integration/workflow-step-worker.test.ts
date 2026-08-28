import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { Job, PgBoss } from "@moss/jobs";

import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import {
  enqueueWorkflowStep,
  runWorkflowStep,
  WorkflowsRepository,
  type WorkflowStepJobPayload
} from "@moss/workflows";
import type { ModuleWorkflowDefinition } from "@moss/module-sdk";

import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const ownerUserId = ids.userA;
let db: Kysely<MossDatabase>;
let dataContext: DataContextRunner;

function job(jobId: string, workflowRunId: string, stepRunId: string): Job<WorkflowStepJobPayload> {
  return {
    id: jobId,
    data: { actorUserId: ownerUserId, workflowRunId, stepRunId }
  } as Job<WorkflowStepJobPayload>;
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
});
