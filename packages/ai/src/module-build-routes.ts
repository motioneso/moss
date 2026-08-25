import type { FastifyInstance } from "fastify";
import { handleRouteError, HttpError } from "@moss/module-sdk";
import { approveModuleBuildResponseSchema } from "@moss/shared";

import type { AiRoutesDependencies } from "./routes.js";

interface ApproveRequest {
  readonly Params: { readonly buildId: string };
}

/**
 * #1888 — the "Build it" button on the plan card in chat.
 *
 * The route only carries the build id; who may approve is decided server-side by
 * `approveModuleBuildPlan`, which treats a build owned by someone else exactly like a build that
 * does not exist. The approve function itself is injected by the composition root, because
 * starting the build needs the job queue and packages/ai does not own one.
 */
export function registerModuleBuildRoutes(
  server: FastifyInstance,
  dependencies: AiRoutesDependencies
): void {
  server.post<ApproveRequest>(
    "/api/ai/module-builds/:buildId/approve",
    { schema: { response: { 200: approveModuleBuildResponseSchema } } },
    async (request, reply) => {
      try {
        const approve = dependencies.approveModuleBuild;
        if (!approve) {
          throw new HttpError(503, "Building a module is not available on this instance.");
        }
        const accessContext = await dependencies.resolveAccessContext(request);
        const { buildId } = request.params;
        await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
          approve(scopedDb, buildId, accessContext.actorUserId)
        );
        return { buildId, status: "building" };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );
}
