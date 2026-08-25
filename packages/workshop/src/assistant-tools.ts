import { HttpError } from "@moss/module-sdk";
import type { ToolExecute, ToolResult, ToolServices } from "@moss/module-sdk";

/**
 * The plan the build planner produced. Structurally identical to `ModuleBuildPlan` in @moss/ai —
 * restated here so the workshop module does not import another module's internals (module
 * isolation). The shape is pinned by `moduleBuildPlanSchema` in @moss/shared, which both sides use.
 */
export interface WorkshopModuleBuildPlan {
  readonly whatItDoes: string;
  readonly whatItReaches: readonly string[];
  readonly whatItKeeps: string;
  readonly whenItRuns: string;
  readonly roughCost: { readonly time: string; readonly budgetCents: number };
}

export interface WorkshopModuleBuildStartResult {
  readonly buildId: string;
  readonly plan: WorkshopModuleBuildPlan;
  readonly awaitingApproval: boolean;
}

/**
 * The host-built service behind `workshop.buildModule`. The workshop module declares that it needs
 * this and never constructs it: the composition host (chat's gateway services) owns the database
 * handles, the queue, and the admin check. Declared in the tool's `requiresServices`, so the
 * gateway hides the tool entirely on any surface where the host did not provide the service.
 */
export interface ModuleBuildStartService {
  start(
    scopedDb: unknown,
    input: {
      readonly actorUserId: string;
      readonly chatSessionId: string;
      readonly description: string;
      readonly conversationExcerpt: string;
    }
  ): Promise<WorkshopModuleBuildStartResult>;
}

export const MODULE_BUILD_START_SERVICE_KEY = "moduleBuildStart";

function getStartService(services: ToolServices | undefined): ModuleBuildStartService {
  const service = services?.[MODULE_BUILD_START_SERVICE_KEY] as ModuleBuildStartService | undefined;
  if (!service || typeof service.start !== "function") {
    // Fail closed. The gateway should already have hidden the tool (requiresServices), so reaching
    // here means a mis-wired host, not a user error.
    throw new HttpError(503, "Building a module is not available on this surface.");
  }
  return service;
}

/**
 * Start a module build from chat and hand back the plan for the user to approve.
 *
 * This never installs or ships anything: it writes a plan and parks the build at
 * `awaiting_plan_approval`. The plan card's "Build it" button is the moment work actually starts.
 */
export const workshopBuildModuleExecute: ToolExecute = async (
  scopedDb,
  input,
  ctx,
  services
): Promise<ToolResult> => {
  const raw = input as { description?: unknown; conversationExcerpt?: unknown };
  if (typeof raw.description !== "string" || raw.description.trim().length === 0) {
    throw new HttpError(400, "description must be a non-empty string");
  }
  const excerpt = typeof raw.conversationExcerpt === "string" ? raw.conversationExcerpt : "";

  const result = await getStartService(services).start(scopedDb, {
    actorUserId: ctx.actorUserId,
    chatSessionId: ctx.chatSessionId,
    description: raw.description.trim(),
    conversationExcerpt: excerpt
  });

  return {
    data: {
      buildId: result.buildId,
      awaitingApproval: result.awaitingApproval,
      plan: result.plan
    }
  };
};
