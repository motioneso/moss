import { readPersonLocale } from "../person-locale.js";
import type { PgBoss } from "pg-boss";
import { HttpError } from "@moss/module-sdk";
import { pauseReminderById, resumeReminderById, deleteReminderById } from "./controls.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AccessContext, DataContextRunner, PreferencesPort } from "@moss/db";
import { ACT_AS_GRANT_HEADER } from "@moss/module-sdk/server";
import {
  listScheduledTasksRouteSchema,
  scheduledTaskControlRouteSchema,
  listQuietHoursAllowancesRouteSchema
} from "@moss/shared";
import { handleRouteError } from "../route-errors.js";
import { listScheduledReminders } from "./settings.js";
import { listQuietHoursAllowances } from "./quiet-hours-allowances.js";

export function registerScheduledTaskRoutes(
  server: FastifyInstance,
  dependencies: {
    readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
    readonly dataContext: DataContextRunner;
    readonly localePreferences?: PreferencesPort;
    readonly boss?: Pick<PgBoss, "send">;
  }
): void {
  server.get(
    "/api/chat/quiet-hours-allowances",
    { schema: listQuietHoursAllowancesRouteSchema },
    async (request, reply) => {
      try {
        const access = await dependencies.resolveAccessContext(request);
        return await dependencies.dataContext.withDataContext(access, listQuietHoursAllowances);
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );
  server.get(
    "/api/chat/scheduled-tasks",
    { schema: listScheduledTasksRouteSchema },
    async (request, reply) => {
      try {
        const access = await dependencies.resolveAccessContext(request);
        const tasks = await dependencies.dataContext.withDataContext(access, async (db) =>
          listScheduledReminders(
            db,
            (await readPersonLocale(db, dependencies.localePreferences)).dateFormat
          )
        );
        // App reads may run from any chat; saved chat content is screen-only.
        if (request.headers[ACT_AS_GRANT_HEADER] !== undefined) {
          return {
            tasks: tasks.map((task) => ({
              ...task,
              runs: task.runs.map((run) => ({ ...run, message: null }))
            }))
          };
        }
        return { tasks };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );
  for (const action of ["pause", "resume", "delete"] as const) {
    server.route<{ Params: { id: string } }>({
      method: action === "delete" ? "DELETE" : "POST",
      url: `/api/chat/scheduled-tasks/:id${action === "delete" ? "" : `/${action}`}`,
      schema: scheduledTaskControlRouteSchema,
      handler: async (request, reply) => {
        try {
          const access = await dependencies.resolveAccessContext(request);
          if (request.body !== undefined && request.body !== null)
            throw new HttpError(400, "Reminder controls do not accept a request body.");
          if (request.headers[ACT_AS_GRANT_HEADER] !== undefined)
            throw new HttpError(403, "Use Settings or type the reminder command in Main chat.");
          const result = await dependencies.dataContext.withDataContext(access, async (db) => {
            if (action === "pause") return pauseReminderById(db, request.params.id);
            if (action === "delete") return deleteReminderById(db, request.params.id);
            if (!dependencies.boss)
              throw new HttpError(503, "Reminder delivery is unavailable. Try again.");
            return resumeReminderById(db, dependencies.boss, access.actorUserId, request.params.id);
          });
          if (result.kind === "missing")
            throw new HttpError(404, "That reminder is no longer available.");
          if (result.kind === "not_pending" || result.kind === "stale")
            throw new HttpError(409, "That reminder is no longer waiting. Refresh its details.");
          return { ok: true };
        } catch (error) {
          return handleRouteError(error, reply);
        }
      }
    });
  }
}
