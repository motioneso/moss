import type { FastifyInstance } from "fastify";
import type { MossActionPermissionTier } from "@moss/module-sdk";
import { handleRouteError, HttpError } from "@moss/module-sdk";
import {
  getAiActionPoliciesResponseSchema,
  patchAiActionPolicyRequestSchema,
  patchAiActionPolicyResponseSchema,
  postAiActionFreedomRequestSchema,
  postAiActionFreedomResponseSchema
} from "@moss/shared";

import type { AiRepository } from "./repository.js";
import type { AiRoutesDependencies } from "./routes.js";

interface PatchRequest {
  readonly Body: {
    readonly tier: MossActionPermissionTier;
  };
  readonly Params: {
    readonly moduleId: string;
    readonly actionFamilyId: string;
  };
}

interface FreedomRequest {
  readonly Body: {
    readonly step: 1 | 2 | 3;
  };
  readonly Params: {
    readonly moduleId: string;
  };
}

/** Tier each freedom tag takes at each preset step. */
const FREEDOM_PRESETS: Record<
  "routine" | "new",
  Record<1 | 2 | 3, "ask_each_time" | "trusted_auto">
> = {
  routine: { 1: "ask_each_time", 2: "trusted_auto", 3: "trusted_auto" },
  new: { 1: "ask_each_time", 2: "ask_each_time", 3: "trusted_auto" }
};

export function registerActionPolicyRoutes(
  server: FastifyInstance,
  dependencies: AiRoutesDependencies,
  repository: AiRepository
): void {
  server.get(
    "/api/ai/action-policy",
    { schema: { response: { 200: getAiActionPoliciesResponseSchema } } },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const activeModules = await dependencies.resolveActiveModules(accessContext.actorUserId);
        const policies = await dependencies.dataContext.withDataContext(
          accessContext,
          async (scopedDb) => {
            const list: {
              moduleId: string;
              actionFamilyId: string;
              tier: MossActionPermissionTier;
              freedom?: "routine" | "new";
            }[] = await repository.listActionPolicies(scopedDb);

            if (dependencies.tasksCompatibility) {
              const tasksTier =
                await dependencies.tasksCompatibility.getResolvedTaskChangesPolicy(scopedDb);
              // Merge or override the tasks policy
              const existing = list.find(
                (p) => p.moduleId === "tasks" && p.actionFamilyId === "task_changes"
              );
              if (existing) {
                existing.tier = tasksTier;
              } else {
                list.push({ moduleId: "tasks", actionFamilyId: "task_changes", tier: tasksTier });
              }
            }
            for (const policy of list) {
              const freedom = activeModules
                .find((m) => m.id === policy.moduleId)
                ?.assistantActionFamilies?.find((f) => f.id === policy.actionFamilyId)?.freedom;
              if (freedom) policy.freedom = freedom;
            }
            return list;
          }
        );
        return { policies };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.patch<PatchRequest>(
    "/api/ai/action-policy/:moduleId/:actionFamilyId",
    {
      schema: {
        body: patchAiActionPolicyRequestSchema,
        response: { 200: patchAiActionPolicyResponseSchema }
      }
    },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const { moduleId, actionFamilyId } = request.params;
        const { tier } = request.body;

        const activeModules = await dependencies.resolveActiveModules(accessContext.actorUserId);
        const module = activeModules.find((m) => m.id === moduleId);
        if (!module) {
          throw new HttpError(404, `Module ${moduleId} is not active or does not exist.`);
        }
        const family = module.assistantActionFamilies?.find((f) => f.id === actionFamilyId);
        if (!family) {
          throw new HttpError(
            404,
            `Action family ${actionFamilyId} not found in module ${moduleId}.`
          );
        }
        if (!family.allowedTiers.includes(tier)) {
          throw new HttpError(
            400,
            `Tier '${tier}' is not allowed for action family ${actionFamilyId}. Allowed tiers: ${family.allowedTiers.join(", ")}`
          );
        }

        await dependencies.dataContext.withDataContext(accessContext, async (scopedDb) => {
          if (
            moduleId === "tasks" &&
            actionFamilyId === "task_changes" &&
            dependencies.tasksCompatibility
          ) {
            await dependencies.tasksCompatibility.setTaskChangesPolicy(scopedDb, tier);
          } else {
            await repository.setActionPolicy(scopedDb, moduleId, actionFamilyId, tier);
          }
        });

        return reply.code(200).send({ moduleId, actionFamilyId, tier });
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  // Writes every freedom-tagged family of one module to a preset step, all or nothing.
  server.post<FreedomRequest>(
    "/api/ai/action-policy/:moduleId/freedom",
    {
      schema: {
        body: postAiActionFreedomRequestSchema,
        response: { 200: postAiActionFreedomResponseSchema }
      }
    },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const { moduleId } = request.params;
        const { step } = request.body;

        const activeModules = await dependencies.resolveActiveModules(accessContext.actorUserId);
        const module = activeModules.find((m) => m.id === moduleId);
        if (!module) {
          throw new HttpError(404, `Module ${moduleId} is not active or does not exist.`);
        }

        // Validate every tagged family before writing any of them.
        const writes: {
          actionFamilyId: string;
          tier: MossActionPermissionTier;
          freedom: "routine" | "new";
        }[] = [];
        for (const family of module.assistantActionFamilies ?? []) {
          if (!family.freedom) continue;
          const tier = FREEDOM_PRESETS[family.freedom][step];
          if (!family.allowedTiers.includes(tier)) {
            throw new HttpError(
              400,
              `Tier '${tier}' is not allowed for action family ${family.id}. Allowed tiers: ${family.allowedTiers.join(", ")}`
            );
          }
          writes.push({ actionFamilyId: family.id, tier, freedom: family.freedom });
        }
        if (writes.length === 0) {
          throw new HttpError(404, `Module ${moduleId} has no freedom-tagged action families.`);
        }

        await dependencies.dataContext.withDataContext(accessContext, async (scopedDb) => {
          for (const write of writes) {
            if (
              moduleId === "tasks" &&
              write.actionFamilyId === "task_changes" &&
              dependencies.tasksCompatibility
            ) {
              await dependencies.tasksCompatibility.setTaskChangesPolicy(scopedDb, write.tier);
            } else {
              await repository.setActionPolicy(
                scopedDb,
                moduleId,
                write.actionFamilyId,
                write.tier
              );
            }
          }
        });

        return reply.code(200).send({
          moduleId,
          step,
          policies: writes.map((w) => ({
            moduleId,
            actionFamilyId: w.actionFamilyId,
            tier: w.tier,
            freedom: w.freedom
          }))
        });
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );
}
