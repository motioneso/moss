// #1754: gate a build behind the same YOLO "stop asking me" setting every other auto-approved
// action already uses. Deps are bound, already-scoped-to-actor async functions (the caller —
// the route/chat wiring — owns the DB context and the queue handle), matching run-build-step.ts's
// injection style so this stays testable without a fake DataContextDb or a real Postgres.
import type { ModuleBuildPlan } from "./write-plan.js";

export interface StartModuleBuildInput {
  readonly actorUserId: string;
  readonly conversationId?: string;
  readonly description: string;
  readonly conversationExcerpt?: string;
}

export interface StartModuleBuildResult {
  readonly buildId: string;
  readonly plan: ModuleBuildPlan;
  readonly awaitingApproval: boolean;
}

export interface StartModuleBuildDeps {
  readonly writeModuleBuildPlan: (input: {
    readonly description: string;
    readonly conversationExcerpt: string;
  }) => Promise<ModuleBuildPlan>;
  readonly createModuleBuild: (input: {
    readonly ownerUserId: string;
    readonly conversationId?: string;
  }) => Promise<{ readonly id: string }>;
  readonly updateModuleBuildPlan: (buildId: string, plan: Record<string, unknown>) => Promise<void>;
  readonly updateModuleBuildStatus: (
    buildId: string,
    status: "awaiting_plan_approval" | "building"
  ) => Promise<void>;
  readonly isYoloActiveForActor: (actorUserId: string) => Promise<boolean>;
  readonly sendBuildJob: (buildId: string, actorUserId: string) => Promise<void>;
}

/**
 * Writes the plan, then checks the same three-gate YOLO composition every other auto-approved
 * action uses (isYoloActiveForActor): active → start building now; inactive → leave the build at
 * `awaiting_plan_approval` and let `approveModuleBuildPlan` (chat's "build it" button) start it.
 */
export async function startModuleBuild(
  deps: StartModuleBuildDeps,
  input: StartModuleBuildInput
): Promise<StartModuleBuildResult> {
  const build = await deps.createModuleBuild({
    ownerUserId: input.actorUserId,
    conversationId: input.conversationId
  });
  const plan = await deps.writeModuleBuildPlan({
    description: input.description,
    conversationExcerpt: input.conversationExcerpt ?? ""
  });
  await deps.updateModuleBuildPlan(build.id, plan as unknown as Record<string, unknown>);

  const yoloActive = await deps.isYoloActiveForActor(input.actorUserId);
  if (yoloActive) {
    await deps.updateModuleBuildStatus(build.id, "building");
    await deps.sendBuildJob(build.id, input.actorUserId);
    return { buildId: build.id, plan, awaitingApproval: false };
  }

  await deps.updateModuleBuildStatus(build.id, "awaiting_plan_approval");
  return { buildId: build.id, plan, awaitingApproval: true };
}

export class ModuleBuildNotFoundError extends Error {
  constructor(buildId: string) {
    super(`module build "${buildId}" not found`);
    this.name = "ModuleBuildNotFoundError";
  }
}

export interface ApproveModuleBuildPlanDeps {
  readonly getModuleBuild: (
    buildId: string
  ) => Promise<{ readonly id: string; readonly ownerUserId: string } | null>;
  readonly updateModuleBuildStatus: (buildId: string, status: "building") => Promise<void>;
  readonly sendBuildJob: (buildId: string, actorUserId: string) => Promise<void>;
}

/**
 * Chat's "build it" button. Ownership-scoped the same way shipExternalModule is: a build that
 * doesn't exist and a build owned by someone else both raise ModuleBuildNotFoundError — no way
 * to distinguish the two from the outside.
 */
export async function approveModuleBuildPlan(
  deps: ApproveModuleBuildPlanDeps,
  buildId: string,
  actorUserId: string
): Promise<void> {
  const build = await deps.getModuleBuild(buildId);
  if (!build || build.ownerUserId !== actorUserId) {
    throw new ModuleBuildNotFoundError(buildId);
  }
  await deps.updateModuleBuildStatus(buildId, "building");
  await deps.sendBuildJob(buildId, actorUserId);
}
