/**
 * Owner-scoped workflow run endpoints (#2013, slice 819-B).
 *
 * There is no route that creates a workflow definition and no route that starts a run:
 * starting is module/server code, per the spec's "API Surface" section. There is no queue
 * dependency here either — resolving an approval records the decision and stops; continuing
 * the run is #2015.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Type } from "@sinclair/typebox";
import type { AccessContext, DataContextRunner } from "@moss/db";
import type {
  CancelWorkflowRunResponse,
  ListWorkflowRunsResponse,
  ResolveWorkflowApprovalResponse,
  WorkflowApprovalDto,
  WorkflowArtifactDto,
  WorkflowRunDetailDto,
  WorkflowRunDto,
  WorkflowStepRunDto
} from "@moss/shared";
import { WorkflowsRepository } from "./repository.js";
import { WORKFLOW_RUN_LIST_MAX_LIMIT } from "./types.js";
import type {
  WorkflowApproval,
  WorkflowArtifact,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowStepRun
} from "./types.js";

export interface WorkflowsRouteDependencies {
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  readonly dataContext: DataContextRunner;
  readonly repository?: WorkflowsRepository;
}

const runStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("running"),
  Type.Literal("suspended"),
  Type.Literal("succeeded"),
  Type.Literal("failed"),
  Type.Literal("cancelled")
]);

export function registerWorkflowsRoutes(
  app: FastifyInstance,
  deps: WorkflowsRouteDependencies
): void {
  const repo = deps.repository ?? new WorkflowsRepository();

  // GET /api/workflows/runs
  const listQuerySchema = Type.Object({
    status: Type.Optional(runStatusSchema),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: WORKFLOW_RUN_LIST_MAX_LIMIT }))
  });
  app.get(
    "/api/workflows/runs",
    { schema: { querystring: listQuerySchema, response: { 200: Type.Array(Type.Any()) } } },
    async (request): Promise<ListWorkflowRunsResponse> => {
      const accessContext = await deps.resolveAccessContext(request);
      const { status, limit } = request.query as { status?: WorkflowRunStatus; limit?: number };
      return deps.dataContext.withDataContext(accessContext, async (scopedDb) => {
        const runs = await repo.listRuns(scopedDb, accessContext.actorUserId, { status, limit });
        return runs.map(safeRun);
      });
    }
  );

  // GET /api/workflows/runs/:id
  app.get(
    "/api/workflows/runs/:id",
    { schema: { response: { 200: Type.Any(), 404: Type.Any() } } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const accessContext = await deps.resolveAccessContext(request);
      return deps.dataContext.withDataContext(accessContext, async (scopedDb) => {
        const detail = await repo.getRunDetail(scopedDb, accessContext.actorUserId, id);
        // Deliberately the same answer whether the run belongs to someone else or does not
        // exist: a 403 here would confirm that a given run id is real.
        if (!detail) return reply.code(404).send({ error: "Workflow run not found" });
        const body: WorkflowRunDetailDto = {
          ...safeRun(detail.run),
          steps: detail.stepRuns.map(safeStepRun),
          approvals: detail.approvals.map(safeApproval),
          artifacts: detail.artifacts.map(safeArtifact)
        };
        return body;
      });
    }
  );

  // POST /api/workflows/runs/:id/cancel
  app.post(
    "/api/workflows/runs/:id/cancel",
    { schema: { response: { 200: Type.Any(), 404: Type.Any() } } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const accessContext = await deps.resolveAccessContext(request);
      return deps.dataContext.withDataContext(accessContext, async (scopedDb) => {
        const result = await repo.cancelRun(scopedDb, accessContext.actorUserId, id);
        if (!result.run) return reply.code(404).send({ error: "Workflow run not found" });
        const body: CancelWorkflowRunResponse = {
          cancelled: result.cancelled,
          run: safeRun(result.run)
        };
        return body;
      });
    }
  );

  // POST /api/workflows/approvals/:id/resolve
  const resolveSchema = Type.Object({
    decision: Type.Union([Type.Literal("approve"), Type.Literal("deny")])
  });
  app.post(
    "/api/workflows/approvals/:id/resolve",
    {
      schema: {
        body: resolveSchema,
        response: { 200: Type.Any(), 404: Type.Any(), 409: Type.Any() }
      }
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { decision } = request.body as { decision: "approve" | "deny" };
      const accessContext = await deps.resolveAccessContext(request);
      return deps.dataContext.withDataContext(accessContext, async (scopedDb) => {
        const result = await repo.resolveApproval(
          scopedDb,
          accessContext.actorUserId,
          id,
          decision
        );
        if (result.outcome === "not-found") {
          return reply.code(404).send({ error: "Approval not found" });
        }
        if (result.outcome === "not-pending") {
          return reply.code(409).send({ error: "This approval has already been answered" });
        }
        const body: ResolveWorkflowApprovalResponse = {
          approval: safeApproval(result.approval),
          step: safeStepRun(result.stepRun)
        };
        return body;
      });
    }
  );
}

/**
 * Everything below is the single place responses are trimmed, so a reviewer can check the
 * redaction in one read. Each one returns the matching shape from
 * packages/shared/src/workflows-api.ts, so the published contract and what the endpoints
 * actually send cannot drift apart without the typecheck failing.
 *
 * `inputJson` and `resultJson` never leave the server through these routes. Run input may
 * carry bounded origin metadata under `__origin` (see the spec's "Run Origins"), and result
 * payloads can name artifacts; neither is needed by a caller listing or inspecting runs, and
 * shipping them would be the easiest way for private content to leak into a client.
 */
function safeRun(run: WorkflowRun): WorkflowRunDto {
  return {
    id: run.id,
    workflowId: run.workflowId,
    workflowVersion: run.workflowVersion,
    moduleId: run.moduleId,
    status: run.status,
    startedBy: run.startedBy,
    startedAt: run.startedAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString()
  };
}

function safeStepRun(step: WorkflowStepRun): WorkflowStepRunDto {
  return {
    id: step.id,
    workflowRunId: step.workflowRunId,
    stepId: step.stepId,
    status: step.status,
    attemptCount: step.attemptCount,
    errorCode: step.errorCode,
    startedAt: step.startedAt?.toISOString() ?? null,
    suspendedAt: step.suspendedAt?.toISOString() ?? null,
    completedAt: step.completedAt?.toISOString() ?? null
  };
}

function safeApproval(approval: WorkflowApproval): WorkflowApprovalDto {
  return {
    id: approval.id,
    workflowRunId: approval.workflowRunId,
    stepRunId: approval.stepRunId,
    status: approval.status,
    summary: approval.summary,
    resolvedByUserId: approval.resolvedByUserId,
    createdAt: approval.createdAt.toISOString(),
    updatedAt: approval.updatedAt.toISOString()
  };
}

/** `artifactRef` is dropped here on purpose: it addresses bytes in the vault. */
function safeArtifact(artifact: WorkflowArtifact): WorkflowArtifactDto {
  return {
    id: artifact.id,
    workflowRunId: artifact.workflowRunId,
    stepRunId: artifact.stepRunId,
    sha256: artifact.sha256,
    contentType: artifact.contentType,
    sizeBytes: artifact.sizeBytes,
    createdAt: artifact.createdAt.toISOString()
  };
}
