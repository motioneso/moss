import type { FastifyInstance, FastifyRequest } from "fastify";

import { handleRouteError } from "@moss/module-sdk";
import type { AccessContext, DataContextRunner, PreferencesPort } from "@moss/db";
import {
  getCalendarBriefingSettingsRouteSchema,
  getCalendarEventRouteSchema,
  listCalendarEventsRouteSchema,
  parseCalendarAutomationMode,
  type UpdateCalendarBriefingSettingsRequest,
  updateCalendarBriefingSettingsRouteSchema
} from "@moss/shared";
import { PreferencesRepository } from "@moss/structured-state";

import { CalendarRepository } from "./repository.js";
import { serializeCalendarEvent } from "./serialize.js";
import { registerDayPlanRoutes, type DayPlanRoutesDependencies } from "./day-plan-routes.js";

const CALENDAR_BRIEFING_LOOKAHEAD_KEY = "calendar.briefing_lookahead_days";
const CALENDAR_SIGNAL_SUGGEST_TASKS_KEY = "calendar.signal_suggest_tasks";
const CALENDAR_SIGNAL_CREATE_TASKS_KEY = "calendar.signal_create_tasks";
const CALENDAR_SIGNAL_SUGGEST_TIME_BLOCKS_KEY = "calendar.signal_suggest_time_blocks";
const CALENDAR_SIGNAL_BLOCK_TIME_KEY = "calendar.signal_block_time";
const CALENDAR_PREP_TASK_MODE_KEY = "calendar.prep_task_mode";
const CALENDAR_TIME_BLOCK_MODE_KEY = "calendar.time_block_mode";
const CALENDAR_WRITEBACK_MODULE_ID = "calendar";
const CALENDAR_WRITEBACK_FAMILY_ID = "calendar_writeback";

export interface CalendarRoutesDependencies extends DayPlanRoutesDependencies {
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  readonly dataContext: DataContextRunner;
  readonly repository?: CalendarRepository;
  readonly preferencesRepository?: PreferencesPort;
  readonly calendarWritebackPolicy?: {
    set(
      scopedDb: Parameters<PreferencesPort["get"]>[0],
      moduleId: string,
      actionFamilyId: string,
      tier: "ask_each_time" | "trusted_auto"
    ): Promise<void>;
  };
}

interface CalendarEventParams {
  readonly id: string;
}

