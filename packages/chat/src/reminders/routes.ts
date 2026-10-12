import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AccessContext, DataContextRunner } from "@moss/db";
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
        return { tasks };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );
}
