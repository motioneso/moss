import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PgBoss } from "pg-boss";
import type { UsefulnessFeedbackRepository } from "@moss/usefulness-feedback";

import { listAssistantToolsFromManifests } from "@moss/ai";
import type { AccessContext, BriefingDefinition, BriefingRun, DataContextRunner } from "@moss/db";
import {
  HttpError,
  handleRouteError as handleModuleRouteError,
  type MossModuleManifest
} from "@moss/module-sdk";
import {
  createBriefingDefinitionRouteSchema,
  getBriefingRunRouteSchema,
  listBriefingDefinitionsRouteSchema,
  listBriefingRunsRouteSchema,
  runBriefingDefinitionRouteSchema,
  updateBriefingDefinitionRouteSchema,
  localDay,
  readPlanContext,
  type BriefingCadence,
  type BriefingDefinitionDto,
  type BriefingPlanContextV1,
  type BriefingRunDto,
  type BriefingRunPlanStateDto,
  type BriefingStructuredPayloadV1,
  type BriefingType,
  type GetBriefingRunResponse,
  type RunBriefingDefinitionRequest,
  type UpdateBriefingDefinitionRequest
} from "@moss/shared";

import { sendJob } from "@moss/jobs";

import { isBriefingRunPayloadMetadataOnly, type BriefingRunPayload } from "./jobs.js";
import { BRIEFINGS_RUN_QUEUE } from "./manifest.js";
import { BriefingsRepository, type CreateBriefingDefinitionInput } from "./repository.js";
import {
  comparePlanState,
  resolveRunStatus,
  RUN_IN_FLIGHT_CODE,
  RUN_NOT_AVAILABLE_CODE,
  RUN_NOT_AVAILABLE_ERROR
} from "./run-status.js";
import { projectPlanContext, type DayPlanReadPort } from "./plan-context.js";
import { reconcileOwnedSchedules, reconcileSchedule, timezoneFor } from "./schedule.js";
import { deriveBriefingFeedbackItems } from "./feedback-targets.js";

export interface BriefingsRoutesDependencies {
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  readonly dataContext: DataContextRunner;
  readonly listModuleManifests: () => readonly MossModuleManifest[];
  readonly boss: PgBoss;
  readonly dayPlanRead?: DayPlanReadPort;
  readonly repository?: BriefingsRepository;
  readonly feedbackRepository?: Pick<
    UsefulnessFeedbackRepository,
    "upsertTarget" | "listActiveDismissedRefs"
  >;
}

interface DefinitionParams {
  readonly id: string;
}

interface BriefingRunParams {
  readonly id: string;
  readonly runId: string;
}

interface BriefingRunQuery {
  readonly jobId?: string;
}

const BRIEFING_CADENCES = new Set<BriefingCadence>(["manual", "daily", "weekly"]);
const BRIEFING_TYPES = new Set<BriefingType>(["morning", "evening", "weekly_review"]);

