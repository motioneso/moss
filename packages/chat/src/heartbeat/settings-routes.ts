import type { FastifyInstance, FastifyRequest } from "fastify";

import type { AccessContext, DataContextRunner, PreferencesPort } from "@moss/db";
import { HttpError } from "@moss/module-sdk";
import { ACT_AS_GRANT_HEADER } from "@moss/module-sdk/server";
import {
  createHeartbeatMuteRouteSchema,
  deleteHeartbeatMuteRouteSchema,
  getHeartbeatSettingsRouteSchema,
  getHeartbeatStatusRouteSchema,
  listHeartbeatMutesRouteSchema,
  putHeartbeatSettingsRouteSchema,
  type CreateHeartbeatMuteRequest,
  type PutHeartbeatSettingsRequest
} from "@moss/shared";

import { handleRouteError } from "../route-errors.js";
import { resolveHeartbeatSettings } from "./enrollment.js";
import { resolveHeartbeatMute } from "./mute-command.js";
import { HeartbeatMuteRepository } from "./mute-repository.js";
import { HeartbeatSettingsRepository } from "./settings-repository.js";
import { HeartbeatOccurrenceRepository } from "./status-repository.js";

export interface HeartbeatRouteDependencies {
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  readonly dataContext: DataContextRunner;
  readonly preferences: PreferencesPort;
}

function assertOwnerSession(request: FastifyRequest): void {
  if (request.headers[ACT_AS_GRANT_HEADER] !== undefined) {
    throw new HttpError(403, "Change check-in settings in Settings.");
  }
}

export function registerHeartbeatRoutes(
  server: FastifyInstance,
  dependencies: HeartbeatRouteDependencies
): void {
  const settings = new HeartbeatSettingsRepository();
  const occurrences = new HeartbeatOccurrenceRepository();
  const mutes = new HeartbeatMuteRepository();
  const repositories = { settings, preferences: dependencies.preferences };

  server.get(
    "/api/me/heartbeat/settings",
    { schema: getHeartbeatSettingsRouteSchema },
    async (request, reply) => {
      try {
        const access = await dependencies.resolveAccessContext(request);
        const stored = await dependencies.dataContext.withDataContext(access, (db) =>
          resolveHeartbeatSettings(db, repositories)
        );
        return { settings: stored.settings, readable: stored.readable };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.put<{ Body: PutHeartbeatSettingsRequest }>(
    "/api/me/heartbeat/settings",
    { schema: putHeartbeatSettingsRouteSchema },
    async (request, reply) => {
      try {
        const access = await dependencies.resolveAccessContext(request);
        assertOwnerSession(request);
        const { expectedRevision, ...input } = request.body;
        const result = await dependencies.dataContext.withDataContext(access, (db) =>
          settings.save(db, input, expectedRevision)
        );
        if (result.kind === "conflict") {
          return reply.code(409).send({
            error: "Check-in settings were changed somewhere else.",
            settings: result.settings
          });
        }
        return { settings: result.settings };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.get(
    "/api/me/heartbeat/status",
    { schema: getHeartbeatStatusRouteSchema },
    async (request, reply) => {
      try {
        const access = await dependencies.resolveAccessContext(request);
        const status = await dependencies.dataContext.withDataContext(access, async (db) =>
          occurrences.status(db, await resolveHeartbeatSettings(db, repositories))
        );
        return { status };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.get(
    "/api/me/heartbeat/mutes",
    { schema: listHeartbeatMutesRouteSchema },
    async (request, reply) => {
      try {
        const access = await dependencies.resolveAccessContext(request);
        return {
          mutes: await dependencies.dataContext.withDataContext(access, (db) => mutes.list(db))
        };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.post<{ Body: CreateHeartbeatMuteRequest }>(
    "/api/me/heartbeat/mutes",
    { schema: createHeartbeatMuteRouteSchema },
    async (request, reply) => {
      try {
        const access = await dependencies.resolveAccessContext(request);
        assertOwnerSession(request);
        const result = await dependencies.dataContext.withDataContext(access, (db) =>
          resolveHeartbeatMute(db, { findingId: request.body.findingId }, mutes)
        );
        if (result.status !== "muted") throw new HttpError(404, "That check-in item is gone.");
        return { mute: result.mute };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.delete<{ Params: { id: string } }>(
    "/api/me/heartbeat/mutes/:id",
    { schema: deleteHeartbeatMuteRouteSchema },
    async (request, reply) => {
      try {
        const access = await dependencies.resolveAccessContext(request);
        assertOwnerSession(request);
        const removed = await dependencies.dataContext.withDataContext(access, (db) =>
          mutes.remove(db, request.params.id)
        );
        if (!removed) throw new HttpError(404, "That muted topic is already gone.");
        return { ok: true };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );
}
