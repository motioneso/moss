import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AccessContext, DataContextRunner } from "@moss/db";
import { ACT_AS_GRANT_HEADER } from "@moss/module-sdk/server";
import { listScheduledTasksRouteSchema } from "@moss/shared";
import { handleRouteError } from "../route-errors.js";
import { listScheduledReminders } from "./settings.js";

export function registerScheduledTaskRoutes(
  server: FastifyInstance,
  dependencies: {
    readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
    readonly dataContext: DataContextRunner;
  }
): void {
  server.get(
    "/api/chat/scheduled-tasks",
    { schema: listScheduledTasksRouteSchema },
    async (request, reply) => {
      try {
        const access = await dependencies.resolveAccessContext(request);
        const tasks = await dependencies.dataContext.withDataContext(
          access,
          listScheduledReminders
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
}
