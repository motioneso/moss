import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AccessContext, DataContextDb, DataContextRunner } from "@moss/db";
import { handleRouteError, HttpError } from "@moss/module-sdk";
import {
  createDayPlanRouteSchema,
  getDayPlanRouteSchema,
  type CreateDayPlanRequest,
  type CreateDayPlanResponse,
  type GetDayPlanQuery,
  type GetDayPlanResponse
} from "@moss/shared";

import {
  DayPlanValidationError,
  normalizeLocalDay,
  normalizeSourceRunId,
  normalizeTimeZone
} from "./day-plan-model.js";
import type { DayPlanRepository } from "./day-plan-repository.js";

export interface DayPlanRoutesDependencies {
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  readonly dataContext: Pick<DataContextRunner, "withDataContext">;
  readonly dayPlanRepository: Pick<DayPlanRepository, "getForDay" | "createForDay">;
  readonly findSourceRun: (scopedDb: DataContextDb, runId: string) => Promise<unknown>;
  readonly resolveTimeZone: (
    request: FastifyRequest,
    accessContext: AccessContext
  ) => Promise<string>;
}

export function registerDayPlanRoutes(
  server: FastifyInstance,
  dependencies: DayPlanRoutesDependencies
): void {
  server.get<{ Querystring: GetDayPlanQuery }>(
    "/api/calendar/day-plan",
    { schema: getDayPlanRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const localDay = normalizeLocalDay(request.query.date);
        const timeZone = normalizeTimeZone(
          request.query.timeZone ?? (await dependencies.resolveTimeZone(request, accessContext))
        );
        const plan = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
          dependencies.dayPlanRepository.getForDay(scopedDb, { localDay, timeZone })
        );
        return { plan: plan ?? null } satisfies GetDayPlanResponse;
      } catch (error) {
        if (error instanceof DayPlanValidationError) {
          return reply.code(400).send({ error: error.message, code: error.code });
        }
        return handleRouteError(error, reply);
      }
    }
  );

  const CREATE_BODY_KEYS: ReadonlySet<string> = new Set(["date", "timeZone", "sourceRunId"]);

  // The gateway validator strips unknown keys and coerces "" to null before the
  // handler runs, so strictness is enforced here on the parsed body instead.
  async function rejectUnknownCreateFields(request: FastifyRequest, reply: FastifyReply) {
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return reply.code(400).send({ error: "request must be an object", code: "day_plan_invalid" });
    }
    for (const key of Object.keys(body)) {
      if (!CREATE_BODY_KEYS.has(key)) {
        return reply.code(400).send({ error: `unknown field: ${key}`, code: "day_plan_invalid" });
      }
    }
    if (body.sourceRunId === "") {
      return reply
        .code(400)
        .send({ error: "sourceRunId must be an id or null", code: "day_plan_invalid" });
    }
  }

  server.post<{ Body: CreateDayPlanRequest }>(
    "/api/calendar/day-plans",
    { schema: createDayPlanRouteSchema, preValidation: rejectUnknownCreateFields },
    async (request, reply) => {
      try {
        const body = (request.body ?? {}) as Partial<CreateDayPlanRequest>;
        const accessContext = await dependencies.resolveAccessContext(request);
        const localDay = normalizeLocalDay(body.date);
        const timeZone = normalizeTimeZone(
          body.timeZone ?? (await dependencies.resolveTimeZone(request, accessContext))
        );
        const sourceRunId = normalizeSourceRunId(body.sourceRunId ?? null);
        const plan = await dependencies.dataContext.withDataContext(
          accessContext,
          async (scopedDb) => {
            if (sourceRunId !== null) {
              const run = await dependencies.findSourceRun(scopedDb, sourceRunId);
              if (!run) {
                throw new HttpError(404, "briefing run is not available");
              }
            }
            return dependencies.dayPlanRepository.createForDay(scopedDb, {
              localDay,
              timeZone,
              sourceRunId
            });
          }
        );
        return { plan } satisfies CreateDayPlanResponse;
      } catch (error) {
        if (error instanceof DayPlanValidationError) {
          return reply.code(400).send({ error: error.message, code: error.code });
        }
        return handleRouteError(error, reply);
      }
    }
  );
}
