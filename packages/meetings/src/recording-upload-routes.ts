import { RecordingVoiceIneligibleError } from "./recording-voice-enablement.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { isUuid, type AccessContext } from "@moss/db";
import { handleRouteError, HttpError } from "@moss/module-sdk";
import { ACT_AS_GRANT_HEADER, sessionRateLimitKey } from "@moss/module-sdk/server";
import { RecordingImportConflictError } from "./recording-import-repository.js";
import { RecordingImportInputError } from "./recording-validation-error.js";
import type { RecordingUploadService } from "./recording-upload-service.js";
import {
  RECORDING_SOURCE_LIMITS,
  type RecordingSourceKind
} from "./recording-source-validation.js";

export function registerRecordingUploadRoutes(
  server: FastifyInstance,
  deps: {
    resolveAccessContext(request: FastifyRequest): Promise<AccessContext>;
    service: RecordingUploadService;
  }
) {
  // Encapsulation keeps the binary parser confined to these routes.
  server.register(async (scope) => {
    // The assembled API may already parse binary companion uploads. Override only
    // this child scope so its limits do not alter any sibling receiver.
    if (scope.hasContentTypeParser("application/octet-stream"))
      scope.removeContentTypeParser("application/octet-stream");
    scope.addContentTypeParser(
      "application/octet-stream",
      { parseAs: "buffer" },
      (_req, bytes, done) => done(null, bytes)
    );
    type Request = FastifyRequest<{ Params: { id?: string; kind?: string; index?: string } }>;
    function route(
      method: "GET" | "POST" | "PUT",
      suffix: string,
      run: (actor: AccessContext, request: Request) => Promise<unknown>
    ) {
      scope.route<{ Params: { id?: string; kind?: string; index?: string } }>({
        method,
        url: `/api/meetings/recording-uploads${suffix}`,
        bodyLimit: method === "PUT" ? RECORDING_SOURCE_LIMITS.chunk : 4096,
        config: {
          rateLimit: {
            max: method === "PUT" ? 300 : 30,
            timeWindow: "1 minute",
            keyGenerator: sessionRateLimitKey
          }
        },
        async handler(request, reply) {
          try {
            const actor = await deps.resolveAccessContext(request);
            if (request.headers[ACT_AS_GRANT_HEADER] !== undefined)
              throw new HttpError(403, "Open the Vocci companion to manage recordings.");
            if (request.params.id !== undefined && !isUuid(request.params.id))
              throw new HttpError(400, "Invalid recording upload id");
            return await run(actor, request);
          } catch (error) {
            if (error instanceof RecordingVoiceIneligibleError)
              return reply
                .code(409)
                .send({ code: "recording_voice_ineligible", error: error.message });
            if (error instanceof RecordingImportConflictError)
              return reply.code(409).send({ code: "recording_import_conflict" });
            if (error instanceof RecordingImportInputError)
              return reply.code(error.statusCode).send({ code: "recording_import_invalid" });
            return handleRouteError(error, reply);
          }
        }
      });
    }
    route("POST", "", (actor, request) => deps.service.reserve(actor, request.body));
    route("GET", "/:id", (actor, request) => deps.service.status(actor, request.params.id!));
    route("PUT", "/:id/:kind/:index", (actor, request) => {
      if (
        !Buffer.isBuffer(request.body) ||
        !/^(0|[1-9][0-9]{0,2})$/.test(request.params.index ?? "")
      )
        throw new HttpError(400, "Invalid recording chunk");
      return deps.service.put(
        actor,
        request.params.id!,
        request.params.kind as RecordingSourceKind,
        Number(request.params.index),
        request.body
      );
    });
    route("POST", "/:id/finalize", (actor, request) => {
      if (request.body !== undefined && request.body !== null)
        throw new HttpError(400, "This operation does not accept a body");
      return deps.service.finalize(actor, request.params.id!);
    });
  });
}
