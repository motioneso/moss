export type AiActionPolicyTier = "ask_each_time" | "trusted_auto" | "always_confirm";

export interface AiActionPolicyDto {
  readonly moduleId: string;
  readonly actionFamilyId: string;
  readonly tier: AiActionPolicyTier;
}

export interface GetAiActionPoliciesResponse {
  readonly policies: readonly AiActionPolicyDto[];
}

export interface PatchAiActionPolicyRequest {
  readonly tier: AiActionPolicyTier;
}

export type PatchAiActionPolicyResponse = AiActionPolicyDto;

export const aiActionPolicyDtoSchema = {
  type: "object",
  additionalProperties: false,
  required: ["moduleId", "actionFamilyId", "tier"],
  properties: {
    moduleId: { type: "string" },
    actionFamilyId: { type: "string" },
    tier: { type: "string", enum: ["ask_each_time", "trusted_auto", "always_confirm"] }
  }
} as const;

export const getAiActionPoliciesResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["policies"],
  properties: {
    policies: { type: "array", items: aiActionPolicyDtoSchema }
  }
} as const;

export const patchAiActionPolicyRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["tier"],
  properties: {
    tier: { type: "string", enum: ["ask_each_time", "trusted_auto", "always_confirm"] }
  }
} as const;

export const patchAiActionPolicyResponseSchema = aiActionPolicyDtoSchema;
