import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AccessContext } from "@moss/db";
import { HttpError } from "@moss/module-sdk";
import { ACT_AS_GRANT_HEADER, sessionRateLimitKey } from "@moss/module-sdk/server";
import { chatVoiceRequestRouteSchema, listChatVoiceRequestsRouteSchema } from "@moss/shared";
import type { VoiceRequestService } from "./voice-request-service.js";
import { voiceRequestStatus } from "./voice-request-status.js";
import { handleRouteError } from "./route-errors.js";

export function registerVoiceRequestRoutes(
  server: FastifyInstance,
  deps: {
    readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
    readonly resolveRingRecordingAccessContext?: (
      request: FastifyRequest
    ) => Promise<AccessContext>;
    readonly service: Pick<VoiceRequestService, "list" | "status" | "send">;
  }
) {
  server.get<{ Querystring: { beforeCreatedAt?: string; beforeId?: string } }>(
    "/api/chat/voice-requests",
    { schema: listChatVoiceRequestsRouteSchema },
    async (request, reply) => {
      try {
        const actor = await deps.resolveAccessContext(request);
        if (request.headers[ACT_AS_GRANT_HEADER] !== undefined)
          throw new HttpError(403, "Open your voice requests in Moss.");
        const { beforeCreatedAt, beforeId } = request.query;
        const rows = await deps.service.list(
          actor,
          beforeCreatedAt && beforeId ? { createdAt: beforeCreatedAt, id: beforeId } : undefined
        );
        const last = rows.at(-1);
        return {
          requests: rows.map(voiceRequestStatus),
          nextCursor:
            rows.length === 100 && last
              ? { createdAt: last.created_at.toISOString(), id: last.id }
              : null
        };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );
  for (const send of [false, true]) {
    server.route<{ Params: { id: string } }>({
      method: send ? "POST" : "GET",
      url: `/api/chat/voice-requests/:id${send ? "/send" : ""}`,
      schema: chatVoiceRequestRouteSchema,
      ...(send
        ? {
            config: {
              rateLimit: { max: 20, timeWindow: "1 minute", keyGenerator: sessionRateLimitKey }
            }
          }
        : {}),
      async handler(request, reply) {
        try {
          const actor = await (
            send
              ? deps.resolveAccessContext
              : (deps.resolveRingRecordingAccessContext ?? deps.resolveAccessContext)
          )(request);
          if (request.headers[ACT_AS_GRANT_HEADER] !== undefined)
            throw new HttpError(403, "Open your voice requests in Moss.");
          if (send && request.body !== undefined && request.body !== null)
            throw new HttpError(400, "Send does not accept a request body.");
          const row = send
            ? await deps.service.send(actor, request.params.id)
            : await deps.service.status(actor, request.params.id);
          if (!row) throw new HttpError(404, "Voice request not found");
          return voiceRequestStatus(row);
        } catch (error) {
          return handleRouteError(error, reply);
        }
      }
    });
  }
}
