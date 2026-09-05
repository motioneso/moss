import type { AccessContext, DataContextDb, DataContextRunner } from "@moss/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  createWorkshopProjectInputSchema,
  createWorkshopProjectResponseSchema,
  listWorkshopProjectsQuerySchema,
  listWorkshopProjectsResponseSchema,
  workshopProjectParamsSchema,
  getWorkshopProjectResponseSchema,
  listWorkshopMessagesQuerySchema,
  listWorkshopMessagesResponseSchema,
  createWorkshopMessageInputSchema,
  createWorkshopMessageResponseSchema,
  workshopErrorResponseSchema,
  type CreateWorkshopProjectInput,
  type WorkshopFeedInput
} from "@moss/shared";
import {
  WorkshopInputError,
  WorkshopProjectConflictError,
  WorkshopProjectsRepository
} from "./projects-repository.js";
import { WorkshopMessageConflictError, WorkshopProjectFeed } from "./project-feed.js";
import {
  createWorkshopProject,
  requireWorkshopAdmin,
  WorkshopAdminRequiredError
} from "./project-service.js";

export interface WorkshopProjectRouteDependencies {
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  readonly dataContext: DataContextRunner;
}

const errors = Object.fromEntries(
  [400, 401, 403, 404, 409, 500].map((code) => [code, workshopErrorResponseSchema])
);

export function registerWorkshopProjectRoutes(
  server: FastifyInstance,
  deps: WorkshopProjectRouteDependencies
): void {
  // Encapsulation keeps these curated errors local to Workshop, including schema failures.
  void server.register(async (app) => {
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof WorkshopAdminRequiredError)
        return reply.code(403).send({ error: error.message });
      if (
        error instanceof WorkshopInputError ||
        (error as { validation?: unknown }).validation ||
        [400, 413, 415].includes((error as { statusCode?: number }).statusCode ?? 0)
      )
        return reply
          .code(400)
          .send({ error: "Check the project fields and page cursor, then try again." });
      if (
        error instanceof WorkshopProjectConflictError ||
        error instanceof WorkshopMessageConflictError
      )
        return reply.code(409).send({
          error:
            "This request was already saved with different content. Start a new request to save your changes."
        });
      if ((error as { statusCode?: number }).statusCode === 401)
        return reply.code(401).send({ error: "Sign in to open Workshop." });
      return reply
        .code(500)
        .send({ error: "Workshop could not complete this request. Try again." });
    });
    const projects = new WorkshopProjectsRepository();
    const feed = new WorkshopProjectFeed();
    const withAdmin = async <T>(
      request: FastifyRequest,
      work: (db: DataContextDb) => Promise<T>
    ): Promise<T> => {
      const access = await deps.resolveAccessContext(request);
      return deps.dataContext.withDataContext(access, async (db) => {
        await requireWorkshopAdmin(db);
        return work(db);
      });
    };
    app.post<{ Body: CreateWorkshopProjectInput }>(
      "/api/workshop/projects",
      {
        schema: {
          body: createWorkshopProjectInputSchema,
          response: {
            ...errors,
            200: createWorkshopProjectResponseSchema,
            201: createWorkshopProjectResponseSchema
          }
        }
      },
      async (request, reply) => {
        const access = await deps.resolveAccessContext(request);
        const result = await deps.dataContext.withDataContext(access, (db) =>
          createWorkshopProject(db, request.body)
        );
        return reply.code(result.created ? 201 : 200).send(result);
      }
    );
    app.get<{ Querystring: { limit?: number; beforeId?: string; beforeCreatedAt?: string } }>(
      "/api/workshop/projects",
      {
        schema: {
          querystring: listWorkshopProjectsQuerySchema,
          response: { ...errors, 200: listWorkshopProjectsResponseSchema }
        }
      },
      async (request) =>
        withAdmin(request, async (db) => {
          const { limit = 50, beforeId, beforeCreatedAt } = request.query;
          const rows = await projects.list(db, {
            limit,
            before:
              beforeId && beforeCreatedAt ? { id: beforeId, createdAt: beforeCreatedAt } : undefined
          });
          const last = rows.at(-1);
          // A full final page needs one empty fetch; add lookahead if that round trip matters.
          return {
            projects: rows,
            nextCursor:
              rows.length === limit && last ? { id: last.id, createdAt: last.createdAt } : null
          };
        })
    );
    app.get<{ Params: { projectId: string } }>(
      "/api/workshop/projects/:projectId",
      {
        schema: {
          params: workshopProjectParamsSchema,
          response: { ...errors, 200: getWorkshopProjectResponseSchema }
        }
      },
      async (request, reply) => {
        const project = await withAdmin(request, (db) =>
          projects.get(db, request.params.projectId)
        );
        return project
          ? { project }
          : reply.code(404).send({ error: "Workshop project not found." });
      }
    );
    app.get<{ Params: { projectId: string }; Querystring: { after?: string; limit?: number } }>(
      "/api/workshop/projects/:projectId/messages",
      {
        schema: {
          params: workshopProjectParamsSchema,
          querystring: listWorkshopMessagesQuerySchema,
          response: { ...errors, 200: listWorkshopMessagesResponseSchema }
        }
      },
      async (request, reply) => {
        const result = await withAdmin(request, (db) =>
          feed.list(db, request.params.projectId, request.query)
        );
        return result ?? reply.code(404).send({ error: "Workshop project not found." });
      }
    );
    app.post<{ Params: { projectId: string }; Body: WorkshopFeedInput }>(
      "/api/workshop/projects/:projectId/messages",
      {
        schema: {
          params: workshopProjectParamsSchema,
          body: createWorkshopMessageInputSchema,
          response: {
            ...errors,
            200: createWorkshopMessageResponseSchema,
            201: createWorkshopMessageResponseSchema
          }
        }
      },
      async (request, reply) => {
        const result = await withAdmin(request, (db) =>
          feed.append(db, request.params.projectId, request.body)
        );
        return result
          ? reply.code(result.created ? 201 : 200).send(result)
          : reply.code(404).send({ error: "Workshop project not found." });
      }
    );
  });
}
