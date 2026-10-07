import { isDeepStrictEqual, types as nodeUtilTypes } from "node:util";

import type { DataContextDb, DataContextRunner } from "@moss/db";
import { isUuid } from "@moss/db";
import type {
  ActiveModulesResolver,
  PerCallExecutor,
  PerCallResolution,
  PerCallResolver,
  PerCallServices
} from "@moss/ai";
import {
  MemoryForgetService,
  memoryForgetExecute,
  type MemoryForgetToolService
} from "@moss/memory";
import { HttpError, type MossModuleManifest, type ToolContext } from "@moss/module-sdk";

class MemoryForgetRefusal extends HttpError {
  constructor(kind: "not_ready" | "changed" | "consent_off") {
    super(
      kind === "not_ready" ? 503 : 409,
      {
        not_ready: "Memory deletion is not ready. Start a new chat and try again.",
        changed:
          "The memory changed or is no longer available. Find it again and review a new request.",
        consent_off:
          "Memory AI consent is off. Review it in Settings before requesting this action again."
      }[kind]
    );
  }
}

/** Live-only owner target snapshots and single-use capabilities; no memory text is persisted. */
export function createMemoryForgetBoundary(deps: {
  runner: Pick<DataContextRunner, "withDataContext">;
  resolveActiveModules: ActiveModulesResolver;
}) {
  const memory = new MemoryForgetService();
  const activeMemory = async (ctx: ToolContext) =>
    (await deps.resolveActiveModules(ctx.actorUserId)).find((module) => module.id === "memory");
  const consentGranted = async (
    module: MossModuleManifest,
    db: DataContextDb,
    actorUserId: string
  ) => !module.aiConsent || (await module.aiConsent.isGranted(db, actorUserId));

  const resolver: PerCallResolver = async (input, ctx) => {
    if (typeof input.factId !== "string" || !isUuid(input.factId))
      return { kind: "refuse", reason: "unknown_route" };
    const module = await activeMemory(ctx);
    if (!module) return { kind: "refuse", reason: "unknown_route" };
    return deps.runner.withDataContext(
      { actorUserId: ctx.actorUserId, requestId: ctx.requestId },
      async (db): Promise<PerCallResolution> => {
        if (!(await consentGranted(module, db, ctx.actorUserId)))
          return { kind: "refuse", reason: "consent_off" };
        const target = await memory.target(db, ctx.actorUserId, input.factId as string);
        if (!target) return { kind: "refuse", reason: "unknown_route" };
        return {
          kind: "proceed",
          risk: "destructive",
          externalContent: true,
          forceConfirm: true,
          confirmWhenTainted: false,
          summary: "Forget saved memory",
          requiresTarget: true,
          targetVersion: target.version,
          details: { target: target.label, fields: [] },
          affectsModules: ["memory"]
        };
      }
    );
  };

  const bindServices: PerCallServices = (input, ctx, resolution) => {
    let consumed = false;
    return {
      memoryForget: {
        async forget(factId, caller) {
          if (
            consumed ||
            !isDeepStrictEqual(input, { factId }) ||
            !isDeepStrictEqual(ctx, caller) ||
            !resolution.targetVersion ||
            !resolution.details.target
          )
            throw new MemoryForgetRefusal("changed");
          consumed = true;
          try {
            const module = await activeMemory(ctx);
            if (!module) throw new MemoryForgetRefusal("changed");
            return await deps.runner.withDataContext(
              { actorUserId: ctx.actorUserId, requestId: ctx.requestId },
              async (db) => {
                if (!(await consentGranted(module, db, ctx.actorUserId))) {
                  throw new MemoryForgetRefusal("consent_off");
                }
                if (
                  !(await memory.forgetApproved(
                    db,
                    ctx.actorUserId,
                    factId,
                    resolution.targetVersion!
                  ))
                )
                  throw new MemoryForgetRefusal("changed");
                return { deleted: true as const };
              }
            );
          } catch (error) {
            if (nodeUtilTypes.isNativeError(error) && error instanceof MemoryForgetRefusal)
              throw error;
            throw new MemoryForgetRefusal("not_ready");
          }
        }
      } satisfies MemoryForgetToolService
    };
  };
  const execute: PerCallExecutor = (input, ctx, _resolution, services) =>
    memoryForgetExecute(undefined, input, ctx, services);
  const unavailable: MemoryForgetToolService = {
    forget: async () => {
      throw new MemoryForgetRefusal("not_ready");
    }
  };
  return { resolver, bindServices, execute, unavailable };
}
