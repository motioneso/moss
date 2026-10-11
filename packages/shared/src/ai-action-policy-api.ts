export type AiActionFreedom = "routine" | "new";

export type AiActionPolicyTier = "ask_each_time" | "trusted_auto" | "always_confirm";

export interface AiActionPolicyDto {
  readonly moduleId: string;
  readonly actionFamilyId: string;
  readonly tier: AiActionPolicyTier;
  /** Freedom tag of the family, when its module declares one. */
  readonly freedom?: AiActionFreedom;
}

export interface PostAiActionFreedomRequest {
  readonly step: 1 | 2 | 3;
}

export interface PostAiActionFreedomResponse {
  readonly moduleId: string;
  readonly step: 1 | 2 | 3;
  readonly policies: readonly AiActionPolicyDto[];
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
    tier: { type: "string", enum: ["ask_each_time", "trusted_auto", "always_confirm"] },
    freedom: { type: "string", enum: ["routine", "new"] }
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

export const postAiActionFreedomRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["step"],
  properties: {
    step: { type: "integer", enum: [1, 2, 3] }
  }
} as const;

export const postAiActionFreedomResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["moduleId", "step", "policies"],
  properties: {
    moduleId: { type: "string" },
    step: { type: "integer", enum: [1, 2, 3] },
    policies: { type: "array", items: aiActionPolicyDtoSchema }
  }
} as const;
