import { aiModelTierSchema } from "./ai-api.js";
import { errorResponseSchema } from "./schema-fragments.js";

// #915 D6: the per-service AI binding wire schemas, split out of ai-api.ts to keep that file
// under the 1000-line source cap (same precedent as ai-voice-api.ts). Widened for module service
// keys: "chat" stays the only user-facing service; "module.worker" / "module.<moduleId>" are
// admin routing knobs for structured module work (always capability "json").

// #870 Slice 1: a per-service binding is a discriminated union — a tier "mode" OR a specific model.
export const aiServiceBindingSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "tier"],
      properties: {
        kind: { type: "string", enum: ["mode"] },
        tier: aiModelTierSchema
      }
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "modelId"],
      properties: {
        kind: { type: "string", enum: ["model"] },
        modelId: { type: "string", format: "uuid" }
      }
    }
  ]
} as const;

// #874 HIGH-2: Chat is the only bindable user-facing capability. Voice/transcription is configured
// separately. #915 D6 adds module.* admin binding keys, and #2594 adds the reserved `sorting` key;
// other worker capabilities stay automatic.
export const aiServiceParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["service"],
  properties: {
    // Keep module part in sync with MODULE_SERVICE_KEY_PATTERN (ai-types.ts).
    service: { type: "string", pattern: "^(chat|sorting|module\\.[a-z0-9][a-z0-9_.-]{0,63})$" }
  }
} as const;

export const aiServiceBindingMapSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    chat: aiServiceBindingSchema,
    sorting: aiServiceBindingSchema
  },
  // Dynamic keys must be declared or fast-json-stringify silently strips them (#859/#885).
  patternProperties: {
    // Character class is equivalent to `\.` and avoids fast-json-stringify's broken ref path.
    "^module[.]": aiServiceBindingSchema
  }
} as const;

export const listAiServiceBindingsResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["bindings"],
  properties: {
    bindings: aiServiceBindingMapSchema
  }
} as const;

export const putAiServiceBindingRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["binding"],
  properties: {
    binding: aiServiceBindingSchema
  }
} as const;

export const putAiServiceBindingResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["service", "binding"],
  properties: {
    service: { type: "string" },
    binding: aiServiceBindingSchema
  }
} as const;

export const deleteAiServiceBindingResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["service"],
  properties: {
    service: { type: "string" }
  }
} as const;

export const listAiServiceBindingsRouteSchema = {
  response: {
    200: listAiServiceBindingsResponseSchema,
    401: errorResponseSchema
  }
} as const;

export const putAiServiceBindingRouteSchema = {
  params: aiServiceParamsSchema,
  body: putAiServiceBindingRequestSchema,
  response: {
    200: putAiServiceBindingResponseSchema,
    400: errorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema
  }
} as const;

// #915 D6: unbind response — the service returns to automatic routing.
export const deleteAiServiceBindingRouteSchema = {
  params: aiServiceParamsSchema,
  response: {
    200: deleteAiServiceBindingResponseSchema,
    400: errorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema
  }
} as const;
