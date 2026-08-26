import type { FastifyInstance } from "fastify";
import { handleRouteError, HttpError } from "@moss/module-sdk";
import {
  approveModuleBuildResponseSchema,
  listMyModuleBuildsResponseSchema,
  type ListMyModuleBuildsResponse,
  type ModuleBuildPlan
} from "@moss/shared";
import { cancelModuleBuild, listModuleBuildsForUser } from "@moss/settings";

import type { AiRoutesDependencies } from "./routes.js";

interface ApproveRequest {
  readonly Params: { readonly buildId: string };
}

interface CancelRequest {
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
  server.get(
    "/api/ai/module-builds/mine",
    { schema: { response: { 200: listMyModuleBuildsResponseSchema } } },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const builds = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
          listModuleBuildsForUser(scopedDb, accessContext.actorUserId)
        );
        const response: ListMyModuleBuildsResponse = {
          builds: builds.map((build) => ({
            id: build.id,
            status: build.status,
            step: build.step,
            plan: build.plan as ModuleBuildPlan | null,
            fetchedUrls: build.fetchedUrls,
            writtenFiles: build.writtenFiles,
            costCents: build.costCents,
            error: build.error,
            createdAt: build.createdAt.toISOString(),
            updatedAt: build.updatedAt.toISOString()
          }))
        };
        return response;
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

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

  server.post<CancelRequest>("/api/ai/module-builds/:buildId/cancel", async (request, reply) => {
    try {
      const accessContext = await dependencies.resolveAccessContext(request);
      const { buildId } = request.params;
      const cancelled = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
        cancelModuleBuild(scopedDb, buildId, accessContext.actorUserId)
      );
      if (!cancelled) throw new HttpError(404, "Module build not found");
      return { buildId, status: "cancelled" };
    } catch (error) {
      return handleRouteError(error, reply);
    }
  });
}
