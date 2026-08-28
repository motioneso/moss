/**
 * HTTP-level checks for the owner-scoped workflow run endpoints (#2013, slice 819-B).
 *
 * The database tests in `tests/integration/workflows-rls.test.ts` prove the ownership rules.
 * These tests prove the layer above them: the status codes callers see, and — the security
 * point of the slice — that run input, step input, step results and vault artifact references
 * never appear in a response body. The fake repository below deliberately returns rows stuffed
 * with recognisable private strings, so a leak shows up as that string in the JSON.
 */
import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import type { AccessContext, DataContextDb, DataContextRunner } from "@moss/db";
import type { PgBoss } from "@moss/jobs";

import {
  registerWorkflowsRoutes,
  type WorkflowsRouteDependencies
} from "../../packages/workflows/src/routes.js";
import type { WorkflowsRepository } from "../../packages/workflows/src/repository.js";
import type {
  WorkflowApproval,
  WorkflowArtifact,
  WorkflowRun,
  WorkflowRunDetail,
  WorkflowStepRun
} from "../../packages/workflows/src/types.js";

const OWNER_ID = "11111111-1111-1111-1111-111111111111";
const RUN_ID = "22222222-2222-2222-2222-222222222222";
const STEP_RUN_ID = "33333333-3333-3333-3333-333333333333";
const APPROVAL_ID = "44444444-4444-4444-4444-444444444444";
const ARTIFACT_ID = "55555555-5555-5555-5555-555555555555";

/** Any of these appearing in a response body is a leak. */
const SECRET_INPUT = "PRIVATE-RUN-INPUT";
const SECRET_RESULT = "PRIVATE-RUN-RESULT";
const SECRET_STEP_INPUT = "PRIVATE-STEP-INPUT";
const SECRET_STEP_RESULT = "PRIVATE-STEP-RESULT";
const SECRET_APPROVAL_DETAIL = "PRIVATE-APPROVAL-DETAIL";
const SECRET_ARTIFACT_REF = "vault://PRIVATE-ARTIFACT-PATH";

const AT = new Date("2026-08-27T12:00:00.000Z");

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: RUN_ID,
    ownerUserId: OWNER_ID,
    workflowId: "expense-approval",
    workflowVersion: 1,
    moduleId: "tasks",
    status: "running",
    startedBy: "user",
    inputJson: { note: SECRET_INPUT },
    resultJson: { note: SECRET_RESULT },
    startedAt: AT,
    completedAt: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides
  };
}

function makeStepRun(overrides: Partial<WorkflowStepRun> = {}): WorkflowStepRun {
  return {
    id: STEP_RUN_ID,
    workflowRunId: RUN_ID,
    ownerUserId: OWNER_ID,
    stepId: "collect-receipt",
    status: "suspended",
    attemptCount: 1,
    inputJson: { note: SECRET_STEP_INPUT },
    resultJson: { note: SECRET_STEP_RESULT },
    errorCode: null,
    queueJobId: "queue-job-abc",
    startedAt: AT,
    suspendedAt: AT,
    completedAt: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides
  };
}

function makeApproval(overrides: Partial<WorkflowApproval> = {}): WorkflowApproval {
  return {
    id: APPROVAL_ID,
    workflowRunId: RUN_ID,
    stepRunId: STEP_RUN_ID,
    ownerUserId: OWNER_ID,
    status: "pending",
    summary: "Approve the expense claim",
    detailsJson: { note: SECRET_APPROVAL_DETAIL },
    resolvedByUserId: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides
  };
}

function makeArtifact(overrides: Partial<WorkflowArtifact> = {}): WorkflowArtifact {
  return {
    id: ARTIFACT_ID,
    workflowRunId: RUN_ID,
    stepRunId: STEP_RUN_ID,
    ownerUserId: OWNER_ID,
    artifactRef: SECRET_ARTIFACT_REF,
    sha256: "a".repeat(64),
    contentType: "application/pdf",
    sizeBytes: 2048,
    createdAt: AT,
    updatedAt: AT,
    ...overrides
  };
}

type FakeRepo = Partial<{
  listRuns: WorkflowsRepository["listRuns"];
  getRunDetail: WorkflowsRepository["getRunDetail"];
  cancelRun: WorkflowsRepository["cancelRun"];
  resolveApproval: WorkflowsRepository["resolveApproval"];
  setStepQueueJobId: WorkflowsRepository["setStepQueueJobId"];
}>;

function buildApp(repo: FakeRepo, boss: PgBoss = {} as PgBoss) {
  const app = Fastify();
  const deps: WorkflowsRouteDependencies = {
    resolveAccessContext: async (): Promise<AccessContext> =>
      ({ actorUserId: OWNER_ID, requestId: "req-1" }) as AccessContext,
    dataContext: {
      withDataContext: async <T>(_ac: AccessContext, work: (db: DataContextDb) => Promise<T>) =>
        work({} as DataContextDb)
    } as unknown as DataContextRunner,
    boss,
    repository: repo as unknown as WorkflowsRepository
  };
  registerWorkflowsRoutes(app, deps);
  return app;
}

