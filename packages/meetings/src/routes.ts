import { MeetingCleanupError, type MeetingDeletionService } from "./deletion-service.js";
import { registerRecordingRoutes } from "./recording-routes.js";
import type { MeetingStopSummaryEnqueue } from "./stop-summary-repository.js";
import {
  registerMeetingHistoryRoutes,
  type MeetingHistoryRoutesDependencies
} from "./history-routes.js";
import { registerMeetingTranscriptRoutes } from "./transcript-routes.js";
import type { MeetingPreferenceStore } from "./preferences.js";
import { registerMeetingPreferenceRoutes } from "./preferences-routes.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AccessContext, DataContextRunner } from "@moss/db";
import { handleRouteError } from "@moss/module-sdk";
import {
  createMeetingRecordSchema,
  getMeetingRecordSchema,
  listMeetingRecordsSchema,
  putMeetingNotesSchema,
  putMeetingTitleSchema,
  type PutMeetingTitleInput,
  type CreateMeetingRecordInput,
  type PutMeetingNotesInput
} from "@moss/shared";
import {
  MeetingRecordConflictError,
  MeetingRecordInputError,
  MeetingRecordsRepository
} from "./repository.js";

export interface MeetingContentRoutesDependencies extends MeetingHistoryRoutesDependencies {
  /** General authenticated user session only. Existing companion tokens gain no access here. */
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  readonly dataContext: Pick<DataContextRunner, "withDataContext">;
  readonly manualSummaryEnqueue?: MeetingStopSummaryEnqueue;
  readonly preferences?: MeetingPreferenceStore;
  readonly repository?: Pick<
    MeetingRecordsRepository,
    "create" | "get" | "list" | "putNotes" | "remove" | "putTitle"
  >;
}

/** Browser-authenticated draft records. No route starts capture or contacts a provider. */
export function registerMeetingRecordRoutes(
  server: FastifyInstance,
  dependencies: MeetingRecordRoutesDependencies
): void {
  const repository = dependencies.repository ?? new MeetingRecordsRepository();
  registerRecordingRoutes(server, dependencies);
  registerMeetingHistoryRoutes(server, dependencies);
  registerMeetingPreferenceRoutes(server, dependencies);
  registerMeetingTranscriptRoutes(server, dependencies);
  server.delete<{ Params: { id: string } }>(
    "/api/meetings/records/:id",
    { schema: getMeetingRecordSchema },
    async (request, reply) => {
      try {
        const actor = await dependencies.resolveAccessContext(request);
        await dependencies.deletion.remove(actor, request.params.id);
        return reply.code(204).send();
      } catch (error) {
        if (error instanceof MeetingCleanupError)
          return reply.code(409).send({ code: error.code, message: error.message });
        return handleRouteError(error, reply);
      }
    }
  );
  server.post<{ Body: CreateMeetingRecordInput }>(
    "/api/meetings/records",
    { schema: createMeetingRecordSchema },
    async (request, reply) => {
      try {
        const actor = await dependencies.resolveAccessContext(request);
        const result = await dependencies.dataContext.withDataContext(actor, (db) =>
          repository.create(db, request.body)
        );
        return reply.code(result.created ? 201 : 200).send(result);
      } catch (error) {
        if (error instanceof MeetingRecordConflictError) {
          return reply.code(409).send({ code: "meeting_request_conflict" });
        }
        if (error instanceof MeetingRecordInputError) {
          return reply.code(400).send({ code: "meeting_invalid_input" });
        }
        return handleRouteError(error, reply);
      }
    }
  );
  server.get<{
    Querystring: { limit?: number; beforeId?: string; beforeCreatedAt?: string };
  }>("/api/meetings/records", { schema: listMeetingRecordsSchema }, async (request, reply) => {
    try {
      const actor = await dependencies.resolveAccessContext(request);
      const { limit, beforeId, beforeCreatedAt } = request.query;
      const meetings = await dependencies.dataContext.withDataContext(actor, (db) =>
        repository.list(db, {
          limit,
          before:
            beforeId && beforeCreatedAt ? { id: beforeId, createdAt: beforeCreatedAt } : undefined
        })
      );
      return { meetings };
    } catch (error) {
      if (error instanceof MeetingRecordInputError) {
        return reply.code(400).send({ code: "meeting_invalid_input" });
      }
      return handleRouteError(error, reply);
    }
  });
  server.get<{ Params: { id: string } }>(
    "/api/meetings/records/:id",
    { schema: getMeetingRecordSchema },
    async (request, reply) => {
      try {
        const actor = await dependencies.resolveAccessContext(request);
        const meeting = await dependencies.dataContext.withDataContext(actor, (db) =>
          repository.get(db, request.params.id)
        );
        return meeting ? { meeting } : reply.code(404).send({ code: "meeting_not_found" });
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );
  server.put<{ Params: { id: string }; Body: Omit<PutMeetingTitleInput, "meetingId"> }>(
    "/api/meetings/records/:id/title",
    { schema: putMeetingTitleSchema },
    async (request, reply) => {
      try {
        const actor = await dependencies.resolveAccessContext(request);
        const result = await dependencies.dataContext.withDataContext(actor, (db) =>
          repository.putTitle(db, { ...request.body, meetingId: request.params.id })
        );
        if (result.status === "not-found")
          return reply.code(404).send({ code: "meeting_not_found" });
        return result.status === "conflict"
          ? reply.code(409).send({ code: "meeting_title_conflict", ...result })
          : result;
      } catch (error) {
        if (error instanceof MeetingRecordInputError)
          return reply.code(400).send({ code: "meeting_invalid_input" });
        return handleRouteError(error, reply);
      }
    }
  );
  server.put<{
    Params: { id: string };
    Body: Omit<PutMeetingNotesInput, "meetingId">;
  }>(
    "/api/meetings/records/:id/notes",
    { schema: putMeetingNotesSchema },
    async (request, reply) => {
      try {
        const actor = await dependencies.resolveAccessContext(request);
        const result = await dependencies.dataContext.withDataContext(actor, (db) =>
          repository.putNotes(db, { ...request.body, meetingId: request.params.id })
        );
        if (result.status === "not-found") {
          return reply.code(404).send({ code: "meeting_not_found" });
        }
        return result.status === "conflict"
          ? reply.code(409).send({ code: "meeting_notes_conflict", ...result })
          : result;
      } catch (error) {
        if (error instanceof MeetingRecordConflictError) {
          return reply.code(409).send({ code: "meeting_request_conflict" });
        }
        if (error instanceof MeetingRecordInputError) {
          return reply.code(400).send({ code: "meeting_invalid_input" });
        }
        return handleRouteError(error, reply);
      }
    }
  );
}

export interface MeetingRecordRoutesDependencies extends MeetingContentRoutesDependencies {
  readonly deletion: Pick<MeetingDeletionService, "remove">;
}
