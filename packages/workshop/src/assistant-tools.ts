import { assertUuid } from "@moss/db";
import { HttpError } from "@moss/module-sdk";
import type { ToolExecute, ToolResult, ToolServices } from "@moss/module-sdk";
import type { CreateWorkshopProjectResponse, ModuleBuildPlan } from "@moss/shared";

export type WorkshopModuleBuildPlan = ModuleBuildPlan;
export type WorkshopModuleBuildStartResult = CreateWorkshopProjectResponse;

/** The host attests chat privacy; the shared create service verifies the scoped actor. */
export interface ModuleBuildStartService {
  start(
    scopedDb: unknown,
    input: {
      readonly actorUserId: string;
      readonly chatSessionId: string;
      readonly requestKey: string;
      readonly description: string;
    }
  ): Promise<CreateWorkshopProjectResponse>;
}

export const MODULE_BUILD_START_SERVICE_KEY = "moduleBuildStart";

function getStartService(services: ToolServices | undefined): ModuleBuildStartService {
  const service = services?.[MODULE_BUILD_START_SERVICE_KEY] as ModuleBuildStartService | undefined;
  if (!service || typeof service.start !== "function") {
    throw new HttpError(
      503,
      "Saving a Workshop project is not available on this surface. Open /workshop/new."
    );
  }
  return service;
}

/** Save only the explicit request and return the persisted project's destination. */
export const workshopBuildModuleExecute: ToolExecute = async (
  scopedDb,
  input,
  ctx,
  services
): Promise<ToolResult> => {
  const raw = (input ?? {}) as { description?: unknown; requestKey?: unknown };
  if (
    typeof raw.description !== "string" ||
    raw.description.trim().length === 0 ||
    raw.description.length > 4000 ||
    raw.description.includes("\0")
  ) {
    throw new HttpError(400, "description must be a non-empty string of at most 4000 characters.");
  }
  try {
    if (typeof raw.requestKey !== "string") throw new Error("Missing request key");
    assertUuid(raw.requestKey, "Project request key");
  } catch {
    throw new HttpError(
      400,
      "Provide a UUID requestKey and reuse it when retrying the same project request."
    );
  }

  const result = await getStartService(services).start(scopedDb, {
    actorUserId: ctx.actorUserId,
    chatSessionId: ctx.chatSessionId,
    requestKey: raw.requestKey,
    description: raw.description.trim()
  });
  return { data: { ...result } };
};
