import { Ajv } from "ajv";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { handleRouteError } from "@moss/module-sdk";
import type { AcknowledgeMeetingRecordingNoticeInput } from "@moss/shared";
import type { MeetingRecordRoutesDependencies } from "./routes.js";
import { MeetingCaptureError } from "./capture-domain.js";
import { MeetingRecordingNoticeRepository } from "./recording-notice.js";

const validator = new Ajv({ removeAdditional: false, coerceTypes: false });
export function registerMeetingRecordingNoticeRoutes(
  server: FastifyInstance,
  dependencies: Pick<MeetingRecordRoutesDependencies, "resolveAccessContext" | "dataContext">,
  repository = new MeetingRecordingNoticeRepository()
): void {
  const noStore = async (_request: FastifyRequest, reply: FastifyReply) => {
    reply.header("Cache-Control", "no-store");
  };
  server.get(
    "/api/meetings/recording-notice",
    {
      onRequest: noStore,
      config: {
        rateLimit: {
          max: 120,
          timeWindow: "1 minute",
          keyGenerator: (request: FastifyRequest) => `ip:${request.ip}`
        }
      }
    },
    async (request, reply) => {
      try {
        const actor = await dependencies.resolveAccessContext(request);
        return await dependencies.dataContext.withDataContext(actor, (db) => repository.get(db));
      } catch (error) {
        if (error instanceof MeetingCaptureError)
          return reply.code(error.httpStatus).send({ code: error.code });
        return handleRouteError(error, reply);
      }
    }
  );
  server.put<{ Body: AcknowledgeMeetingRecordingNoticeInput }>(
    "/api/meetings/recording-notice",
    {
      onRequest: noStore,
      config: {
        rateLimit: {
          max: 20,
          timeWindow: "1 minute",
          keyGenerator: (request: FastifyRequest) => `ip:${request.ip}`
        }
      },
      validatorCompiler: ({ schema }) => validator.compile(schema as object),
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["policyVersion"],
          properties: { policyVersion: { type: "string", minLength: 1, maxLength: 80 } }
        }
      }
    },
    async (request, reply) => {
      try {
        const actor = await dependencies.resolveAccessContext(request);
        return await dependencies.dataContext.withDataContext(actor, (db) =>
          repository.acknowledge(db, request.body.policyVersion)
        );
      } catch (error) {
        if (error instanceof MeetingCaptureError)
          return reply.code(error.httpStatus).send({ code: error.code });
        return handleRouteError(error, reply);
      }
    }
  );
}
