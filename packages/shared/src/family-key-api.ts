import { errorResponseSchema } from "./schema-fragments.js";

/**
 * Admin family-key contract (master key store, #2312 slice 1). Family keys lock
 * stored credentials and NEVER leave the server — responses carry only the family
 * name plus where its key comes from: the environment, the encrypted store row, or
 * nowhere yet (`missing`, meaning the feature is paused for setup).
 */
export type FamilyKeySource = "env" | "store" | "missing" | "broken";

export interface FamilyKeyStatusDto {
  readonly family: string;
  readonly source: FamilyKeySource;
}

export interface GetFamilyKeysResponse {
  readonly keys: FamilyKeyStatusDto[];
}

export interface PutFamilyKeyRequest {
  readonly family: string;
}

export type PutFamilyKeyResponse = GetFamilyKeysResponse;

export interface RotateFamilyKeyRequest {
  readonly family: string;
}

export type RotateFamilyKeyResponse = GetFamilyKeysResponse;

const familyKeyStatusSchema = {
  type: "object",
  additionalProperties: false,
  required: ["family", "source"],
  properties: {
    family: { type: "string" },
    source: { type: "string", enum: ["env", "store", "missing", "broken"] }
  }
} as const;

const statusEnvelopeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["keys"],
  properties: { keys: { type: "array", items: familyKeyStatusSchema } }
} as const;

const familyBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["family"],
  properties: { family: { type: "string", minLength: 1, maxLength: 64 } }
} as const;

export const getFamilyKeysRouteSchema = {
  response: {
    200: statusEnvelopeSchema,
    401: errorResponseSchema,
    403: errorResponseSchema
  }
} as const;

export const putFamilyKeyRouteSchema = {
  body: familyBodySchema,
  response: {
    200: statusEnvelopeSchema,
    400: errorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema
  }
} as const;

export const rotateFamilyKeyRouteSchema = {
  body: familyBodySchema,
  response: {
    200: statusEnvelopeSchema,
    400: errorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema
  }
} as const;
