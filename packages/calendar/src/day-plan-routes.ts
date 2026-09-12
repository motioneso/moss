import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AccessContext, DataContextDb, DataContextRunner } from "@moss/db";
import { handleRouteError, HttpError } from "@moss/module-sdk";
import {
  createDayPlanRouteSchema,
  getDayPlanRouteSchema,
  saveDayPlanRouteSchema,
  type CreateDayPlanRequest,
  type CreateDayPlanResponse,
  type GetDayPlanQuery,
  type GetDayPlanResponse,
  type SaveDayPlanRequest,
  type SaveDayPlanResponse
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
  readonly dayPlanRepository: Pick<DayPlanRepository, "getForDay" | "createForDay" | "saveDraft">;
  readonly findSourceRun: (scopedDb: DataContextDb, runId: string) => Promise<unknown>;
  readonly resolveTimeZone: (
    request: FastifyRequest,
    accessContext: AccessContext
  ) => Promise<string>;
}

const SAVE_BODY_KEYS = new Set(["date", "timeZone", "expectedRevision", "eveningIntent", "blocks"]);
const INTENT_KEYS = new Set(["priorityTaskIds", "capacity", "notes", "corrections", "commitments"]);
const CORRECTION_KEYS = new Set(["taskId", "note", "source"]);
const COMMITMENT_KEYS = new Set(["taskId", "decision"]);
const BLOCK_KEYS = new Set(["id", "kind", "taskId", "title", "pendingChange"]);
const PENDING_KEYS = new Set(["kind", "startsAt", "durationMinutes"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstUnknown(value: Record<string, unknown>, allowed: Set<string>, prefix: string) {
  const key = Object.keys(value).find((entry) => !allowed.has(entry));
  return key === undefined ? undefined : `${prefix}${key}`;
}

function findUnknownSaveField(body: unknown): string | undefined {
  if (!isObject(body)) return "body";
  const root = firstUnknown(body, SAVE_BODY_KEYS, "");
  if (root) return root;
  if (isObject(body.eveningIntent)) {
    const intent = firstUnknown(body.eveningIntent, INTENT_KEYS, "eveningIntent.");
    if (intent) return intent;
    const corrections = body.eveningIntent.corrections;
    for (const [index, correction] of (Array.isArray(corrections) ? corrections : []).entries()) {
      if (isObject(correction)) {
        const unknown = firstUnknown(
          correction,
          CORRECTION_KEYS,
          `eveningIntent.corrections[${index}].`
        );
        if (unknown) return unknown;
      }
    }
    const commitments = body.eveningIntent.commitments;
    for (const [index, commitment] of (Array.isArray(commitments) ? commitments : []).entries()) {
      if (isObject(commitment)) {
        const unknown = firstUnknown(
          commitment,
          COMMITMENT_KEYS,
          `eveningIntent.commitments[${index}].`
        );
        if (unknown) return unknown;
      }
    }
  }
  if (Array.isArray(body.blocks)) {
    for (const [index, block] of body.blocks.entries()) {
      if (!isObject(block)) continue;
      const unknown = firstUnknown(block, BLOCK_KEYS, `blocks[${index}].`);
      if (unknown) return unknown;
      if (isObject(block.pendingChange)) {
        const pending = firstUnknown(
          block.pendingChange,
          PENDING_KEYS,
          `blocks[${index}].pendingChange.`
        );
        if (pending) return pending;
      }
    }
  }
  return undefined;
}

async function rejectUnknownSaveFields(request: FastifyRequest, reply: FastifyReply) {
  const unknown = findUnknownSaveField(request.body);
  if (unknown) {
    return reply.code(400).send({ error: `unknown field: ${unknown}`, code: "day_plan_invalid" });
  }
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

  const draftAccessContexts = new WeakMap<FastifyRequest, AccessContext>();
  const authenticateDraft = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      draftAccessContexts.set(request, await dependencies.resolveAccessContext(request));
    } catch (error) {
      handleRouteError(error, reply);
    }
  };

  server.patch<{ Params: { id: string }; Body: SaveDayPlanRequest }>(
    "/api/calendar/day-plans/:id/draft",
    {
      schema: saveDayPlanRouteSchema,
      onRequest: authenticateDraft,
      preValidation: rejectUnknownSaveFields
    },
    async (request, reply) => {
      try {
        const accessContext = draftAccessContexts.get(request);
        if (!accessContext) throw new HttpError(500, "day plan access context is unavailable");
        const body = request.body;
        const localDay = normalizeLocalDay(body.date);
        const timeZone = normalizeTimeZone(body.timeZone);
        const eveningIntent =
          body.eveningIntent === null || body.eveningIntent === undefined
            ? body.eveningIntent
            : {
                ...body.eveningIntent,
                corrections: body.eveningIntent.corrections?.map((correction) => ({
                  ...correction,
                  taskId: correction.taskId === "" ? null : correction.taskId
                }))
              };
        const blocks = body.blocks?.map((block) => ({
          ...block,
          taskId: block.taskId === "" ? null : block.taskId,
          title: block.title === "" ? null : block.title
        }));
        const plan = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
          dependencies.dayPlanRepository.saveDraft(scopedDb, {
            planId: request.params.id,
            localDay,
            timeZone,
            expectedRevision: body.expectedRevision,
            eveningIntent,
            blocks
          })
        );
        return { plan } satisfies SaveDayPlanResponse;
      } catch (error) {
        if (error instanceof DayPlanValidationError) {
          return reply.code(400).send({ error: error.message, code: error.code });
        }
        return handleRouteError(error, reply);
      }
    }
  );
}
