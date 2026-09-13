import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AccessContext, BriefingRun, DataContextDb, DataContextRunner, Task } from "@moss/db";
import { isUuid } from "@moss/db";
import { handleRouteError, HttpError, localDayRange } from "@moss/module-sdk";
import type { ToolContext } from "@moss/module-sdk";
import {
  applyDayPlanRouteSchema,
  createDayPlanRouteSchema,
  dayPlanApplyStatusRouteSchema,
  getDayPlanRouteSchema,
  previewDayPlanRouteSchema,
  recoverDayPlanApplyRouteSchema,
  retryDayPlanApplyRouteSchema,
  saveDayPlanRouteSchema,
  type ApplyDayPlanRequest,
  type ApplyExecutionReport,
  type CreateDayPlanRequest,
  type CreateDayPlanResponse,
  type DayPlanApplyBatchDto,
  type DayPlanApplyOperationStatus,
  type DayPlanApplyStatusResponse,
  type DayPlanCalendarAvailability,
  type DayPlanDto,
  type DayPlanSourceRunSummary,
  type DayPlanTaskSummary,
  type GetDayPlanQuery,
  type GetDayPlanResponse,
  type PreviewDayPlanRequest,
  type PreviewDayPlanResponse,
  type RecoverDayPlanApplyRequest,
  type RetryDayPlanApplyRequest,
  type SaveDayPlanRequest,
  type SaveDayPlanResponse
} from "@moss/shared";
import { batchHasChanges } from "./day-plan-change-approval.js";
import {
  gateReservedChanges,
  registerDayPlanChangeConfirmRoute,
  resolveChangeAuth
} from "./day-plan-change-routes.js";
import type { DayPlanChangeApprovalPort } from "./day-plan-change-approval.js";
import type { ApplyExecutionRouteCallback } from "./day-plan-execute.js";

import {
  DayPlanValidationError,
  normalizeLocalDay,
  normalizeSourceRunId,
  normalizeTimeZone
} from "./day-plan-model.js";
import type { DayPlanRepository } from "./day-plan-repository.js";
import { buildDayPlanPreview, type DayPlanPreviewTaskFact } from "./day-plan-preview.js";

export interface DayPlanTaskProjection {
  (scopedDb: DataContextDb, taskId: string): Promise<Task | undefined>;
}

export interface DayPlanRunProjection {
  (scopedDb: DataContextDb, runId: string): Promise<BriefingRun | undefined>;
}

// The connectors package's own hard cap (source-context/calendar.ts CALENDAR_MAX_LIMIT). Kept as
// a literal, not an import, so the preview route never gains an @moss/connectors dependency.
const DAY_PLAN_PREVIEW_CALENDAR_LIMIT = 200;

// Structural interface — no @moss/connectors import (module isolation, mirrors tools.ts).
// Shape mirrors the connectors SourceContextService calendar surface.
export interface DayPlanCalendarContextItemShape {
  readonly eventKey: string;
  readonly title: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly allDay: boolean;
  readonly account: { readonly providerLabel: string };
}

export interface DayPlanSourceContextService {
  listCalendarContext(
    scopedDb: DataContextDb,
    input: { windowStart?: string; windowEnd?: string; limit?: number }
  ): Promise<{
    items: readonly DayPlanCalendarContextItemShape[];
    accounts: readonly { source: "live" | "cache" }[];
    gaps: readonly unknown[];
    /** True when more matching events existed than `items` returned. */
    truncated: boolean;
    /** Latest connector sync these facts are drawn from, or null if none has synced. */
    asOf: string | null;
  }>;
}

