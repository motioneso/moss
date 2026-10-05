import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
  MeetingCaptureAudioInput,
  MeetingCaptureControlInput,
  MeetingCaptureLinkInput,
  MeetingCaptureRedeemInput,
  MeetingCaptureStatusInput
} from "@moss/shared";
import { MeetingCaptureError } from "./capture-domain.js";
import { MeetingCaptureService, type MeetingCaptureDependencies } from "./capture-service.js";

const uuid = { type: "string", format: "uuid" } as const;
const text = { type: "string", minLength: 1, maxLength: 256, pattern: "^[^\\u0000]+$" } as const;
const counter = { type: "integer", minimum: 0, maximum: 7200000 } as const;
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required
});
const microphone = object({ deviceId: text, sourceId: text });
const selection = {
  oneOf: [
    object({ mode: { const: "microphone-only" }, microphone }),
    object({
      mode: { const: "selected-app" },
      microphone,
      outputSourceId: text,
      appProcessTreeId: text
    }),
    object({
      mode: { const: "computer-audio" },
      microphone,
      outputSourceId: text,
      scope: object({
        kind: { const: "process-exclusion" },
        excludedProcessTreeIds: {
          type: "array",
          minItems: 1,
          maxItems: 64,
          uniqueItems: true,
          items: text
        }
      })
    })
  ]
};
const permission = { enum: ["granted", "denied", "unknown"] };
const inventory = object({
  microphones: {
    type: "array",
    maxItems: 64,
    items: object({ deviceId: text, sourceId: text, label: text })
  },
  applications: {
    type: "array",
    maxItems: 128,
    items: object({ appProcessTreeId: text, label: text })
  },
  computerAudio: object({
    available: { type: "boolean" },
    excludedProcessTreeIds: { type: "array", maxItems: 64, uniqueItems: true, items: text }
  }),
  microphonePermission: permission,
  systemAudioPermission: permission
});
const observed = object(
  {
    generation: counter,
    phase: { enum: ["idle", "recording", "paused", "stopped", "error"] },
    errorCode: { type: "string", minLength: 1, maxLength: 80, pattern: "^[a-z0-9_]+$" }
  },
  ["generation", "phase"]
);
const gap = object({
  id: uuid,
  sourceId: text,
  epoch: { ...counter, minimum: 1, maximum: 64 },
  startMs: counter,
  endMs: counter,
  reason: {
    enum: [
      "paused",
      "expired",
      "buffer-full",
      "source-unavailable",
      "processing-failed",
      "interrupted",
      "discarded"
    ]
  }
});
const controlProperties = {
  grantId: uuid,
  requestKey: uuid,
  expectedGeneration: counter,
  command: { enum: ["record", "pause", "stop", "revoke"] },
  selection,
  noticeAcknowledged: { const: true }
};
const controlRequired = ["grantId", "requestKey", "expectedGeneration", "command"];
const params = object({ id: uuid });
/** Before credential resolution, rotating untrusted bearer/cookie bytes must not rotate buckets. */
function ipRateLimit(max: number) {
  return {
    rateLimit: {
      max,
      timeWindow: "1 minute",
      keyGenerator: (request: FastifyRequest) => `ip:${request.ip}`
    }
  };
}
function failure(error: unknown, reply: FastifyReply) {
  if (error instanceof MeetingCaptureError)
    return reply.code(error.httpStatus).send({ code: error.code });
  return reply.code(503).send({ code: "meeting_capture_unavailable" });
}
/** Explicit browser controls and a separate mm1-only native surface. No general session fallback. */
export function registerMeetingCaptureRoutes(
  server: FastifyInstance,
  deps: MeetingCaptureDependencies
): void {
  const service = new MeetingCaptureService(deps);
  const noStore = async (_request: FastifyRequest, reply: FastifyReply) => {
    reply.header("Cache-Control", "no-store");
  };
  const options = { onRequest: noStore, bodyLimit: 131072 };
  server.post<{ Body: MeetingCaptureLinkInput }>(
    "/api/meetings/capture/link",
    {
      ...options,
      config: ipRateLimit(20),
      schema: {
        body: object({
          meetingId: uuid,
          verifierHash: { type: "string", pattern: "^[a-f0-9]{64}$" }
        })
      }
    },
    async (request, reply) => {
      try {
        return await service.link(request.headers, request.id, request.body);
      } catch (error) {
        return failure(error, reply);
      }
    }
  );
  server.post<{ Body: MeetingCaptureRedeemInput }>(
    "/api/meetings/capture/redeem",
    {
      ...options,
      config: ipRateLimit(120),
      schema: {
        body: object({
          meetingId: uuid,
          challengeId: uuid,
          verifier: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" }
        })
      }
    },
    async (request, reply) => {
      try {
        return await service.redeem(request.headers, request.id, request.body);
      } catch (error) {
        return failure(error, reply);
      }
    }
  );
  server.post<{ Body: MeetingCaptureStatusInput }>(
    "/api/meetings/capture/status",
    {
      ...options,
      config: ipRateLimit(600),
      schema: {
        body: object(
          {
            meetingId: uuid,
            grantId: uuid,
            inventory,
            observed,
            gaps: { type: "array", maxItems: 32, items: gap }
          },
          ["meetingId", "grantId", "inventory", "observed"]
        )
      }
    },
    async (request, reply) => {
      try {
        return await service.status(request.headers, request.id, request.body);
      } catch (error) {
        return failure(error, reply);
      }
    }
  );
  server.post<{ Body: MeetingCaptureControlInput & { meetingId: string; grantId: string } }>(
    "/api/meetings/capture/control",
    {
      ...options,
      config: ipRateLimit(60),
      schema: {
        body: object({ ...controlProperties, meetingId: uuid, grantId: uuid }, [
          ...controlRequired,
          "meetingId"
        ])
      }
    },
    async (request, reply) => {
      try {
        return await service.nativeControl(request.headers, request.id, request.body);
      } catch (error) {
        return failure(error, reply);
      }
    }
  );
  server.post<{ Body: MeetingCaptureAudioInput }>(
    "/api/meetings/capture/audio",
    {
      ...options,
      config: ipRateLimit(120),
      bodyLimit: 5200000,
      schema: {
        body: object({
          meetingId: uuid,
          grantId: uuid,
          requestKey: uuid,
          generation: counter,
          epoch: { ...counter, minimum: 1, maximum: 64 },
          sourceId: text,
          sequence: counter,
          startMs: counter,
          endMs: counter,
          sampleRateHz: { type: "integer", minimum: 8000, maximum: 192000 },
          pcmBase64: { type: "string", minLength: 4, maxLength: 5120000 }
        })
      }
    },
    async (request, reply) => {
      try {
        return await service.audio(request.headers, request.id, request.body);
      } catch (error) {
        return failure(error, reply);
      }
    }
  );
  server.get<{ Params: { id: string } }>(
    "/api/meetings/records/:id/capture",
    { ...options, config: ipRateLimit(300), schema: { params } },
    async (request, reply) => {
      try {
        return await service.browserStatus(
          await service.browser(request.headers, request.id, false),
          request.params.id
        );
      } catch (error) {
        return failure(error, reply);
      }
    }
  );
  server.post<{ Params: { id: string }; Body: { challengeId: string } }>(
    "/api/meetings/records/:id/capture/approve",
    {
      ...options,
      config: ipRateLimit(60),
      schema: { params, body: object({ challengeId: uuid }) }
    },
    async (request, reply) => {
      try {
        return await service.approve(
          await service.browser(request.headers, request.id, true),
          request.params.id,
          request.body.challengeId
        );
      } catch (error) {
        return failure(error, reply);
      }
    }
  );
  server.post<{ Params: { id: string }; Body: MeetingCaptureControlInput }>(
    "/api/meetings/records/:id/capture/control",
    {
      ...options,
      config: ipRateLimit(300),
      schema: { params, body: object(controlProperties, controlRequired) }
    },
    async (request, reply) => {
      try {
        return await service.browserControl(
          await service.browser(request.headers, request.id, true),
          request.params.id,
          request.body
        );
      } catch (error) {
        return failure(error, reply);
      }
    }
  );
}
