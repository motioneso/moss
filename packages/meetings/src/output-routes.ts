import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AccessContext, DataContextRunner } from "@moss/db";
import { handleRouteError } from "@moss/module-sdk";
import type {
  EditMeetingOutputInput,
  GenerateMeetingOutputInput,
  ReviewMeetingActionInput
} from "@moss/shared";
import {
  MeetingOutputError,
  MeetingOutputsRepository,
  type MeetingTaskCreator
} from "./output-repository.js";
import { MeetingOutputService, type MeetingOutputGenerator } from "./output-service.js";
import { MEETING_OUTPUT_TEMPLATES } from "./output-validation.js";
const uuid = { type: "string", format: "uuid" } as const;
const counter = { type: "integer", minimum: 0, maximum: 2147483646 } as const;
const params = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: { id: uuid }
} as const;
export interface MeetingOutputRoutesDependencies {
  resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  dataContext: Pick<DataContextRunner, "withDataContext">;
  generator: MeetingOutputGenerator;
  createTask: MeetingTaskCreator;
  assertTaskAvailable: (actor: AccessContext) => Promise<void>;
}
export function registerMeetingOutputRoutes(
  server: FastifyInstance,
  dependencies: MeetingOutputRoutesDependencies
): void {
  const repository = new MeetingOutputsRepository();
  const service = new MeetingOutputService(
    dependencies.dataContext,
    dependencies.generator,
    repository
  );
  server.get<{ Params: { id: string } }>(
    "/api/meetings/records/:id/outputs",
    { schema: { params } },
    async (request, reply) => {
      try {
        const actor = await dependencies.resolveAccessContext(request);
        return await dependencies.dataContext.withDataContext(actor, async (db) => ({
          ...(await repository.list(db, request.params.id)),
          templates: MEETING_OUTPUT_TEMPLATES
        }));
      } catch (error) {
        return routeError(error, reply);
      }
    }
  );
  server.get<{ Params: { id: string; version: number } }>(
    "/api/meetings/records/:id/outputs/:version",
    {
      schema: {
        params: {
          ...params,
          required: ["id", "version"],
          properties: { id: uuid, version: { type: "integer", minimum: 1, maximum: 1000 } }
        }
      }
    },
    async (request, reply) => {
      try {
        const actor = await dependencies.resolveAccessContext(request);
        const artifact = await dependencies.dataContext.withDataContext(actor, async (db) => {
          const inputs = await repository.inputs(db, request.params.id);
          const stored = await repository.getArtifact(
            db,
            request.params.id,
            request.params.version
          );
          return stored
            ? {
                ...stored,
                stale:
                  stored.stale ||
                  stored.inputs.notesRevision !== inputs.notesRevision ||
                  (stored.inputs.transcript?.transcriptRevision ?? 0) !==
                    (inputs.transcript?.transcriptRevision ?? 0)
              }
            : null;
        });
        return artifact
          ? { artifact }
          : reply.code(404).send({ code: "meeting_output_unavailable" });
      } catch (error) {
        return routeError(error, reply);
      }
    }
  );
  server.post<{ Params: { id: string }; Body: GenerateMeetingOutputInput }>(
    "/api/meetings/records/:id/outputs",
    {
      schema: {
        params,
        body: {
          type: "object",
          additionalProperties: false,
          required: [
            "requestKey",
            "expectedOutputVersion",
            "expectedTranscriptRevision",
            "expectedNotesRevision",
            "templateId",
            "templateVersion"
          ],
          properties: {
            requestKey: uuid,
            expectedOutputVersion: counter,
            expectedTranscriptRevision: counter,
            expectedNotesRevision: counter,
            templateId: {
              type: "string",
              enum: ["general", "one-to-one", "project-review", "interview"]
            },
            templateVersion: { type: "integer", const: 1 }
          }
        }
      }
    },
    async (request, reply) => {
      try {
        const actor = await dependencies.resolveAccessContext(request);
        const result = await service.generate(actor, request.params.id, request.body);
        return reply
          .code(result.status === "pending" ? 202 : result.status === "failed" ? 422 : 200)
          .send(result);
      } catch (error) {
        return routeError(error, reply);
      }
    }
  );
  server.put<{ Params: { id: string }; Body: EditMeetingOutputInput }>(
    "/api/meetings/records/:id/outputs",
    {
      bodyLimit: 524288,
      schema: {
        params,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["requestKey", "expectedOutputVersion", "content"],
          properties: {
            requestKey: uuid,
            expectedOutputVersion: counter,
            content: { type: "object" }
          }
        }
      }
    },
    async (request, reply) => {
      try {
        const actor = await dependencies.resolveAccessContext(request);
        return await dependencies.dataContext.withDataContext(actor, (db) =>
          repository.edit(db, request.params.id, request.body)
        );
      } catch (error) {
        return routeError(error, reply);
      }
    }
  );
  server.post<{ Params: { id: string; candidateId: string }; Body: ReviewMeetingActionInput }>(
    "/api/meetings/records/:id/actions/:candidateId/review",
    {
      schema: {
        params: {
          ...params,
          required: ["id", "candidateId"],
          properties: { id: uuid, candidateId: uuid }
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["requestKey", "decision"],
          properties: {
            requestKey: uuid,
            decision: { type: "string", enum: ["accept", "dismiss"] },
            title: { type: "string", minLength: 1, maxLength: 500 },
            dueAt: { anyOf: [{ type: "null" }, { type: "string", format: "date-time" }] },
            createDespitePossibleMatches: { type: "boolean" }
          }
        }
      }
    },
    async (request, reply) => {
      try {
        const actor = await dependencies.resolveAccessContext(request);
        if (request.body.decision === "accept") await dependencies.assertTaskAvailable(actor);
        return await dependencies.dataContext.withDataContext(actor, (db) =>
          repository.review(
            db,
            request.params.id,
            request.params.candidateId,
            request.body,
            dependencies.createTask
          )
        );
      } catch (error) {
        return routeError(error, reply);
      }
    }
  );
}
function routeError(error: unknown, reply: Parameters<typeof handleRouteError>[1]) {
  if (error instanceof MeetingOutputError)
    return reply
      .code(error.statusCode)
      .send({ code: error.code, currentVersions: error.currentVersions });
  return handleRouteError(error, reply);
}