export function registerBriefingsRoutes(
  server: FastifyInstance,
  dependencies: BriefingsRoutesDependencies
): void {
  const repository = dependencies.repository ?? new BriefingsRepository();

  server.get(
    "/api/briefings/definitions",
    { schema: listBriefingDefinitionsRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const definitions = await dependencies.dataContext.withDataContext(
          accessContext,
          (scopedDb) => repository.listDefinitions(scopedDb)
        );

        // Best-effort self-heal: re-converge this owner's pg-boss schedules so a worker
        // that restarted with an empty pg-boss schedule table re-acquires the owner's
        // crons on next visit. Fire-and-forget AFTER building the response payload — it
        // must never block or fail the read, and reconciles ONLY the actor's own
        // definitions (RLS-scoped via the repository). reconcileOwnedSchedules already
        // swallows + logs per-definition errors; guard the whole call too.
        void dependencies.dataContext
          .withDataContext(accessContext, (scopedDb) =>
            reconcileOwnedSchedules(
              dependencies.boss,
              scopedDb,
              repository,
              accessContext.actorUserId,
              request.log
            )
          )
          .catch((error) => {
            const e = error instanceof Error ? error : new Error(String(error));
            request.log.error(
              {
                event: "briefing_self_heal_failed",
                error: e.name,
                message: e.message.slice(0, 200)
              },
              "briefing self-heal failed"
            );
          });

        return { definitions: definitions.map(serializeDefinition) };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.post(
    "/api/briefings/definitions",
    { schema: createBriefingDefinitionRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const input = parseCreateDefinitionBody(request.body, dependencies.listModuleManifests());
        const definition = await dependencies.dataContext.withDataContext(
          accessContext,
          (scopedDb) => repository.createDefinition(scopedDb, input)
        );

        // Reconcile OUTSIDE the data-context callback (pg-boss is not RLS-scoped).
        // Failure-isolated: a reconcile failure is logged and never fails the mutation.
        await reconcileScheduleSafely(dependencies.boss, definition, request.log);

        return reply.code(201).send({ definition: serializeDefinition(definition) });
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.patch<{ Params: DefinitionParams }>(
    "/api/briefings/definitions/:id",
    { schema: updateBriefingDefinitionRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const input = parseUpdateDefinitionBody(request.body, dependencies.listModuleManifests());
        const definition = await dependencies.dataContext.withDataContext(
          accessContext,
          (scopedDb) => repository.updateDefinition(scopedDb, request.params.id, input)
        );

        if (!definition) {
          return reply.code(404).send({ error: "Briefing definition not found" });
        }

        // Reconcile the schedule for the updated definition (cadence/tz/enabled may have
        // changed). Failure-isolated — never fails the mutation.
        await reconcileScheduleSafely(dependencies.boss, definition, request.log);

        return { definition: serializeDefinition(definition) };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.post<{ Params: DefinitionParams }>(
    "/api/briefings/definitions/:id/run",
    { schema: runBriefingDefinitionRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const body = parseRunDefinitionBody(request.body);
        const definition = await dependencies.dataContext.withDataContext(
          accessContext,
          (scopedDb) => repository.getOwnedDefinitionById(scopedDb, request.params.id)
        );

        if (!definition) {
          return reply.code(404).send({ error: "Briefing definition not found" });
        }

        const runId = randomUUID();
        const payload: BriefingRunPayload = {
          actorUserId: accessContext.actorUserId,
          definitionId: definition.id,
          briefingRunId: runId,
          runKind: "manual",
          briefingType: definition.briefing_type,
          idempotencyKey: body.idempotencyKey
        };

        // A client-supplied idempotency key must actually dedupe the job, not just
        // ride along in the payload (#150). The BRIEFINGS_RUN_QUEUE uses the
        // `exclusive` policy, so pg-boss keeps at most one job per (queue,
        // singletonKey) across all non-terminal states — a double-submit (retry,
        // double-click) collapses to a single run. Namespace by definition id so one
        // definition's key can never suppress another's. A run WITHOUT an idempotency
        // key gets a unique per-run singletonKey (the runId) so it never falsely
        // collides — only an explicit, repeated key dedupes.
        const singletonKey = body.idempotencyKey
          ? `${definition.id}:key:${body.idempotencyKey}`
          : `${definition.id}:run:${runId}`;
        const jobId = await sendJob(dependencies.boss, BRIEFINGS_RUN_QUEUE, payload, {
          singletonKey
        });

        if (!jobId) {
          // With an idempotency key, a null jobId means the singletonKey collided —
          // the prior submit is still queued or running, so this is the dedupe path
          // (#150), surfaced as 409. We do NOT return the fresh runId: the caller's
          // run is the one already in flight, not this one. A keyless run uses a
          // unique singletonKey and so can only get null on a genuine enqueue
          // failure → 500.
          if (body.idempotencyKey) {
            return reply.code(409).send({
              error: "A briefing run with this idempotency key is already queued or running",
              code: RUN_IN_FLIGHT_CODE
            });
          }
          throw new HttpError(500, "Briefing run could not be queued");
        }

        return reply.code(202).send({ jobId, runId });
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.get<{ Params: DefinitionParams }>(
    "/api/briefings/definitions/:id/runs",
    { schema: listBriefingRunsRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const result = await dependencies.dataContext.withDataContext(
          accessContext,
          async (scopedDb) => {
            const definition = await repository.getDefinitionById(scopedDb, request.params.id);
            if (!definition) return undefined;
            const dismissedRuns =
              (await dependencies.feedbackRepository?.listActiveDismissedRefs(
                scopedDb,
                accessContext.actorUserId,
                "briefing_run",
                "briefing"
              )) ?? new Set<string>();
            const dismissedItems =
              (await dependencies.feedbackRepository?.listActiveDismissedRefs(
                scopedDb,
                accessContext.actorUserId,
                "briefing_item",
                "briefing"
              )) ?? new Set<string>();
            const runs = await repository.listRuns(scopedDb, definition.id);
            const visibleRuns = runs.filter((run) => !dismissedRuns.has(run.id));
            const serializedRuns = visibleRuns.map((run) => serializeRun(run, { dismissedItems }));
            if (dependencies.feedbackRepository) {
              for (const run of visibleRuns) {
                await dependencies.feedbackRepository.upsertTarget(scopedDb, {
                  ownerUserId: accessContext.actorUserId,
                  targetKind: "briefing_run",
                  targetRef: run.id,
                  surface: "briefing",
                  sourceKind: "briefing",
                  sourceLabel: "Briefing",
                  metadata: { briefingType: run.briefing_type }
                });
              }
              for (const item of serializedRuns.flatMap((run) => run.feedbackItems)) {
                await dependencies.feedbackRepository.upsertTarget(scopedDb, {
                  ownerUserId: accessContext.actorUserId,
                  targetKind: "briefing_item",
                  targetRef: item.feedbackItemId,
                  surface: "briefing",
                  sourceKind: item.sourceKind,
                  sourceLabel: item.sourceLabel,
                  priorityBand: item.priorityBand,
                  metadata: item.metadata
                });
              }
            }

            return { definition, runs: serializedRuns };
          }
        );

        if (!result) {
          return reply.code(404).send({ error: "Briefing definition not found" });
        }

        return { runs: result.runs };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.get<{ Params: BriefingRunParams; Querystring: BriefingRunQuery }>(
    "/api/briefings/definitions/:id/runs/:runId",
    { schema: getBriefingRunRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const jobId = request.query.jobId;
        const snapshot = await dependencies.dataContext.withDataContext(
          accessContext,
          async (scopedDb) => {
            const definition = await repository.getDefinitionById(scopedDb, request.params.id);
            if (!definition) return undefined;
            const run = await repository.getOwnedRunById(scopedDb, request.params.runId);
            const runs = await repository.listRuns(scopedDb, definition.id);
            const dismissedItems =
              (await dependencies.feedbackRepository?.listActiveDismissedRefs(
                scopedDb,
                accessContext.actorUserId,
                "briefing_item",
                "briefing"
              )) ?? new Set<string>();
            return { definition, run, firstRunId: runs[0]?.id, dismissedItems };
          }
        );

        if (!snapshot) {
          return reply
            .code(404)
            .send({ error: RUN_NOT_AVAILABLE_ERROR, code: RUN_NOT_AVAILABLE_CODE });
        }

        // pg-boss is not RLS-scoped, so the job lookup runs outside the data context.
        // It counts only for the caller's own metadata-only job for this run.
        let job: { state: string; data: Record<string, unknown> | null } | null = null;
        if (!snapshot.run && jobId) {
          const stored = await dependencies.boss.getJobById<BriefingRunPayload>(
            BRIEFINGS_RUN_QUEUE,
            jobId
          );
          if (stored && isBriefingRunPayloadMetadataOnly(stored.data)) {
            job = {
              state: stored.state,
              data: stored.data as unknown as Record<string, unknown>
            };
          }
        }

        const status = resolveRunStatus({
          run: snapshot.run,
          runDefinitionId: snapshot.run?.definition_id,
          definitionId: snapshot.definition.id,
          firstRunId: snapshot.firstRunId,
          job,
          actorUserId: accessContext.actorUserId,
          runId: request.params.runId
        });

        if ("notFound" in status) {
          return reply
            .code(404)
            .send({ error: RUN_NOT_AVAILABLE_ERROR, code: RUN_NOT_AVAILABLE_CODE });
        }
        if (status.state !== "ready") {
          const pending: GetBriefingRunResponse = {
            state: status.state,
            run: null,
            latest: false,
            plan: null
          };
          return pending;
        }

        // Ready implies a same-definition row; narrow for the serializer below.
        const readyRun = snapshot.run;
        if (!readyRun || readyRun.definition_id !== snapshot.definition.id) {
          return reply
            .code(404)
            .send({ error: RUN_NOT_AVAILABLE_ERROR, code: RUN_NOT_AVAILABLE_CODE });
        }
        const serialized = serializeRun(readyRun, {
          dismissedItems: snapshot.dismissedItems
        });
        const stored = readPlanContext(serialized.structuredPayload);
        const plan = await readRunPlanState(
          dependencies,
          request,
          accessContext,
          snapshot.definition.schedule_metadata,
          readyRun.created_at,
          stored
        );
        const response: GetBriefingRunResponse = {
          state: "ready",
          run: serialized,
          latest: status.latest,
          plan
        };
        return response;
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );
}

async function readRunPlanState(
  dependencies: BriefingsRoutesDependencies,
  request: FastifyRequest,
  accessContext: AccessContext,
  scheduleMetadata: Record<string, unknown>,
  runCreatedAt: Date | string,
  stored: BriefingPlanContextV1 | null
): Promise<BriefingRunPlanStateDto> {
  const port = dependencies.dayPlanRead;
  if (!port) {
    return {
      ...comparePlanState({ stored, currentAvailable: false, current: null }),
      current: null
    };
  }
  const timeZone = stored?.timeZone ?? timezoneFor(scheduleMetadata);
  const day = stored?.localDay ?? localDay(runCreatedAt, timeZone);
  try {
    const plan = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
      port.getForDay(scopedDb, { localDay: day, timeZone })
    );
    const current = plan ? projectPlanContext(plan) : null;
    return {
      ...comparePlanState({ stored, currentAvailable: true, current }),
      current
    };
  } catch (error) {
    const e = error instanceof Error ? error : new Error(String(error));
    request.log.error(
      {
        event: "briefing_tool_failed",
        tool: "day_plan.read",
        error: e.name,
        message: e.message.slice(0, 200)
      },
      "briefing day plan read failed"
    );
    return {
      ...comparePlanState({ stored, currentAvailable: false, current: null }),
      current: null
    };
  }
}

async function reconcileScheduleSafely(
  boss: PgBoss,
  definition: BriefingDefinition,
  logger: Pick<FastifyRequest, "log">["log"]
): Promise<void> {
  try {
    await reconcileSchedule(boss, definition);
  } catch (error) {
    const e = error instanceof Error ? error : new Error(String(error));
    logger.error(
      {
        event: "briefing_schedule_reconcile_failed",
        definitionId: definition.id,
        error: e.name,
        message: e.message.slice(0, 200)
      },
      "briefing schedule reconcile failed"
    );
  }
}

function validateScheduleMetadata(
  cadence: string | undefined,
  scheduleMetadata: Record<string, unknown> | undefined
): void {
  if (!scheduleMetadata) return;

  const tz = scheduleMetadata.timezone;
  if (tz !== undefined) {
    if (typeof tz !== "string" || tz.trim() === "") {
      throw new HttpError(400, "invalid timezone");
    }
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(0);
    } catch {
      throw new HttpError(400, "invalid timezone");
    }
  }

  if (cadence === "weekly" && scheduleMetadata.dayOfWeek == null) {
    throw new HttpError(400, "dayOfWeek required for weekly schedules");
  }
}

function parseCreateDefinitionBody(
  body: unknown,
  moduleManifests: readonly MossModuleManifest[]
): CreateBriefingDefinitionInput {
  const value = requireObject(body);
  const briefingType = optionalBriefingType(value.briefingType) ?? "morning";

  const rawToolNames =
    value.selectedToolNames !== undefined
      ? value.selectedToolNames
      : defaultToolNamesFor(briefingType);

  const selectedToolNames = requiredReadToolNames(
    rawToolNames,
    "selectedToolNames",
    moduleManifests
  );

  const cadence = optionalBriefingCadence(value.cadence) ?? "manual";
  const scheduleMetadata = optionalJsonObject(value.scheduleMetadata, "scheduleMetadata");
  validateScheduleMetadata(cadence, scheduleMetadata);

  return {
    title: requiredString(value.title, "title"),
    briefingType,
    cadence,
    scheduleMetadata,
    enabled: optionalBoolean(value.enabled, "enabled") ?? true,
    selectedToolNames
  };
}

function parseUpdateDefinitionBody(
  body: unknown,
  moduleManifests: readonly MossModuleManifest[]
): UpdateBriefingDefinitionRequest {
  const value = requireObject(body);
  const selectedToolNames =
    value.selectedToolNames === undefined
      ? undefined
      : requiredReadToolNames(value.selectedToolNames, "selectedToolNames", moduleManifests);

  const cadence = optionalBriefingCadence(value.cadence);
  const scheduleMetadata = optionalJsonObject(value.scheduleMetadata, "scheduleMetadata");
  validateScheduleMetadata(cadence, scheduleMetadata);

  return {
    title: optionalString(value.title, "title"),
    briefingType: optionalBriefingType(value.briefingType),
    cadence,
    scheduleMetadata,
    enabled: optionalBoolean(value.enabled, "enabled"),
    selectedToolNames
  };
}

function parseRunDefinitionBody(body: unknown): RunBriefingDefinitionRequest {
  if (body === undefined) {
    return {};
  }

  const value = requireObject(body);

  return {
    idempotencyKey: optionalString(value.idempotencyKey, "idempotencyKey")
  };
}

function requiredReadToolNames(
  value: unknown,
  fieldName: string,
  moduleManifests: readonly MossModuleManifest[]
): string[] {
  // An explicit empty list selects no tools. Anything that is not an array
  // (false, null, a lone value that fails membership below) is still 400.
  if (!Array.isArray(value)) {
    throw new HttpError(400, `${fieldName} must be an array`);
  }

  const toolsByName = new Map(
    listAssistantToolsFromManifests(moduleManifests).map((tool) => [tool.name, tool])
  );
  const selectedToolNames = [
    ...new Set(value.map((item, index) => requiredArrayString(item, fieldName, index)))
  ];

  const VIRTUAL_SOURCES = new Set(["vault", "chats"]);
  if (
    selectedToolNames.some(
      (name) => !VIRTUAL_SOURCES.has(name) && toolsByName.get(name)?.risk !== "read"
    )
  ) {
    throw new HttpError(400, "Briefings can only select declared read-risk assistant tools");
  }

  return selectedToolNames;
}

function requireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "Expected JSON object body");
  }

  return value as Record<string, unknown>;
}

function requiredString(value: unknown, fieldName: string): string {
  const parsed = optionalString(value, fieldName);

  if (!parsed) {
    throw new HttpError(400, `${fieldName} is required`);
  }

  return parsed;
}

function requiredArrayString(value: unknown, fieldName: string, index: number): string {
  if (typeof value !== "string") {
    throw new HttpError(400, `${fieldName}[${index}] must be a string`);
  }

  const trimmed = value.trim();

  if (!trimmed) {
    throw new HttpError(400, `${fieldName}[${index}] must not be empty`);
  }

  return trimmed;
}

function optionalString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new HttpError(400, `${fieldName} must be a string`);
  }

  const trimmed = value.trim();

  if (!trimmed) {
    throw new HttpError(400, `${fieldName} must not be empty`);
  }

  return trimmed;
}

function optionalJsonObject(
  value: unknown,
  fieldName: string
): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, `${fieldName} must be a JSON object`);
  }

  return value as Record<string, unknown>;
}

function optionalBoolean(value: unknown, fieldName: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new HttpError(400, `${fieldName} must be a boolean`);
  }

  return value;
}

