import type { FastifyInstance, FastifyReply } from "fastify";
import { handleRouteError } from "@moss/module-sdk";
import {
  getMeetingRecordSchema,
  manualTranscriptSchema,
  putRecordingTypeSchema,
  putRecordingTypeConfigurationSchema,
  type PutRecordingTypeConfigurationInput,
  type ManualTranscriptInput
} from "@moss/shared";
import { validateRecordingTypeConfiguration } from "./recording-type-config.js";
import type { MeetingRecordRoutesDependencies } from "./routes.js";
import { ManualEntryService, validateManualTranscript } from "./manual-entry-service.js";
import { RecordingIdentityError, RecordingTypesRepository } from "./recording-types.js";
import { RecordingMetadataRepository } from "./recording-metadata.js";
import { MeetingRecordsRepository, MeetingRecordConflictError } from "./repository.js";

function failure(error: unknown, reply: FastifyReply) {
  if (error instanceof RecordingIdentityError)
    return reply.code(error.statusCode).send({ code: error.code });
  if (error instanceof MeetingRecordConflictError)
    return reply.code(409).send({ code: "recording_request_conflict" });
  // Preserve authentication failures, but do not log transcript-bearing database parameters.
  if (
    error instanceof Error &&
    (error.message === "Session is missing or expired" || "statusCode" in error)
  )
    return handleRouteError(error, reply);
  reply.log.warn({ code: "recording_unavailable" }, "Recording operation failed");
  return reply.code(503).send({ code: "recording_unavailable" });
}
export function registerRecordingRoutes(
  server: FastifyInstance,
  deps: MeetingRecordRoutesDependencies
) {
  const types = new RecordingTypesRepository();
  const metadata = new RecordingMetadataRepository();
  server.get("/api/meetings/recording-types", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    try {
      const actor = await deps.resolveAccessContext(request);
      return await deps.dataContext.withDataContext(actor, (db) => types.get(db));
    } catch (error) {
      return failure(error, reply);
    }
  });
  server.put<{ Body: PutRecordingTypeConfigurationInput }>(
    "/api/meetings/recording-types",
    {
      schema: putRecordingTypeConfigurationSchema,
      bodyLimit: 65536,
      preValidation: async (request, reply) => {
        try {
          validateRecordingTypeConfiguration(request.body);
        } catch (error) {
          return failure(error, reply);
        }
      }
    },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      try {
        const actor = await deps.resolveAccessContext(request);
        return await deps.dataContext.withDataContext(actor, (db) => types.put(db, request.body));
      } catch (error) {
        return failure(error, reply);
      }
    }
  );
  server.get<{ Params: { id: string } }>(
    "/api/meetings/records/:id/recording",
    { schema: getMeetingRecordSchema },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      try {
        const actor = await deps.resolveAccessContext(request);
        return await deps.dataContext.withDataContext(actor, async (db) => {
          if (!(await new MeetingRecordsRepository().get(db, request.params.id)))
            throw new RecordingIdentityError("meeting_not_found", 404);
          return {
            metadata: await metadata.get(db, request.params.id),
            configuration: await types.get(db)
          };
        });
      } catch (error) {
        return failure(error, reply);
      }
    }
  );
  server.put<{ Params: { id: string }; Body: { expectedRevision: number; typeId: string } }>(
    "/api/meetings/records/:id/recording/type",
    {
      schema: { ...putRecordingTypeSchema, params: getMeetingRecordSchema.params }
    },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      try {
        const actor = await deps.resolveAccessContext(request);
        return {
          metadata: await deps.dataContext.withDataContext(actor, (db) =>
            metadata.putType(
              db,
              request.params.id,
              request.body.expectedRevision,
              request.body.typeId
            )
          )
        };
      } catch (error) {
        return failure(error, reply);
      }
    }
  );
  server.post<{ Body: ManualTranscriptInput }>(
    "/api/meetings/manual-transcripts",
    {
      schema: manualTranscriptSchema,
      bodyLimit: 524288,
      preValidation: async (request, reply) => {
        try {
          validateManualTranscript(request.body);
        } catch (error) {
          return failure(error, reply);
        }
      }
    },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      try {
        const actor = await deps.resolveAccessContext(request);
        if (!deps.manualSummaryEnqueue)
          throw new RecordingIdentityError("recording_queue_unavailable", 503);
        const result = await deps.dataContext.withDataContext(actor, (db) =>
          new ManualEntryService(deps.manualSummaryEnqueue!).create(db, actor, request.body)
        );
        return reply.code(result.replayed ? 200 : 201).send(result);
      } catch (error) {
        return failure(error, reply);
      }
    }
  );
}
