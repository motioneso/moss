import type { PgBoss } from "pg-boss";

import type { DataContextDb } from "@moss/db";
import { HttpError } from "@moss/module-sdk";
import {
  createAiSecretCipher,
  startModuleBuild,
  writeModuleBuildPlan,
  generateStructured,
  type AiRepository
} from "@moss/ai";
import { MODULE_BUILD_QUEUE, sendJob } from "@moss/jobs";
import {
  SettingsRepository,
  createModuleBuild,
  updateModuleBuildPlan,
  updateModuleBuildStatus
} from "@moss/settings";
import type { ModuleBuildStartService } from "@moss/workshop";

import { createCliStructuredAdapterFactory } from "./live/cli-structured-adapter.js";

// The gateway hands a tool a `chatSessionId` that identifies the SURFACE, not a row: on the chat
// drawer it is literally "<userId>:drawer". `module_builds.conversation_id` is a uuid column, so
// passing that straight through makes the insert throw and the whole tool call fail — which is
// exactly what happened the first time this ran against a live instance. Store it only when it is
// a real id; the column is nullable, and a build with no conversation link is correct and honest.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function asConversationId(chatSessionId: string): string | undefined {
  return UUID_PATTERN.test(chatSessionId) ? chatSessionId : undefined;
}

export interface ModuleBuildStartServiceDeps {
  readonly boss: PgBoss;
  readonly aiRepository: AiRepository;
  /** Same three-gate YOLO check every other auto-approved action uses. */
  readonly isYoloActive: (scopedDb: DataContextDb) => Promise<boolean>;
  /** Overridable only so a test can exercise the admin rule without a database. */
  readonly isInstanceAdmin?: (scopedDb: DataContextDb, userId: string) => Promise<boolean>;
}

/**
 * Builds the `moduleBuildStart` tool service behind `workshop.buildModule`.
 *
 * Admin-only is enforced HERE, in code, not by the manifest. A manifest permission's `scope:
 * "admin"` does not gate tool visibility — the active-modules resolver only filters on the
 * per-instance/per-user disable rows — so without this check any signed-in user could ask Moss to
 * build a module. Building a module writes code into the instance, which is an instance-wide act.
 */
export function buildModuleBuildStartService(
  deps: ModuleBuildStartServiceDeps
): ModuleBuildStartService {
  const cipher = createAiSecretCipher();
  const createCliStructuredAdapter = createCliStructuredAdapterFactory();
  const settings = new SettingsRepository();
  const isInstanceAdmin =
    deps.isInstanceAdmin ??
    (async (db: DataContextDb, userId: string) =>
      (await settings.getUserById(db, userId))?.is_instance_admin === true);

  return {
    async start(scopedDb, input) {
      const db = scopedDb as DataContextDb;

      if (!(await isInstanceAdmin(db, input.actorUserId))) {
        throw new HttpError(403, "Only an administrator can have Moss build a new module.");
      }

      return startModuleBuild(
        {
          writeModuleBuildPlan: (planInput) =>
            writeModuleBuildPlan(
              db,
              {
                generateStructured,
                generateStructuredDeps: {
                  repository: deps.aiRepository,
                  cipher,
                  createCliStructuredAdapter
                }
              },
              planInput
            ),
          createModuleBuild: async (createInput) =>
            createModuleBuild(db, {
              ownerUserId: createInput.ownerUserId,
              conversationId: createInput.conversationId
            }),
          updateModuleBuildPlan: (buildId, plan) => updateModuleBuildPlan(db, buildId, plan),
          updateModuleBuildStatus: (buildId, status) =>
            updateModuleBuildStatus(db, buildId, { status }),
          isYoloActiveForActor: () => deps.isYoloActive(db),
          sendBuildJob: async (buildId, actorUserId) => {
            await sendJob(
              deps.boss,
              MODULE_BUILD_QUEUE,
              { buildId, actorUserId },
              { singletonKey: `build:${buildId}` }
            );
          }
        },
        {
          actorUserId: input.actorUserId,
          conversationId: asConversationId(input.chatSessionId),
          description: input.description,
          conversationExcerpt: input.conversationExcerpt
        }
      );
    }
  };
}
