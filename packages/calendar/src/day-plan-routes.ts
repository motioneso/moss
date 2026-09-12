import type { FastifyInstance, FastifyRequest } from "fastify";

import type { AccessContext, DataContextRunner } from "@moss/db";
import { handleRouteError } from "@moss/module-sdk";
import { getDayPlanRouteSchema, type GetDayPlanQuery, type GetDayPlanResponse } from "@moss/shared";

import { DayPlanValidationError, normalizeLocalDay, normalizeTimeZone } from "./day-plan-model.js";
import type { DayPlanRepository } from "./day-plan-repository.js";

export interface DayPlanRoutesDependencies {
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  readonly dataContext: Pick<DataContextRunner, "withDataContext">;
  readonly dayPlanRepository: Pick<DayPlanRepository, "getForDay">;
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
}