function optionalBriefingCadence(value: unknown): BriefingCadence | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "string" && BRIEFING_CADENCES.has(value as BriefingCadence)) {
    return value as BriefingCadence;
  }

  throw new HttpError(400, "cadence must be manual, daily, or weekly");
}

function optionalBriefingType(value: unknown): BriefingType | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "string" && BRIEFING_TYPES.has(value as BriefingType)) {
    return value as BriefingType;
  }

  throw new HttpError(400, "briefingType must be morning, evening, or weekly_review");
}

export function defaultToolNamesFor(type: BriefingType): string[] {
  switch (type) {
    case "morning":
      return [
        "tasks.list",
        "calendar.listVisibleEvents",
        "email.listVisibleMessages",
        "vault",
        "goals.list",
        "news.topHeadlinesToday",
        "sports.followedFactsToday"
      ];
    case "evening":
      return [
        "tasks.list",
        "calendar.listVisibleEvents",
        "email.listVisibleMessages",
        "chat.listTodaysTurns",
        "goals.list",
        "sports.followedFactsToday"
      ];
    case "weekly_review":
      return [
        "tasks.list",
        "calendar.listVisibleEvents",
        "email.listVisibleMessages",
        "vault",
        "goals.list"
      ];
  }
}

function serializeDefinition(definition: BriefingDefinition): BriefingDefinitionDto {
  return {
    id: definition.id,
    ownerUserId: definition.owner_user_id,
    title: definition.title,
    briefingType: definition.briefing_type,
    cadence: definition.cadence,
    scheduleMetadata: definition.schedule_metadata,
    enabled: definition.enabled,
    selectedToolNames: definition.selected_tool_names,
    lastRunAt: toNullableIsoString(definition.last_run_at),
    createdAt: toIsoString(definition.created_at),
    updatedAt: toIsoString(definition.updated_at)
  };
}

