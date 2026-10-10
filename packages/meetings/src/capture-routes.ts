import { captureAudioDiagnostic } from "./capture-diagnostics.js";
import { captureAuthorizationError } from "./capture-authorization.js";
import { Ajv } from "ajv";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
  MeetingCaptureAudioInput,
  MeetingCaptureControlInput,
  MeetingCaptureNativeControlInput,
  MeetingCaptureConnectionInput,
  MeetingCaptureCommandsInput,
  MeetingCaptureClaimInput,
  MeetingCaptureCancelStartInput,
  MeetingCaptureStartRequest,
  MeetingCaptureStatusInput
} from "@moss/shared";
import { MeetingCaptureConnectionService } from "./capture-connection-service.js";
import { CaptureWaiters } from "./capture-waiters.js";
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
// Route-local validator: source envelopes are never coerced or stripped while discriminating.
const captureBodyValidator = new Ajv({
  removeAdditional: false,
  coerceTypes: false,
  useDefaults: false,
  discriminator: true,
  strict: false
});
const captureQueryValidator = new Ajv({
  removeAdditional: false,
  coerceTypes: true,
  useDefaults: false,
  strict: false
});
for (const validator of [captureBodyValidator, captureQueryValidator])
  validator.addFormat("uuid", /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const selection = {
  type: "object",
  required: ["mode"],
  discriminator: { propertyName: "mode" },
  oneOf: [
    object({ mode: { const: "microphone-only" }, microphone }),
    object(
      {
        mode: { const: "selected-app" },
        microphone,
        outputSourceId: text,
        appProcessTreeId: text,
        applicationId: text
      },
      ["mode", "microphone", "outputSourceId", "appProcessTreeId"]
    ),
    object({
      mode: { const: "computer-audio" },
      microphone: { anyOf: [microphone, { type: "null" }] },
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
const inventory = object(
  {
    defaultMicrophoneId: { ...text, nullable: true },
    microphones: {
      type: "array",
      maxItems: 64,
      items: object({ deviceId: text, sourceId: text, label: text })
    },
    applications: {
      type: "array",
      maxItems: 128,
      items: object({ appProcessTreeId: text, applicationId: text, label: text }, [
        "appProcessTreeId",
        "label"
      ])
    },
    computerAudio: object({
      available: { type: "boolean" },
      excludedProcessTreeIds: { type: "array", maxItems: 64, uniqueItems: true, items: text }
    }),
    microphonePermission: permission,
    systemAudioPermission: permission
  },
  ["microphones", "applications", "computerAudio", "microphonePermission", "systemAudioPermission"]
);
const observed = object(
  {
    generation: counter,
    phase: { enum: ["idle", "recording", "recovering", "paused", "stopped", "error"] },
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
  selection
};
const controlRequired = ["grantId", "requestKey", "expectedGeneration", "command"];
const nativeControlBody = {
  type: "object",
  required: ["command"],
  discriminator: { propertyName: "command" },
  oneOf: [
    object({
      meetingId: uuid,
      grantId: uuid,
      requestKey: uuid,
      expectedGeneration: counter,
      command: { enum: ["record", "pause", "stop"] }
    }),
    object({
      meetingId: uuid,
      grantId: uuid,
      requestKey: uuid,
      expectedGeneration: counter,
      command: { enum: ["change-sources", "recover-sources"] },
      expectedEpoch: { ...counter, minimum: 1, maximum: 64 },
      selection
    })
  ]
};
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
  if (error instanceof MeetingCaptureError) {
    if (error.httpStatus === 429) reply.header("Retry-After", String(error.retryAfterSeconds));
    return reply.code(error.httpStatus).send({ code: error.code });
  }
  const unavailable = captureAuthorizationError(error);
  return reply.code(unavailable.httpStatus).send({ code: unavailable.code });
}
/** Explicit browser controls and a separate mm1-only native surface. No general session fallback. */
export function registerMeetingCaptureRoutes(
  server: FastifyInstance,
  deps: MeetingCaptureDependencies
): void {
  const service = new MeetingCaptureService(deps);
  const connections = new MeetingCaptureConnectionService(deps);
  const waiters = new CaptureWaiters();
  const noStore = async (_request: FastifyRequest, reply: FastifyReply) => {
    reply.header("Cache-Control", "no-store");
  };
  const options = {
    onRequest: noStore,
    bodyLimit: 131072,
    validatorCompiler: ({ schema, httpPart }: { schema: unknown; httpPart?: string }) =>
      (httpPart === "body" ? captureBodyValidator : captureQueryValidator).compile(schema as object)
  };
  server.post<{ Body: MeetingCaptureConnectionInput }>(
    "/api/meetings/capture/connection",
    {
      ...options,
      config: ipRateLimit(120),
      schema: {
        body: object({
          connectionId: uuid,
          verifierHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
          inventory
        })
      }
    },
    async (request, reply) => {
      try {
        return await connections.register(request.headers, request.id, request.body);
      } catch (error) {
        return failure(error, reply);
      }
    }
  );
  server.post<{ Body: MeetingCaptureCommandsInput }>(
    "/api/meetings/capture/commands",
    {
      ...options,
      config: ipRateLimit(120),
      schema: {
        body: object(
          {
            connectionId: uuid,
            verifier: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" },
            revision: { type: "string", maxLength: 64 },
            waitMs: { type: "integer", minimum: 0, maximum: 20000 }
          },
          ["connectionId", "verifier"]
        )
      }
    },
    async (request, reply) => {
      const abort = new AbortController();
      reply.raw.once("close", () => abort.abort());
      try {
        const deadline = Date.now() + (request.body.waitMs ?? 0);
        let result = await connections.commands(request.headers, request.id, request.body);
        while (
          request.body.revision === result.revision &&
          Date.now() < deadline &&
          !abort.signal.aborted
        ) {
          await waiters.wait(
            `device:${request.body.connectionId}`,
            deadline - Date.now(),
            abort.signal
          );
          result = await connections.commands(request.headers, request.id, request.body);
        }
        return result;
      } catch (error) {
        return failure(error, reply);
      }
    }
  );
  server.post<{ Body: MeetingCaptureClaimInput }>(
    "/api/meetings/capture/claim",
    {
      ...options,
      config: ipRateLimit(60),
      schema: {
        body: object({
          connectionId: uuid,
          verifier: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" },
          grantId: uuid,
          credentialHash: { type: "string", pattern: "^[a-f0-9]{64}$" }
        })
      }
    },
    async (request, reply) => {
      try {
        const result = await connections.claim(request.headers, request.id, request.body);
        waiters.notify(`meeting:${result.meetingId}`);
        return result;
      } catch (error) {
        return failure(error, reply);
      }
    }
  );
  server.get(
    "/api/meetings/capture/devices",
    { ...options, config: ipRateLimit(120) },
    async (request, reply) => {
      try {
        return await connections.devices(await service.browser(request.headers, request.id, false));
      } catch (error) {
        return failure(error, reply);
      }
    }
  );
  server.post<{ Params: { id: string }; Body: MeetingCaptureStartRequest }>(
    "/api/meetings/records/:id/capture/start",
    {
      ...options,
      config: ipRateLimit(60),
      schema: {
        params,
        body: {
          oneOf: [
            object({ requestKey: uuid }),
            object(
              {
                deviceId: uuid,
                connectionId: uuid,
                expectedRevision: { type: "integer", minimum: 1 },
                requestKey: uuid,
                selection
              },
              ["deviceId", "connectionId", "expectedRevision", "requestKey", "selection"]
            )
          ]
        }
      }
    },
    async (request, reply) => {
      try {
        const result = await connections.start(
          await service.browser(request.headers, request.id, true),
          request.params.id,
          request.body
        );
        if (result.wakeConnectionId) waiters.notify(`device:${result.wakeConnectionId}`);
        waiters.notify(`meeting:${request.params.id}`);
        return { capture: result.capture };
      } catch (error) {
        return failure(error, reply);
      }
    }
  );
  server.post<{ Params: { id: string }; Body: MeetingCaptureCancelStartInput }>(
    "/api/meetings/records/:id/capture/cancel-start",
    {
      ...options,
      config: ipRateLimit(60),
      schema: {
        params,
        body: {
          ...object({ deviceId: uuid, connectionId: uuid, requestKey: uuid }, ["requestKey"]),
          dependencies: { deviceId: ["connectionId"], connectionId: ["deviceId"] }
        }
      }
    },
    async (request, reply) => {
      try {
        const result = await service.cancelStart(
          await service.browser(request.headers, request.id, true),
          request.params.id,
          request.body
        );
        if (result.wakeConnectionId) waiters.notify(`device:${result.wakeConnectionId}`);
        waiters.notify(`meeting:${request.params.id}`);
        return { cancelled: result.cancelled, capture: result.capture };
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
            gaps: { type: "array", maxItems: 32, items: gap },
            finalized: { type: "boolean" },
            recordedDurationMs: counter
          },
          ["meetingId", "grantId", "inventory", "observed"]
        )
      }
    },
    async (request, reply) => {
      try {
        const result = await service.status(request.headers, request.id, request.body);
        if (result.changed) waiters.notify(`meeting:${request.body.meetingId}`);
        return { capture: result.capture };
      } catch (error) {
        return failure(error, reply);
      }
    }
  );
  server.post<{ Body: MeetingCaptureNativeControlInput }>(
    "/api/meetings/capture/control",
    {
      ...options,
      config: ipRateLimit(60),
      schema: {
        body: nativeControlBody
      }
    },
    async (request, reply) => {
      try {
        const result = await service.nativeControl(request.headers, request.id, request.body);
        waiters.notify(`meeting:${request.body.meetingId}`);
        return result;
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
        const result = await service.audio(request.headers, request.id, request.body);
        const diagnostic = captureAudioDiagnostic(request.body, result);
        if (diagnostic) request.log.warn(diagnostic, "Meeting clip processing outcome");
        waiters.notify(`meeting:${request.body.meetingId}`);
        return result;
      } catch (error) {
        return failure(error, reply);
      }
    }
  );
  server.get<{ Params: { id: string }; Querystring: { revision?: string; waitMs?: number } }>(
    "/api/meetings/records/:id/capture",
    {
      ...options,
      config: ipRateLimit(180),
      schema: {
        params,
        querystring: object(
          {
            revision: { type: "string", maxLength: 64 },
            waitMs: { type: "integer", minimum: 0, maximum: 20000 }
          },
          []
        )
      }
    },
    async (request, reply) => {
      const abort = new AbortController();
      reply.raw.once("close", () => abort.abort());
      try {
        const deadline = Date.now() + (request.query.waitMs ?? 0);
        const read = async () =>
          service.browserStatus(
            await service.browser(request.headers, request.id, false),
            request.params.id
          );
        let result = await read();
        while (
          request.query.revision === result.revision &&
          Date.now() < deadline &&
          !abort.signal.aborted &&
          result.capture?.finalization !== "complete" &&
          result.capture?.desired !== "revoked"
        ) {
          await waiters.wait(`meeting:${request.params.id}`, deadline - Date.now(), abort.signal);
          result = await read();
        }
        return result;
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
      schema: {
        params,
        body: object(controlProperties, controlRequired)
      }
    },
    async (request, reply) => {
      try {
        const result = await service.browserControl(
          await service.browser(request.headers, request.id, true),
          request.params.id,
          request.body
        );
        waiters.notify(`meeting:${request.params.id}`);
        return result;
      } catch (error) {
        return failure(error, reply);
      }
    }
  );
}