export function registerCalendarRoutes(
  server: FastifyInstance,
  dependencies: CalendarRoutesDependencies
): void {
  const repository = dependencies.repository ?? new CalendarRepository();
  const preferencesRepository = dependencies.preferencesRepository ?? new PreferencesRepository();

  registerDayPlanRoutes(server, dependencies);

  server.get(
    "/api/calendar/events",
    { schema: listCalendarEventsRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const events = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
          repository.listVisible(scopedDb)
        );

        return { events: events.map(serializeCalendarEvent) };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.get<{ Params: CalendarEventParams }>(
    "/api/calendar/events/:id",
    { schema: getCalendarEventRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const event = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
          repository.getById(scopedDb, request.params.id)
        );

        if (!event) {
          return reply.code(404).send({ error: "Calendar event not found" });
        }

        return { event: serializeCalendarEvent(event) };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.get(
    "/api/calendar/briefing-settings",
    { schema: getCalendarBriefingSettingsRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const settings = await dependencies.dataContext.withDataContext(
          accessContext,
          async (scopedDb) => readCalendarBriefingSettings(scopedDb, preferencesRepository)
        );
        return { settings };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.patch(
    "/api/calendar/briefing-settings",
    { schema: updateCalendarBriefingSettingsRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const body = request.body as UpdateCalendarBriefingSettingsRequest;
        const settings = await dependencies.dataContext.withDataContext(
          accessContext,
          async (scopedDb) => {
            if (body.lookaheadDays !== undefined) {
              await preferencesRepository.upsert(
                scopedDb,
                CALENDAR_BRIEFING_LOOKAHEAD_KEY,
                body.lookaheadDays
              );
            }
            if (body.suggestTasks !== undefined) {
              await preferencesRepository.upsert(
                scopedDb,
                CALENDAR_SIGNAL_SUGGEST_TASKS_KEY,
                body.suggestTasks
              );
            }
            if (body.createTasks !== undefined) {
              await preferencesRepository.upsert(
                scopedDb,
                CALENDAR_SIGNAL_CREATE_TASKS_KEY,
                body.createTasks
              );
            }
            if (body.suggestTimeBlocks !== undefined) {
              await preferencesRepository.upsert(
                scopedDb,
                CALENDAR_SIGNAL_SUGGEST_TIME_BLOCKS_KEY,
                body.suggestTimeBlocks
              );
            }
            if (body.blockTime !== undefined) {
              await preferencesRepository.upsert(
                scopedDb,
                CALENDAR_SIGNAL_BLOCK_TIME_KEY,
                body.blockTime
              );
            }
            if (body.prepTaskMode !== undefined) {
              await preferencesRepository.upsert(
                scopedDb,
                CALENDAR_PREP_TASK_MODE_KEY,
                body.prepTaskMode
              );
            }
            if (body.timeBlockMode !== undefined) {
              await preferencesRepository.upsert(
                scopedDb,
                CALENDAR_TIME_BLOCK_MODE_KEY,
                body.timeBlockMode
              );
              await dependencies.calendarWritebackPolicy?.set(
                scopedDb,
                CALENDAR_WRITEBACK_MODULE_ID,
                CALENDAR_WRITEBACK_FAMILY_ID,
                body.timeBlockMode === "auto" ? "trusted_auto" : "ask_each_time"
              );
            }
            return readCalendarBriefingSettings(scopedDb, preferencesRepository);
          }
        );
        return { settings };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );
}

async function readCalendarBriefingSettings(
  scopedDb: Parameters<PreferencesPort["get"]>[0],
  preferencesRepository: PreferencesPort
) {
  const [
    lookaheadDays,
    suggestTasks,
    createTasks,
    suggestTimeBlocks,
    blockTime,
    storedPrepTaskMode,
    storedTimeBlockMode
  ] = await Promise.all([
    preferencesRepository.get(scopedDb, CALENDAR_BRIEFING_LOOKAHEAD_KEY),
    preferencesRepository.get(scopedDb, CALENDAR_SIGNAL_SUGGEST_TASKS_KEY),
    preferencesRepository.get(scopedDb, CALENDAR_SIGNAL_CREATE_TASKS_KEY),
    preferencesRepository.get(scopedDb, CALENDAR_SIGNAL_SUGGEST_TIME_BLOCKS_KEY),
    preferencesRepository.get(scopedDb, CALENDAR_SIGNAL_BLOCK_TIME_KEY),
    preferencesRepository.get(scopedDb, CALENDAR_PREP_TASK_MODE_KEY),
    preferencesRepository.get(scopedDb, CALENDAR_TIME_BLOCK_MODE_KEY)
  ]);
  const legacyPrepTaskMode =
    createTasks === true ? "auto" : suggestTasks === false ? "off" : "suggest";
  const legacyTimeBlockMode =
    blockTime === true ? "auto" : suggestTimeBlocks === false ? "off" : "suggest";
  const prepTaskMode = parseCalendarAutomationMode(storedPrepTaskMode, legacyPrepTaskMode);
  const timeBlockMode = parseCalendarAutomationMode(storedTimeBlockMode, legacyTimeBlockMode);

  return {
    lookaheadDays:
      lookaheadDays === 0 || lookaheadDays === 1 || lookaheadDays === 2 ? lookaheadDays : 2,
    prepTaskMode,
    timeBlockMode,
    suggestTasks: prepTaskMode !== "off",
    createTasks: prepTaskMode === "auto",
    suggestTimeBlocks: timeBlockMode !== "off",
    blockTime: timeBlockMode === "auto"
  } as const;
}
