import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AccessContext } from "@moss/db";
import { handleRouteError } from "@moss/module-sdk";
import { RECORDING_IMPORT_BODY_LIMIT, RecordingImportInputError } from "./recording-bundle.js";
import { RecordingImportConflictError } from "./recording-import-repository.js";
import type { RecordingImportService } from "./recording-import-service.js";
export function registerRecordingImportRoutes(
  server: FastifyInstance,
  deps: {
    resolveAccessContext(request: FastifyRequest): Promise<AccessContext>;
    service: RecordingImportService;
  }
) {
  server.post(
    "/api/meetings/recording-imports",
    { bodyLimit: RECORDING_IMPORT_BODY_LIMIT },
    async (request, reply) => {
      try {
        const actor = await deps.resolveAccessContext(request);
        const result = await deps.service.accept(actor, request.body);
        const { created, ...status } = result;
        return reply.code(created ? 202 : 200).send(status);
      } catch (error) {
        if (error instanceof RecordingImportInputError)
          return reply.code(error.statusCode).send({ code: "recording_import_invalid" });
        if (error instanceof RecordingImportConflictError)
          return reply.code(409).send({ code: "recording_import_conflict" });
        return handleRouteError(error, reply);
      }
    }
  );
  server.get<{ Params: { id: string } }>(
    "/api/meetings/recording-imports/:id",
    {
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
          additionalProperties: false
        }
      }
    },
    async (request, reply) => {
      try {
        const actor = await deps.resolveAccessContext(request);
        const status = await deps.service.status(actor, request.params.id);
        return status ?? reply.code(404).send({ code: "recording_import_not_found" });
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );
}