function serializeRun(
  run: BriefingRun,
  options: { readonly dismissedItems?: ReadonlySet<string> } = {}
): BriefingRunDto {
  const { structuredPayload: storedPayload, ...sourceMetadata } = run.source_metadata;
  const structuredPayload =
    storedPayload && typeof storedPayload === "object"
      ? (storedPayload as BriefingStructuredPayloadV1)
      : { version: 1 as const, actionRows: [], catchUp: null };
  const feedbackItems = deriveBriefingFeedbackItems(run.source_metadata).filter(
    (item) => !options.dismissedItems?.has(item.feedbackItemId)
  );
  return {
    id: run.id,
    definitionId: run.definition_id,
    ownerUserId: run.owner_user_id,
    status: run.status,
    runKind: run.run_kind,
    briefingType: run.briefing_type,
    summaryText: run.summary_text,
    sourceMetadata,
    feedbackItems,
    structuredPayload,
    createdAt: toIsoString(run.created_at)
  };
}

function toNullableIsoString(value: Date | string | null): string | null {
  if (!value) {
    return null;
  }

  return toIsoString(value);
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function handleRouteError(error: unknown, reply: FastifyReply) {
  return handleModuleRouteError(error, reply, {
    invalidRequestMessage: "Briefings request is invalid"
  });
}
