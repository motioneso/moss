import type { FastifyInstance, FastifyRequest } from "fastify";
import { Type, type Static } from "@sinclair/typebox";
import type { PgBoss } from "pg-boss";
import type { AccessContext, DataContextRunner } from "@moss/db";
import { GoalsRepository } from "./repository.js";
import { sendJob } from "@moss/jobs";
import { GOALS_MEMORY_SYNC_QUEUE } from "./manifest.js";
import type { MossGoalEvidenceKind, MossGoalSourceKind } from "./types.js";

export interface GoalsRouteDependencies {
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  readonly dataContext: DataContextRunner;
  readonly boss: PgBoss;
  readonly repository?: GoalsRepository;
}

const listGoalsResponseSchema = Type.Array(Type.Any());
const getGoalResponseSchema = Type.Any();

const createGoalRequestSchema = Type.Object({
  title: Type.String({ minLength: 1 }),
  desiredOutcome: Type.String({ minLength: 1 }),
  priority: Type.Optional(
    Type.Union([
      Type.Literal(1),
      Type.Literal(2),
      Type.Literal(3),
      Type.Literal(4),
      Type.Literal(5)
    ])
  ),
  reviewCadence: Type.Optional(
    Type.Union([
      Type.Literal("none"),
      Type.Literal("daily"),
      Type.Literal("weekly"),
      Type.Literal("biweekly"),
      Type.Literal("monthly"),
      Type.Literal("custom")
    ])
  ),
  targetAt: Type.Optional(Type.String({ format: "date-time" }))
});
type CreateGoalRequest = Static<typeof createGoalRequestSchema>;

const updateGoalRequestSchema = Type.Object({
  title: Type.Optional(Type.String({ minLength: 1 })),
  desiredOutcome: Type.Optional(Type.String({ minLength: 1 })),
  status: Type.Optional(
    Type.Union([
      Type.Literal("active"),
      Type.Literal("paused"),
      Type.Literal("blocked"),
      Type.Literal("completed"),
      Type.Literal("archived")
    ])
  ),
  priority: Type.Optional(
    Type.Union([
      Type.Literal(1),
      Type.Literal(2),
      Type.Literal(3),
      Type.Literal(4),
      Type.Literal(5)
    ])
  ),
  reviewCadence: Type.Optional(
    Type.Union([
      Type.Literal("none"),
      Type.Literal("daily"),
      Type.Literal("weekly"),
      Type.Literal("biweekly"),
      Type.Literal("monthly"),
      Type.Literal("custom")
    ])
  ),
  targetAt: Type.Optional(Type.Union([Type.String({ format: "date-time" }), Type.Null()])),
  lastProgressSummary: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  blockerSummary: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  nextSuggestedAction: Type.Optional(Type.Union([Type.String(), Type.Null()]))
});
type UpdateGoalRequest = Static<typeof updateGoalRequestSchema>;

const addEvidenceRequestSchema = Type.Object({
  evidenceKind: Type.Union([
    Type.Literal("context"),
    Type.Literal("task"),
    Type.Literal("status"),
    Type.Literal("progress"),
    Type.Literal("blocker"),
    Type.Literal("decision"),
    Type.Literal("checkpoint"),
    Type.Literal("suggested_action")
  ]),
  sourceKind: Type.Union([
    Type.Literal("goal"),
    Type.Literal("task"),
    Type.Literal("note"),
    Type.Literal("email"),
    Type.Literal("calendar"),
    Type.Literal("chat"),
    Type.Literal("memory"),
    Type.Literal("manual")
  ]),
  sourceRef: Type.Optional(Type.String()),
  sourceLabel: Type.String(),
  summary: Type.String(),
  occurredAt: Type.Optional(Type.String({ format: "date-time" }))
});
type AddEvidenceRequest = Static<typeof addEvidenceRequestSchema>;

export function registerGoalsRoutes(app: FastifyInstance, deps: GoalsRouteDependencies): void {
  const repository = deps.repository ?? new GoalsRepository();

  app.get(
    "/api/goals",
    { schema: { response: { 200: listGoalsResponseSchema } } },
    async (request) => {
      const accessContext = await deps.resolveAccessContext(request);
      return deps.dataContext.withDataContext(accessContext, async (scopedDb) => {
        return repository.list(scopedDb);
      });
    }
  );

  app.get(
    "/api/goals/:id",
    { schema: { response: { 200: getGoalResponseSchema } } },
    async (request) => {
      const { id } = request.params as { id: string };
      const accessContext = await deps.resolveAccessContext(request);
      return deps.dataContext.withDataContext(accessContext, async (scopedDb) => {
        const goal = await repository.getById(scopedDb, id);
        if (!goal) {
          throw Object.assign(new Error("Goal not found"), { statusCode: 404 });
        }
        return goal;
      });
    }
  );

  app.post(
    "/api/goals",
    { schema: { body: createGoalRequestSchema, response: { 201: getGoalResponseSchema } } },
    async (request, reply) => {
      const accessContext = await deps.resolveAccessContext(request);
      const data = request.body as CreateGoalRequest;
      const goal = await deps.dataContext.withDataContext(accessContext, async (scopedDb) => {
        return repository.create(scopedDb, accessContext.actorUserId, {
          ...data,
          targetAt: data.targetAt ?? null
        });
      });
      reply.status(201);
      return goal;
    }
  );

  app.patch(
    "/api/goals/:id",
    { schema: { body: updateGoalRequestSchema, response: { 200: getGoalResponseSchema } } },
    async (request) => {
      const { id } = request.params as { id: string };
      const accessContext = await deps.resolveAccessContext(request);
      const data = request.body as UpdateGoalRequest;

      const goal = await deps.dataContext.withDataContext(accessContext, async (scopedDb) => {
        return repository.update(scopedDb, id, data);
      });

      // Enqueue sync
      await sendJob(deps.boss, GOALS_MEMORY_SYNC_QUEUE, {
        actorUserId: accessContext.actorUserId,
        goalId: goal.id,
        goalUpdatedAt: goal.updatedAt,
        reason: "goal updated",
        idempotencyKey: `sync:${goal.id}:${goal.updatedAt}`
      });

      return goal;
    }
  );

  app.post(
    "/api/goals/:id/evidence",
    { schema: { body: addEvidenceRequestSchema, response: { 201: Type.Any() } } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const accessContext = await deps.resolveAccessContext(request);
      const data = request.body as AddEvidenceRequest;

      const evidence = await deps.dataContext.withDataContext(accessContext, async (scopedDb) => {
        return repository.addEvidence(scopedDb, accessContext.actorUserId, id, {
          evidenceKind: data.evidenceKind as MossGoalEvidenceKind,
          sourceKind: data.sourceKind as MossGoalSourceKind,
          sourceRef: data.sourceRef,
          sourceLabel: data.sourceLabel,
          summary: data.summary,
          occurredAt: data.occurredAt ?? null
        });
      });

      // Update goal so its `updatedAt` is bumped for memory sync
      const goal = await deps.dataContext.withDataContext(accessContext, async (scopedDb) => {
        return repository.update(scopedDb, id, {});
      });

      await sendJob(deps.boss, GOALS_MEMORY_SYNC_QUEUE, {
        actorUserId: accessContext.actorUserId,
        goalId: goal.id,
        goalUpdatedAt: goal.updatedAt,
        reason: "evidence added",
        idempotencyKey: `sync:${goal.id}:${goal.updatedAt}`
      });

      reply.status(201);
      return evidence;
    }
  );
}