export interface DayPlanRoutesDependencies {
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  readonly dataContext: Pick<DataContextRunner, "withDataContext">;
  readonly dayPlanRepository: Pick<
    DayPlanRepository,
    | "getForDay"
    | "createForDay"
    | "saveDraft"
    | "getById"
    | "reserveApplyBatch"
    | "getApplyBatch"
    | "getApplyBatchById"
  >;
  // Absent when this deployment has no connector-backed execution runtime.
  // Apply and retry fail closed with 503 before any mutation; status reads
  // durable state and never needs it.
  readonly applyExecution?: ApplyExecutionRouteCallback;
  // Database-backed approval store for reserved moves and removals. Absent in
  // tests that predate the change gate; gated batches fail closed with 503.
  readonly changeApproval?: DayPlanChangeApprovalPort;
  readonly findSourceRun: (scopedDb: DataContextDb, runId: string) => Promise<unknown>;
  readonly findTask?: DayPlanTaskProjection;
  readonly findRun: DayPlanRunProjection;
  readonly resolveTimeZone: (
    request: FastifyRequest,
    accessContext: AccessContext
  ) => Promise<string>;
  /** Absent means the deployment has no connector-backed calendar reads — preview then always reports "unavailable". */
  readonly sourceContext?: DayPlanSourceContextService;
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

function firstUnknown(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  prefix: string
) {
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

const PREVIEW_BODY_KEYS = new Set(["expectedRevision", "selectedChangeBlockIds"]);

async function rejectUnknownPreviewFields(request: FastifyRequest, reply: FastifyReply) {
  const body = request.body;
  if (!isObject(body)) {
    return reply.code(400).send({ error: "request must be an object", code: "day_plan_invalid" });
  }
  const unknown = firstUnknown(body, PREVIEW_BODY_KEYS, "");
  if (unknown) {
    return reply.code(400).send({ error: `unknown field: ${unknown}`, code: "day_plan_invalid" });
  }
}

function taskStatusForPreview(status: Task["status"]): "done" | "archived" | "other" {
  if (status === "done") return "done";
  if (status === "archived") return "archived";
  return "other";
}

/**
 * UTC bounds the calendar read must cover: the plan's whole local day (DST-safe, via the shared
 * `localDayRange` helper — never a fixed 24 hours), widened to also cover every selected block's
 * before and after timing. A saved proposal is not constrained to its plan's local day, so a
 * change starting late in the evening or crossing local midnight must still be checked.
 */
function previewCalendarWindow(
  plan: DayPlanDto,
  selectedBlockIds: readonly string[]
): { start: string; end: string } {
  const dayRange = localDayRange(plan.localDay, plan.timeZone);
  let startMs = dayRange.start.getTime();
  let endMs = dayRange.end.getTime();
  const extend = (startsAt: string | null, durationMinutes: number | null) => {
    if (startsAt === null || durationMinutes === null) return;
    const s = new Date(startsAt).getTime();
    const e = s + durationMinutes * 60_000;
    if (s < startMs) startMs = s;
    if (e > endMs) endMs = e;
  };
  const blockById = new Map(plan.blocks.map((block) => [block.id, block]));
  for (const id of selectedBlockIds) {
    const block = blockById.get(id);
    if (!block) continue;
    if (block.actualPlacement) {
      extend(block.actualPlacement.startsAt, block.actualPlacement.durationMinutes);
    }
    if (block.pendingChange && block.pendingChange.kind !== "remove") {
      extend(block.pendingChange.startsAt, block.pendingChange.durationMinutes);
    }
  }
  return { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() };
}

async function rejectUnknownSaveFields(request: FastifyRequest, reply: FastifyReply) {
  const unknown = findUnknownSaveField(request.body);
  if (unknown) {
    return reply.code(400).send({ error: `unknown field: ${unknown}`, code: "day_plan_invalid" });
  }
}

function toIso(value: Date | string | null): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : value;
}

// The stored plan is returned unchanged. Task summaries and the source-run
// reference are a live projection beside it: current actor-visible records
// only, with missing references reported instead of failing the read.
async function enrichSavedRead(
  scopedDb: DataContextDb,
  dependencies: DayPlanRoutesDependencies,
  plan: DayPlanDto | null
): Promise<GetDayPlanResponse> {
  if (!plan) {
    return {
      plan: null,
      tasks: [],
      unavailableTaskIds: [],
      sourceRun: null,
      sourceRunUnavailable: false
    };
  }
  const referencedIds: string[] = [];
  const seen = new Set<string>();
  const remember = (taskId: string | null) => {
    if (taskId !== null && !seen.has(taskId)) {
      seen.add(taskId);
      referencedIds.push(taskId);
    }
  };
  for (const taskId of plan.eveningIntent?.priorityTaskIds ?? []) remember(taskId);
  for (const correction of plan.eveningIntent?.corrections ?? []) remember(correction.taskId);
  for (const commitment of plan.eveningIntent?.commitments ?? []) remember(commitment.taskId);
  for (const block of plan.blocks) remember(block.taskId);

  const tasks: DayPlanTaskSummary[] = [];
  const unavailableTaskIds: string[] = [];
  if (dependencies.findTask) {
    for (const taskId of referencedIds) {
      const task = await dependencies.findTask(scopedDb, taskId);
      if (!task) {
        unavailableTaskIds.push(taskId);
        continue;
      }
      tasks.push({
        id: task.id,
        title: task.title,
        status: task.status,
        dueAt: toIso(task.due_at),
        doAt: toIso(task.do_at),
        effort: task.effort
      });
    }
  } else {
    unavailableTaskIds.push(...referencedIds);
  }

  let sourceRun: DayPlanSourceRunSummary | null = null;
  let sourceRunUnavailable = false;
  if (plan.sourceRunId !== null) {
    const run = await dependencies.findRun(scopedDb, plan.sourceRunId);
    if (run) {
      sourceRun = {
        id: run.id,
        briefingType: run.briefing_type,
        status: run.status,
        createdAt: toIso(run.created_at) ?? ""
      };
    } else {
      sourceRunUnavailable = true;
    }
  }
  return { plan, tasks, unavailableTaskIds, sourceRun, sourceRunUnavailable };
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
        const enriched = await dependencies.dataContext.withDataContext(
          accessContext,
          async (scopedDb) => {
            const plan = await dependencies.dayPlanRepository.getForDay(scopedDb, {
              localDay,
              timeZone
            });
            return enrichSavedRead(scopedDb, dependencies, plan ?? null);
          }
        );
        return enriched satisfies GetDayPlanResponse;
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

  const previewAccessContexts = new WeakMap<FastifyRequest, AccessContext>();
  const authenticatePreview = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      previewAccessContexts.set(request, await dependencies.resolveAccessContext(request));
    } catch (error) {
      handleRouteError(error, reply);
    }
  };

  server.post<{ Params: { id: string }; Body: PreviewDayPlanRequest }>(
    "/api/calendar/day-plans/:id/preview",
    {
      schema: previewDayPlanRouteSchema,
      onRequest: authenticatePreview,
      preValidation: rejectUnknownPreviewFields
    },
    async (request, reply) => {
      try {
        const accessContext = previewAccessContexts.get(request);
        if (!accessContext) throw new HttpError(500, "day plan access context is unavailable");
        const body = request.body;
        if (!Number.isInteger(body.expectedRevision) || body.expectedRevision < 1) {
          throw new HttpError(400, "expectedRevision must be a positive integer");
        }
        const preview = await dependencies.dataContext.withDataContext(
          accessContext,
          async (scopedDb) => {
            const plan = await dependencies.dayPlanRepository.getById(scopedDb, request.params.id);
            if (!plan) throw new HttpError(404, "day plan is not available");
            if (plan.revision !== body.expectedRevision) {
              throw new HttpError(409, "day plan changed since it was read");
            }

            const taskIds = new Set<string>();
            for (const block of plan.blocks) {
              if (block.taskId !== null) taskIds.add(block.taskId);
            }
            const taskFacts = new Map<string, DayPlanPreviewTaskFact>();
            if (dependencies.findTask) {
              for (const taskId of taskIds) {
                const task = await dependencies.findTask(scopedDb, taskId);
                if (task) {
                  taskFacts.set(taskId, {
                    status: taskStatusForPreview(task.status),
                    dueAt: toIso(task.due_at)
                  });
                }
              }
            }

            let busyIntervals: {
              start: string;
              end: string;
              eventKey: string;
              title: string;
              accountLabel: string;
            }[] = [];
            let calendarAvailability: DayPlanCalendarAvailability = "unavailable";
            let calendarAsOf: string | null = null;
            if (dependencies.sourceContext) {
              const { start, end } = previewCalendarWindow(plan, body.selectedChangeBlockIds);
              const context = await dependencies.sourceContext.listCalendarContext(scopedDb, {
                windowStart: start,
                windowEnd: end,
                limit: DAY_PLAN_PREVIEW_CALENDAR_LIMIT
              });
              calendarAsOf = context.asOf;
              const hasKnownAccount = context.accounts.length > 0;
              const complete = hasKnownAccount && context.gaps.length === 0 && !context.truncated;
              if (complete) {
                calendarAvailability = context.accounts.every(
                  (account) => account.source === "live"
                )
                  ? "available"
                  : "stale";
              }
              // A gap on one account or a truncated read only means we can't certify there is
              // NOTHING more out there — calendarAvailability reflects that uncertainty. It does
              // not erase the commitments other accounts already returned, so every item always
              // feeds conflict detection regardless of completeness.
              busyIntervals = context.items
                .filter((item) => !item.allDay)
                .map((item) => ({
                  start: item.startsAt,
                  end: item.endsAt,
                  eventKey: item.eventKey,
                  title: item.title,
                  accountLabel: item.account.providerLabel
                }));
            }

            return buildDayPlanPreview({
              plan,
              selectedBlockIds: body.selectedChangeBlockIds,
              taskFacts,
              busyIntervals,
              calendarAvailability,
              calendarAsOf,
              now: new Date()
            });
          }
        );
        return preview satisfies PreviewDayPlanResponse;
      } catch (error) {
        if (error instanceof DayPlanValidationError) {
          return reply.code(400).send({ error: error.message, code: error.code });
        }
        return handleRouteError(error, reply);
      }
    }
  );

  const applyAccessContexts = new WeakMap<FastifyRequest, AccessContext>();
  const authenticateApplyAccess = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      applyAccessContexts.set(request, await dependencies.resolveAccessContext(request));
    } catch (error) {
      handleRouteError(error, reply);
    }
  };

  function requireApplyAccess(request: FastifyRequest): AccessContext {
    const accessContext = applyAccessContexts.get(request);
    if (!accessContext) throw new HttpError(500, "day plan access context is unavailable");
    return accessContext;
  }

  function requireApplyExecution(): ApplyExecutionRouteCallback {
    const execute = dependencies.applyExecution;
    if (!execute) throw new HttpError(503, "day plan apply is unavailable");
    return execute;
  }

  function toolContextOf(accessContext: AccessContext): ToolContext {
    return {
      actorUserId: accessContext.actorUserId,
      requestId: accessContext.requestId ?? randomUUID(),
      chatSessionId: ""
    };
  }

  function toStatusResponse(batch: DayPlanApplyBatchDto): DayPlanApplyStatusResponse {
    const status: DayPlanApplyOperationStatus = batch.items.some(
      (item) => item.outcome === "pending" || item.outcome === "unknown"
    )
      ? "pending"
      : "completed";
    return {
      operationId: batch.id,
      planId: batch.planId,
      status,
      items: batch.items.map((item) => ({
        itemId: item.id,
        blockId: item.blockId,
        outcome: item.outcome,
        result: item.result
      }))
    };
  }

  const APPLY_BODY_KEYS: ReadonlySet<string> = new Set([
    "expectedRevision",
    "idempotencyKey",
    "operationKey",
    "selectedBlockIds"
  ]);

  async function rejectUnknownApplyFields(request: FastifyRequest, reply: FastifyReply) {
    const body = request.body;
    if (!isObject(body)) {
      return reply.code(400).send({ error: "request must be an object", code: "day_plan_invalid" });
    }
    const unknown = firstUnknown(body, APPLY_BODY_KEYS, "");
    if (unknown) {
      return reply.code(400).send({ error: `unknown field: ${unknown}`, code: "day_plan_invalid" });
    }
    if (!Number.isInteger(body.expectedRevision) || (body.expectedRevision as number) < 1) {
      return reply
        .code(400)
        .send({ error: "expectedRevision must be a positive integer", code: "day_plan_invalid" });
    }
    if (
      typeof body.idempotencyKey !== "string" ||
      body.idempotencyKey.trim().length === 0 ||
      body.idempotencyKey.trim().length > 128
    ) {
      return reply
        .code(400)
        .send({ error: "idempotencyKey must be non-empty text", code: "day_plan_invalid" });
    }
    if (
      body.operationKey !== undefined &&
      body.operationKey !== null &&
      typeof body.operationKey !== "string"
    ) {
      return reply
        .code(400)
        .send({ error: "operationKey must be a string", code: "day_plan_invalid" });
    }
    if (body.selectedBlockIds !== undefined) {
      if (
        !Array.isArray(body.selectedBlockIds) ||
        body.selectedBlockIds.some((id) => typeof id !== "string" || !isUuid(id))
      ) {
        return reply
          .code(400)
          .send({ error: "selectedBlockIds must be a list of ids", code: "day_plan_invalid" });
      }
      if (new Set(body.selectedBlockIds).size !== body.selectedBlockIds.length) {
        return reply
          .code(400)
          .send({ error: "selectedBlockIds must not repeat an id", code: "day_plan_invalid" });
      }
    }
  }

  server.post<{ Params: { id: string }; Body: ApplyDayPlanRequest }>(
    "/api/calendar/day-plans/:id/apply",
    {
      schema: applyDayPlanRouteSchema,
      onRequest: authenticateApplyAccess,
      preValidation: rejectUnknownApplyFields
    },
    async (request, reply) => {
      try {
        const accessContext = requireApplyAccess(request);
        const execute = requireApplyExecution();
        const body = request.body;
        // One short reservation transaction, closed before execution runs
        // any facts or provider work with its own staging.
        const batch = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
          dependencies.dayPlanRepository.reserveApplyBatch(scopedDb, {
            planId: request.params.id,
            expectedRevision: body.expectedRevision,
            idempotencyKey: body.idempotencyKey,
            ...(body.operationKey ? { operationKey: body.operationKey } : {}),
            ...(body.selectedBlockIds !== undefined
              ? { selectedBlockIds: body.selectedBlockIds }
              : {})
          })
        );
        // A reserved move or removal never executes straight from apply under
        // the default tier: the gate answers 202 with the bound change set
        // and records the pending approval, with no item outcome and zero
        // provider calls. Trusted_auto proceeds with the same execution
        // service, which re-checks the tier on its own entry.
        if (batchHasChanges(batch)) {
          const gate = await gateReservedChanges({
            access: accessContext,
            dataContext: dependencies.dataContext,
            dayPlanRepository: dependencies.dayPlanRepository,
            changeApproval: dependencies.changeApproval,
            batch
          });
          if (!gate.proceed) {
            return reply.code(202).send({
              status: gate.status,
              operationId: gate.operationId,
              approvalId: gate.approvalId,
              changes: gate.changes
            });
          }
          const gated = await execute({
            access: accessContext,
            toolCtx: toolContextOf(accessContext),
            planId: batch.planId,
            idempotencyKey: batch.idempotencyKey,
            changeAuth: { tier: gate.tier, approval: null }
          });
          return gated satisfies ApplyExecutionReport;
        }
        const report = await execute({
          access: accessContext,
          toolCtx: toolContextOf(accessContext),
          planId: batch.planId,
          idempotencyKey: batch.idempotencyKey
        });
        return report satisfies ApplyExecutionReport;
      } catch (error) {
        if (error instanceof DayPlanValidationError) {
          return reply.code(400).send({ error: error.message, code: error.code });
        }
        return handleRouteError(error, reply);
      }
    }
  );

  server.get<{ Params: { id: string; operationId: string } }>(
    "/api/calendar/day-plans/:id/operations/:operationId",
    {
      schema: dayPlanApplyStatusRouteSchema,
      onRequest: authenticateApplyAccess
    },
    async (request, reply) => {
      try {
        const accessContext = requireApplyAccess(request);
        // Database-only: works when provider composition is unavailable.
        const batch = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
          dependencies.dayPlanRepository.getApplyBatchById(scopedDb, {
            planId: request.params.id,
            operationId: request.params.operationId
          })
        );
        if (!batch) throw new HttpError(404, "day plan apply operation is not available");
        return toStatusResponse(batch) satisfies DayPlanApplyStatusResponse;
      } catch (error) {
        if (error instanceof DayPlanValidationError) {
          return reply.code(400).send({ error: error.message, code: error.code });
        }
        return handleRouteError(error, reply);
      }
    }
  );

  const RETRY_BODY_KEYS: ReadonlySet<string> = new Set(["itemIds"]);

  async function rejectUnknownRetryFields(request: FastifyRequest, reply: FastifyReply) {
    const body = request.body;
    if (!isObject(body)) {
      return reply.code(400).send({ error: "request must be an object", code: "day_plan_invalid" });
    }
    const unknown = firstUnknown(body, RETRY_BODY_KEYS, "");
    if (unknown) {
      return reply.code(400).send({ error: `unknown field: ${unknown}`, code: "day_plan_invalid" });
    }
    if (
      !Array.isArray(body.itemIds) ||
      body.itemIds.length === 0 ||
      body.itemIds.some((id) => typeof id !== "string" || !isUuid(id))
    ) {
      return reply
        .code(400)
        .send({ error: "itemIds must be a non-empty list of ids", code: "day_plan_invalid" });
    }
    if (new Set(body.itemIds).size !== body.itemIds.length) {
      return reply
        .code(400)
        .send({ error: "itemIds must not repeat an id", code: "day_plan_invalid" });
    }
  }

  server.post<{ Params: { id: string; operationId: string }; Body: RetryDayPlanApplyRequest }>(
    "/api/calendar/day-plans/:id/operations/:operationId/retry",
    {
      schema: retryDayPlanApplyRouteSchema,
      onRequest: authenticateApplyAccess,
      preValidation: rejectUnknownRetryFields
    },
    async (request, reply) => {
      try {
        const accessContext = requireApplyAccess(request);
        const execute = requireApplyExecution();
        const body = request.body;
        // One short read-only validation transaction: the whole selection is
        // accepted or rejected before any facts or provider work, and nothing
        // is written here.
        const batch = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
          dependencies.dayPlanRepository.getApplyBatchById(scopedDb, {
            planId: request.params.id,
            operationId: request.params.operationId
          })
        );
        if (!batch) throw new HttpError(404, "day plan apply operation is not available");
        const byId = new Map(batch.items.map((item) => [item.id, item]));
        for (const itemId of body.itemIds) {
          const item = byId.get(itemId);
          if (!item || (item.outcome !== "failed" && item.outcome !== "unknown")) {
            throw new HttpError(409, "day plan apply retry selection is not eligible");
          }
        }
        // Retrying a move or removal re-checks the change gate: a confirmed
        // approval for the unchanged operation is reused with no per-item
        // prompt, and applied items are never re-executed.
        const retryNeedsGate = body.itemIds.some((itemId) => byId.get(itemId)!.kind !== "add");
        const report = await execute({
          access: accessContext,
          toolCtx: toolContextOf(accessContext),
          planId: batch.planId,
          idempotencyKey: batch.idempotencyKey,
          operationId: batch.id,
          itemIds: [...body.itemIds],
          ...(retryNeedsGate
            ? {
                changeAuth: await resolveChangeAuth({
                  access: accessContext,
                  dataContext: dependencies.dataContext,
                  changeApproval: dependencies.changeApproval,
                  operationId: batch.id
                })
              }
            : {})
        });
        return report satisfies ApplyExecutionReport;
      } catch (error) {
        if (error instanceof DayPlanValidationError) {
          return reply.code(400).send({ error: error.message, code: error.code });
        }
        return handleRouteError(error, reply);
      }
    }
  );

  const RECOVER_BODY_KEYS: ReadonlySet<string> = new Set([]);

  // Recover takes no selection: the body must be absent or an empty object.
  async function rejectUnknownRecoverFields(request: FastifyRequest, reply: FastifyReply) {
    const body = request.body;
    if (body === undefined) {
      request.body = {};
      return;
    }
    if (!isObject(body)) {
      return reply.code(400).send({ error: "request must be an object", code: "day_plan_invalid" });
    }
    const unknown = firstUnknown(body, RECOVER_BODY_KEYS, "");
    if (unknown) {
      return reply.code(400).send({ error: `unknown field: ${unknown}`, code: "day_plan_invalid" });
    }
  }

  server.post<{ Params: { id: string; operationId: string }; Body: RecoverDayPlanApplyRequest }>(
    "/api/calendar/day-plans/:id/operations/:operationId/recover",
    {
      schema: recoverDayPlanApplyRouteSchema,
      onRequest: authenticateApplyAccess,
      preValidation: rejectUnknownRecoverFields
    },
    async (request, reply) => {
      try {
        const accessContext = requireApplyAccess(request);
        // Fail closed before any item read or write when execution is down.
        const execute = requireApplyExecution();
        const batch = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
          dependencies.dayPlanRepository.getApplyBatchById(scopedDb, {
            planId: request.params.id,
            operationId: request.params.operationId
          })
        );
        if (!batch) throw new HttpError(404, "day plan apply operation is not available");
        // No selection: the service resumes pending and unknown items of any
        // kind. A confirmed approval for the unchanged operation is reused
        // with no per-item prompt; applied items are never re-executed.
        const recoverNeedsGate = batch.items.some(
          (item) =>
            item.kind !== "add" && (item.outcome === "pending" || item.outcome === "unknown")
        );
        const report = await execute({
          access: accessContext,
          toolCtx: toolContextOf(accessContext),
          planId: batch.planId,
          idempotencyKey: batch.idempotencyKey,
          operationId: batch.id,
          ...(recoverNeedsGate
            ? {
                changeAuth: await resolveChangeAuth({
                  access: accessContext,
                  dataContext: dependencies.dataContext,
                  changeApproval: dependencies.changeApproval,
                  operationId: batch.id
                })
              }
            : {})
        });
        return report satisfies ApplyExecutionReport;
      } catch (error) {
        if (error instanceof DayPlanValidationError) {
          return reply.code(400).send({ error: error.message, code: error.code });
        }
        return handleRouteError(error, reply);
      }
    }
  );

  // The confirm route lives in day-plan-change-routes.ts so this file stays
  // under its size limit. It shares the apply auth and execution helpers.
  registerDayPlanChangeConfirmRoute(
    server,
    {
      dataContext: dependencies.dataContext,
      dayPlanRepository: dependencies.dayPlanRepository,
      ...(dependencies.changeApproval ? { changeApproval: dependencies.changeApproval } : {}),
      ...(dependencies.applyExecution ? { applyExecution: dependencies.applyExecution } : {})
    },
    {
      authenticateApplyAccess,
      requireApplyAccess,
      requireApplyExecution,
      toolContextOf
    }
  );
}
