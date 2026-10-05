import type { FastifyInstance, FastifyReply } from "fastify";
import { handleRouteError } from "@moss/module-sdk";
import {
  ingestMeetingTranscriptSchema,
  readMeetingTranscriptSchema,
  readMeetingTranscriptEvidenceSchema,
  type IngestMeetingTranscriptInput,
  type ReadMeetingTranscriptInput,
  type MeetingTranscriptEvidence
} from "@moss/shared";
import type { MeetingRecordRoutesDependencies } from "./routes.js";
import { MeetingTranscriptRepository } from "./transcript-repository.js";
import {
  encodeMeetingTranscriptBatch,
  MeetingTranscriptInputError,
  MeetingTranscriptLimitError,
  MeetingTranscriptRequestConflictError
} from "./transcript-batch.js";

export interface MeetingTranscriptRoutesDependencies extends Pick<
  MeetingRecordRoutesDependencies,
  "resolveAccessContext" | "dataContext"
> {
  readonly transcriptRepository?: Pick<
    MeetingTranscriptRepository,
    "ingest" | "snapshotWithSources" | "evidence"
  >;
}
function failure(error: unknown, reply: FastifyReply) {
  if (error instanceof MeetingTranscriptInputError)
    return reply.code(400).send({ code: "meeting_transcript_invalid_input" });
  if (error instanceof MeetingTranscriptLimitError)
    return reply.code(413).send({ code: "meeting_transcript_limit" });
  if (error instanceof MeetingTranscriptRequestConflictError)
    return reply.code(409).send({ code: "meeting_transcript_request_conflict" });
  return handleRouteError(error, reply);
}
/** General signed-in sessions only; companion credentials do not authorize these routes. */
export function registerMeetingTranscriptRoutes(
  server: FastifyInstance,
  dependencies: MeetingTranscriptRoutesDependencies
): void {
  const repository = dependencies.transcriptRepository ?? new MeetingTranscriptRepository();
  server.post<{ Params: { id: string }; Body: Omit<IngestMeetingTranscriptInput, "meetingId"> }>(
    "/api/meetings/records/:id/transcript",
    {
      schema: ingestMeetingTranscriptSchema,
      bodyLimit: 524288,
      preValidation: async (request, reply) => {
        try {
          encodeMeetingTranscriptBatch({ ...request.body, meetingId: request.params.id });
        } catch (error) {
          return failure(error, reply);
        }
      }
    },
    async (request, reply) => {
      try {
        const actor = await dependencies.resolveAccessContext(request);
        const result = await dependencies.dataContext.withDataContext(actor, (db) =>
          repository.ingest(db, { ...request.body, meetingId: request.params.id })
        );
        if (result.status === "not-found")
          return reply.code(404).send({ code: "meeting_not_found" });
        if (result.status === "conflict")
          return reply.code(409).send({ code: "meeting_transcript_version_conflict", ...result });
        return reply.code(result.replayed ? 200 : 201).send(result);
      } catch (error) {
        return failure(error, reply);
      }
    }
  );
  server.get<{ Params: { id: string }; Querystring: ReadMeetingTranscriptInput }>(
    "/api/meetings/records/:id/transcript",
    { schema: readMeetingTranscriptSchema },
    async (request, reply) => {
      try {
        const actor = await dependencies.resolveAccessContext(request);
        const snapshot = await dependencies.dataContext.withDataContext(actor, (db) =>
          repository.snapshotWithSources(db, request.params.id, request.query)
        );
        return snapshot
          ? snapshot
          : reply.code(404).send({ code: "meeting_transcript_unavailable" });
      } catch (error) {
        return failure(error, reply);
      }
    }
  );
  server.get<{ Params: { id: string }; Querystring: Omit<MeetingTranscriptEvidence, "meetingId"> }>(
    "/api/meetings/records/:id/transcript/evidence",
    { schema: readMeetingTranscriptEvidenceSchema },
    async (request, reply) => {
      try {
        const actor = await dependencies.resolveAccessContext(request);
        const evidence = await dependencies.dataContext.withDataContext(actor, (db) =>
          repository.evidence(db, { ...request.query, meetingId: request.params.id })
        );
        return evidence
          ? { evidence }
          : reply.code(404).send({ code: "meeting_transcript_unavailable" });
      } catch (error) {
        return failure(error, reply);
      }
    }
  );
}
