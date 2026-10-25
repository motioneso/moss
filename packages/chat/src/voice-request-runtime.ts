import { sql } from "kysely";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AccessContext, DataContextRunner } from "@moss/db";
import type { ActiveModulesResolver } from "@moss/ai";
import type { PgBoss } from "@moss/jobs";
import { HttpError } from "@moss/module-sdk";
import { CHAT_PROCESS_BOOT_ID } from "./live-turns.js";
import type { ChatSessionRuntime } from "./live/runtime.js";
import { VoiceRequestService } from "./voice-request-service.js";
import { createVoiceRequestScheduler } from "./voice-request-jobs.js";
import { registerVoiceRequestRoutes } from "./voice-request-routes.js";

export function registerVoiceRequestRuntime(
  server: FastifyInstance,
  deps: {
    readonly dataContext: DataContextRunner;
    readonly boss?: PgBoss;
    readonly resolveActiveModules?: ActiveModulesResolver;
    readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
    readonly resolveRingRecordingAccessContext?: (
      request: FastifyRequest
    ) => Promise<AccessContext>;
    readonly adoptVoiceRequestService?: (service: VoiceRequestService) => void;
  },
  runtime: ChatSessionRuntime
) {
  if (!deps.boss) return;
  const service = createVoiceRequestService({
    dataContext: deps.dataContext,
    boss: deps.boss,
    runtime,
    resolveActiveModules: deps.resolveActiveModules
  });
  deps.adoptVoiceRequestService?.(service);
  registerVoiceRequestRoutes(server, {
    service,
    resolveRingRecordingAccessContext: deps.resolveRingRecordingAccessContext,
    resolveAccessContext: deps.resolveAccessContext
  });
}

export function createVoiceRequestService(deps: {
  readonly dataContext: DataContextRunner;
  readonly boss: PgBoss;
  readonly runtime: ChatSessionRuntime;
  readonly resolveActiveModules?: ActiveModulesResolver;
}) {
  return new VoiceRequestService({
    dataContext: deps.dataContext,
    bootId: CHAT_PROCESS_BOOT_ID,
    now: () => new Date(),
    schedule: createVoiceRequestScheduler(deps.boss),
    async assertAvailable(actor) {
      const owner = await deps.dataContext.withDataContext(
        actor,
        async (db) =>
          (
            await sql<{
              status: string;
            }>`SELECT status FROM app.get_user_by_id(${actor.actorUserId}::uuid)`.execute(db.db)
          ).rows[0]
      );
      if (owner?.status !== "active") throw new HttpError(403, "Voice request owner unavailable");
      if (
        deps.resolveActiveModules &&
        !(await deps.resolveActiveModules(actor.actorUserId)).some((module) => module.id === "chat")
      )
        throw new HttpError(404, "Chat unavailable");
    },
    async submit(actor, request, claim, whenAvailable) {
      const userName = await deps.runtime.resolveUserName(actor.actorUserId);
      return deps.runtime.manager.submitMainVoiceTurn(
        actor.actorUserId,
        userName,
        request.transcript,
        request,
        claim,
        whenAvailable
      );
    }
  });
}