describe("workflow run endpoints", () => {
  it("lists runs without the run input or result", async () => {
    const app = buildApp({ listRuns: async () => [makeRun()] });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/api/workflows/runs" });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<Record<string, unknown>>;
    expect(body).toHaveLength(1);
    expect(body[0]?.id).toBe(RUN_ID);
    expect(body[0]?.status).toBe("running");
    expect(res.body).not.toContain(SECRET_INPUT);
    expect(res.body).not.toContain(SECRET_RESULT);
    expect(body[0]).not.toHaveProperty("inputJson");
    expect(body[0]).not.toHaveProperty("resultJson");
  });

  it("rejects a list limit above the maximum instead of honouring it", async () => {
    const app = buildApp({
      listRuns: async () => {
        throw new Error("the repository should never be reached for an out-of-range limit");
      }
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/api/workflows/runs?limit=101" });

    expect(res.statusCode).toBe(400);
  });

  it("returns one run with its steps, approvals and artifacts, and none of their private payloads", async () => {
    const detail: WorkflowRunDetail = {
      run: makeRun(),
      stepRuns: [makeStepRun()],
      approvals: [makeApproval()],
      artifacts: [makeArtifact()]
    };
    const app = buildApp({ getRunDetail: async () => detail });
    await app.ready();

    const res = await app.inject({ method: "GET", url: `/api/workflows/runs/${RUN_ID}` });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      steps: Array<Record<string, unknown>>;
      approvals: Array<Record<string, unknown>>;
      artifacts: Array<Record<string, unknown>>;
    };
    expect(body.steps).toHaveLength(1);
    expect(body.approvals).toHaveLength(1);
    expect(body.artifacts).toHaveLength(1);
    expect(body.artifacts[0]?.sha256).toBe("a".repeat(64));
    expect(body.artifacts[0]?.sizeBytes).toBe(2048);

    for (const secret of [
      SECRET_INPUT,
      SECRET_RESULT,
      SECRET_STEP_INPUT,
      SECRET_STEP_RESULT,
      SECRET_APPROVAL_DETAIL,
      SECRET_ARTIFACT_REF
    ]) {
      expect(res.body).not.toContain(secret);
    }
    expect(body.steps[0]).not.toHaveProperty("queueJobId");
    expect(body.artifacts[0]).not.toHaveProperty("artifactRef");
  });

  it("answers 404 for a run the caller cannot see, revealing nothing about whether it exists", async () => {
    const app = buildApp({ getRunDetail: async () => null });
    await app.ready();

    const res = await app.inject({ method: "GET", url: `/api/workflows/runs/${RUN_ID}` });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "Workflow run not found" });
  });

  it("cancels a run the caller owns", async () => {
    const app = buildApp({
      cancelRun: async () => ({
        cancelled: true,
        run: makeRun({ status: "cancelled", completedAt: AT }),
        cancelledStepRunCount: 1,
        cancelledApprovalCount: 1
      })
    });
    await app.ready();

    const res = await app.inject({ method: "POST", url: `/api/workflows/runs/${RUN_ID}/cancel` });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { cancelled: boolean; run: Record<string, unknown> };
    expect(body.cancelled).toBe(true);
    expect(body.run.status).toBe("cancelled");
    expect(res.body).not.toContain(SECRET_INPUT);
  });

  it("answers 404 when cancelling a run the caller cannot see", async () => {
    const app = buildApp({
      cancelRun: async () => ({
        cancelled: false,
        run: null,
        cancelledStepRunCount: 0,
        cancelledApprovalCount: 0
      })
    });
    await app.ready();

    const res = await app.inject({ method: "POST", url: `/api/workflows/runs/${RUN_ID}/cancel` });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "Workflow run not found" });
  });

  it.each([
    { decision: "approve" as const, status: "approved" as const },
    { decision: "deny" as const, status: "denied" as const }
  ])("records a $decision and queues one owner-only continuation", async ({ decision, status }) => {
    const sent: Array<{ queue: string; data: unknown }> = [];
    const app = buildApp(
      {
        resolveApproval: async () => ({
          outcome: "resolved",
          approval: makeApproval({ status, resolvedByUserId: OWNER_ID }),
          stepRun: makeStepRun({ status: "queued", queueJobId: null, suspendedAt: null })
        }),
        setStepQueueJobId: async (_scopedDb, stepRunId, jobId) => {
          expect(stepRunId).toBe(STEP_RUN_ID);
          expect(jobId).toBe("continuation-job");
          return makeStepRun({ status: "queued", queueJobId: jobId });
        }
      },
      {
        send: async (queue: string, data: object | null | undefined, _options?: unknown) => {
          sent.push({ queue, data });
          return "continuation-job";
        }
      } as unknown as PgBoss
    );
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: `/api/workflows/approvals/${APPROVAL_ID}/resolve`,
      payload: { decision }
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      approval: Record<string, unknown>;
      step: Record<string, unknown>;
    };
    expect(body.approval.status).toBe(status);
    expect(body.step.status).toBe("queued");
    expect(sent).toEqual([
      {
        queue: "workflow.step.execute",
        data: { actorUserId: OWNER_ID, workflowRunId: RUN_ID, stepRunId: STEP_RUN_ID }
      }
    ]);
    expect(res.body).not.toContain(SECRET_APPROVAL_DETAIL);
    expect(res.body).not.toContain(SECRET_STEP_RESULT);
  });

  it("answers 409 when the approval has already been answered", async () => {
    const app = buildApp({ resolveApproval: async () => ({ outcome: "not-pending" }) });
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: `/api/workflows/approvals/${APPROVAL_ID}/resolve`,
      payload: { decision: "deny" }
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "This approval has already been answered" });
  });

  it("answers 404 for an approval the caller cannot see", async () => {
    const app = buildApp({ resolveApproval: async () => ({ outcome: "not-found" }) });
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: `/api/workflows/approvals/${APPROVAL_ID}/resolve`,
      payload: { decision: "approve" }
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "Approval not found" });
  });

  it("rejects a decision that is neither approve nor deny", async () => {
    const app = buildApp({
      resolveApproval: async () => {
        throw new Error("the repository should never be reached for an invalid decision");
      }
    });
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: `/api/workflows/approvals/${APPROVAL_ID}/resolve`,
      payload: { decision: "maybe" }
    });

    expect(res.statusCode).toBe(400);
  });
});
