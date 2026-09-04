import { HttpError } from "@moss/module-sdk";
import {
  AI_MODEL_CAPABILITIES,
  type AiConfiguredModelDto,
  type AiModelCapability
} from "@moss/shared";

import type { AiConfiguredModelSafeRow } from "./repository.js";

const MODEL_CAPABILITIES = new Set<AiModelCapability>(AI_MODEL_CAPABILITIES);

/**
 * Row -> DTO for a configured model. Lives outside routes.ts so provider-validation-routes.ts
 * (#2208 refresh route) can use it without importing routes.ts back (routes.ts imports that file).
 * Non-owners see the model through the instance-default lens: provider ids and the raw model id
 * are hidden.
 */
export function serializeModel(
  model: AiConfiguredModelSafeRow,
  actorUserId: string
): AiConfiguredModelDto {
  const isOwner = model.owner_user_id === actorUserId;
  const displayProviderName = isOwner ? model.provider_display_name : "Instance default";
  return {
    id: model.id,
    providerConfigId: isOwner ? model.provider_config_id : null,
    providerKind: isOwner ? model.provider_kind : null,
    providerDisplayName: displayProviderName,
    providerStatus: model.provider_status,
    providerModelId: isOwner ? model.provider_model_id : null,
    displayName: model.display_name,
    capabilities: model.capabilities.map(parseCapability),
    status: model.status,
    tier: model.tier,
    allowUserOverride: model.allow_user_override,
    origin: model.origin,
    createdAt: serializeDate(model.created_at),
    updatedAt: serializeDate(model.updated_at)
  };
}

function parseCapability(value: string): AiModelCapability {
  if (MODEL_CAPABILITIES.has(value as AiModelCapability)) {
    return value as AiModelCapability;
  }

  throw new HttpError(400, "capability is not supported");
}

function serializeDate(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
