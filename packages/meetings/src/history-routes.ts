import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AccessContext, DataContextDb, DataContextRunner } from "@moss/db";
import { handleRouteError, HttpError } from "@moss/module-sdk";
import {
  getMeetingHistorySchema,
  searchMeetingHistorySchema,
  type SearchMeetingHistoryInput
} from "@moss/shared";
import {
  MeetingHistoryInputError,
  MeetingHistoryRepository,
  validateMeetingHistoryInput
} from "./history-repository.js";

export interface MeetingHistoryRoutesDependencies {
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  readonly dataContext: Pick<DataContextRunner, "withDataContext">;
  readonly historyRepository?: Pick<MeetingHistoryRepository, "search" | "get">;
}
function failure(error: unknown, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store");
  if (error instanceof MeetingHistoryInputError)
    return reply.code(400).send({ code: "meeting_history_invalid_input" });
  if (
    error instanceof Error &&
    (error.message === "Session is missing or expired" ||
      ["account_pending_approval", "account_deactivated"].includes(
        String((error as Error & { code?: string }).code)
      ))
  ) {
    return handleRouteError(error, reply);
  }
  if (error instanceof HttpError && [401, 403].includes(error.statusCode)) {
    return reply.code(error.statusCode).send({ code: "meeting_history_access_denied" });
  }
  // Driver/commit errors can include private query parameters. Never pass raw errors to the
  // generic module error helper, whose fallback logs the original error object.
  reply.log.warn({ code: "meeting_history_unavailable" }, "Meeting history query failed");
  return reply.code(503).send({ code: "meeting_history_unavailable" });
}
export function registerMeetingHistoryRoutes(
  server: FastifyInstance,
  dependencies: MeetingHistoryRoutesDependencies
): void {
  const repository = dependencies.historyRepository ?? new MeetingHistoryRepository();
  const errorHandler = (
    error: Error & { statusCode?: number },
    _request: FastifyRequest,
    reply: FastifyReply
  ) => {
    reply.header("Cache-Control", "no-store");
    if (error.statusCode === 429)
      return reply.code(429).send({ code: "meeting_history_rate_limited" });
    if (error.statusCode === 401 || error.statusCode === 403)
      return reply.code(error.statusCode).send({ code: "meeting_history_access_denied" });
    if (error.statusCode === 404) return reply.code(404).send({ code: "meeting_not_found" });
    if (
      error instanceof MeetingHistoryInputError ||
      error.statusCode === 400 ||
      error.statusCode === 413
    ) {
      return reply
        .code(error.statusCode === 413 ? 413 : 400)
        .send({ code: "meeting_history_invalid_input" });
    }
    return failure(error, reply);
  };
  const run = async <T>(request: FastifyRequest, work: (db: DataContextDb) => Promise<T>) => {
    const actor = await dependencies.resolveAccessContext(request);
    return dependencies.dataContext.withDataContext(actor, work);
  };
  server.post<{ Body: SearchMeetingHistoryInput }>(
    "/api/meetings/history/search",
    {
      schema: searchMeetingHistorySchema,
      bodyLimit: 4096,
      preValidation: async (request) => {
        validateMeetingHistoryInput(request.body);
      },
      errorHandler
    },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      try {
        return await run(request, (db) => repository.search(db, request.body));
      } catch (error) {
        return failure(error, reply);
      }
    }
  );
  server.get<{ Params: { id: string } }>(
    "/api/meetings/history/:id",
    {
      schema: getMeetingHistorySchema,
      errorHandler
    },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      try {
        const meeting = await run(request, (db) => repository.get(db, request.params.id));
        return meeting ? { meeting } : reply.code(404).send({ code: "meeting_not_found" });
      } catch (error) {
        return failure(error, reply);
      }
    }
  );
}
