import type { FastifyInstance, FastifyRequest } from "fastify";
import { isUuid, type AccessContext } from "@moss/db";
import { handleRouteError, HttpError } from "@moss/module-sdk";
import { ACT_AS_GRANT_HEADER, sessionRateLimitKey } from "@moss/module-sdk/server";
import { RECORDING_IMPORT_BODY_LIMIT, RecordingImportInputError } from "./recording-bundle.js";
import { RecordingImportConflictError } from "./recording-import-repository.js";
import type { RecordingImportService } from "./recording-import-service.js";

import { RecordingVoiceIneligibleError } from "./recording-voice-enablement.js";

type VoiceRequest = FastifyRequest<{ Params: { id: string } }>;
function resourceId(request: VoiceRequest) {
  if (!isUuid(request.params.id)) throw new HttpError(400, "Invalid voice recording id");
  return request.params.id;
}
function withoutBody(request: VoiceRequest) {
  if (request.body !== undefined && request.body !== null)
    throw new HttpError(400, "This operation does not accept a body");
  return resourceId(request);
}

export function registerRecordingVoiceRoutes(
  server: FastifyInstance,
  deps: {
    resolveAccessContext(request: FastifyRequest): Promise<AccessContext>;
    service: Pick<
      RecordingImportService,
      "enableVoice" | "disableVoice" | "acceptVoice" | "voiceStatus" | "retryVoice"
    >;
  }
) {
  function route(
    method: "GET" | "POST",
    path: string,
    run: (actor: AccessContext, request: VoiceRequest) => Promise<unknown>
  ) {
    server.route<{ Params: { id: string } }>({
      method,
      url: `/api/meetings${path}`,
      bodyLimit: RECORDING_IMPORT_BODY_LIMIT,
      ...(method === "POST"
        ? {
            config: {
              rateLimit: { max: 20, timeWindow: "1 minute", keyGenerator: sessionRateLimitKey }
            }
          }
        : {}),
      async handler(request, reply) {
        try {
          const actor = await deps.resolveAccessContext(request);
          if (request.headers[ACT_AS_GRANT_HEADER] !== undefined)
            throw new HttpError(403, "Open the Vocci companion to manage voice input.");
          const result = await run(actor, request);
          if (result === null) return reply.code(404).send({ code: "recording_voice_not_found" });
          if (result && typeof result === "object" && "created" in result) {
            const { created, ...status } = result;
            return reply.code(created ? 202 : 200).send(status);
          }
          return result;
        } catch (error) {
          if (error instanceof RecordingVoiceIneligibleError)
            return reply
              .code(409)
              .send({ code: "recording_voice_ineligible", error: error.message });
          if (error instanceof RecordingImportInputError)
            return reply.code(error.statusCode).send({ code: "recording_import_invalid" });
          if (error instanceof RecordingImportConflictError)
            return reply.code(409).send({ code: "recording_import_conflict" });
          return handleRouteError(error, reply);
        }
      }
    });
  }
  route("POST", "/voice-enablement", (actor, request) =>
    deps.service.enableVoice(actor, request.body)
  );
  route("POST", "/voice-enablement/:id/disable", (actor, request) =>
    deps.service.disableVoice(actor, withoutBody(request))
  );
  route("POST", "/voice-recordings", (actor, request) =>
    deps.service.acceptVoice(actor, request.body)
  );
  route("GET", "/voice-recordings/:id", (actor, request) =>
    deps.service.voiceStatus(actor, resourceId(request))
  );
  route("POST", "/voice-recordings/:id/retry", (actor, request) =>
    deps.service.retryVoice(actor, withoutBody(request))
  );
}
