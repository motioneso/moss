import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  RecordingCapabilityError,
  CompanionAuthError,
  SessionBindingError,
  type MossAuthRuntime
} from "@moss/auth";
import type { DecideRecordingCapabilityInput, RecordingCapabilityAttemptInput } from "@moss/shared";

const uuid = { type: "string", format: "uuid" } as const;
const policyVersion = { type: "integer", const: 1 } as const;
const body = (properties: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required: Object.keys(properties)
});
const limit = (max: number) => ({
  rateLimit: {
    max,
    timeWindow: "1 minute",
    keyGenerator: (request: FastifyRequest) => `ip:${request.ip}`
  }
});

/** Recording authorization and its independent proof are auth-owned, not meeting-content APIs. */
export function registerCompanionRecordingRoutes(
  server: FastifyInstance,
  auth: MossAuthRuntime
): void {
  const service = auth.recordingCapabilities;
  if (!service) return; // Older injected test runtimes have no recording capability surface.
  async function browser(request: FastifyRequest, mutate: boolean) {
    if (
      mutate &&
      (typeof request.headers.origin !== "string" ||
        !auth.trustedOrigins.includes(request.headers.origin))
    )
      throw new RecordingCapabilityError();
    return auth.sessionBindings.resolveBrowser({ headers: request.headers, requestId: request.id });
  }
  function failure(error: unknown, reply: FastifyReply) {
    const status =
      error instanceof RecordingCapabilityError || error instanceof CompanionAuthError
        ? error.httpStatus
        : error instanceof SessionBindingError
          ? 403
          : 503;
    if (status === 429)
      reply.header(
        "Retry-After",
        String(error instanceof RecordingCapabilityError ? error.retryAfterSeconds : 60)
      );
    return reply.code(status).send({
      error: "Recording connection unavailable",
      code: "recording_connection_unavailable"
    });
  }
  server.post<{ Body: RecordingCapabilityAttemptInput }>(
    "/api/companion/recording-capability/attempt",
    {
      bodyLimit: 4096,
      config: limit(10),
      schema: {
        body: body({
          requestKey: uuid,
          proofHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
          policyVersion
        })
      }
    },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      try {
        await auth.companionDevices.resolve({
          headers: request.headers,
          requestId: request.id
        });
        // A linked device cannot open a second recording-approval flow.
        return reply.code(410).send({ code: "recording_relink_required" });
      } catch (error) {
        return failure(error, reply);
      }
    }
  );
  server.post<{ Body: { attemptId: string } }>(
    "/api/companion/recording-capability/status",
    {
      bodyLimit: 4096,
      config: limit(60),
      schema: { body: body({ attemptId: uuid }) }
    },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      try {
        const actor = await auth.companionDevices.resolve({
          headers: request.headers,
          requestId: request.id
        });
        return await service.attemptStatus(actor, request.body.attemptId);
      } catch (error) {
        return failure(error, reply);
      }
    }
  );
  server.get(
    "/api/companion/recording-capabilities",
    { config: limit(60) },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      try {
        const actor = await browser(request, false);
        return await service.list(actor.actorUserId);
      } catch (error) {
        return failure(error, reply);
      }
    }
  );
  server.post<{ Body: DecideRecordingCapabilityInput }>(
    "/api/companion/recording-capability/decide",
    {
      bodyLimit: 4096,
      config: limit(20),
      schema: {
        body: body({
          attemptId: uuid,
          decision: { type: "string", enum: ["approve", "deny"] },
          policyVersion
        })
      }
    },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      try {
        await browser(request, true);
        // Only versioned initial pairing may create new recording authority.
        return reply.code(410).send({ code: "recording_relink_required" });
      } catch (error) {
        return failure(error, reply);
      }
    }
  );
  server.post<{ Body: { deviceId: string } }>(
    "/api/companion/recording-capability/revoke",
    {
      bodyLimit: 4096,
      config: limit(20),
      schema: { body: body({ deviceId: uuid }) }
    },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      try {
        const actor = await browser(request, true);
        await service.revoke(actor, request.body.deviceId);
        return reply.code(204).send();
      } catch (error) {
        return failure(error, reply);
      }
    }
  );
}
