import type { FastifyInstance, FastifyRequest } from "fastify";

import type { AccessContext, DataContextRunner } from "@moss/db";
import { HttpError } from "@moss/module-sdk";
import {
  getFamilyKeysRouteSchema,
  putFamilyKeyRouteSchema,
  rotateFamilyKeyRouteSchema,
  type FamilyKeyStatusDto
} from "@moss/shared";

import {
  familyByName,
  generateFamilyKey,
  getFamilyKeyStatus,
  rotateFamilyKey,
  type FamilyKeyStore
} from "./master-key-store.js";
import type { SettingsRepository } from "./repository.js";
import { handleSettingsRouteError } from "./route-error.js";
import { assertAdminUser } from "./routes.js";

export interface FamilyKeyRoutesDependencies {
  readonly dataContext: DataContextRunner;
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  readonly repository: SettingsRepository;
  /** Optional hook fired after generate/rotate so keyed provider caches can clear. */
  readonly onKeyChanged?: () => void;
}

function requireRequestId(accessContext: AccessContext): string {
  if (!accessContext.requestId) {
    throw new HttpError(500, "Request id is missing");
  }
  return accessContext.requestId;
}

/**
 * Admin-only routes for family encryption keys (master key store, #2312). Keys are
 * AES-256-GCM encrypted at rest and never returned — every response carries only
 * `{ keys: [{ family, source }] }`. Admin is asserted inside the same
 * `withDataContext` transaction as the read/write.
 */
export function registerFamilyKeyRoutes(
  server: FastifyInstance,
  dependencies: FamilyKeyRoutesDependencies
): void {
  const { dataContext, resolveAccessContext, repository } = dependencies;
  const store: FamilyKeyStore = repository;

  server.get(
    "/api/admin/settings/encryption-keys",
    { schema: getFamilyKeysRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await resolveAccessContext(request);
        const keys = await dataContext.withDataContext(accessContext, async (scopedDb) => {
          await assertAdminUser(repository, scopedDb, accessContext.actorUserId);
          return getFamilyKeyStatus(scopedDb);
        });
        return { keys: keys satisfies FamilyKeyStatusDto[] };
      } catch (error) {
        return handleSettingsRouteError(error, reply);
      }
    }
  );

  server.put(
    "/api/admin/settings/encryption-keys",
    { schema: putFamilyKeyRouteSchema },
    async (request, reply) => {
      try {
        const body = request.body as { family?: unknown };
        const family = typeof body?.family === "string" ? familyByName(body.family) : null;
        if (!family) return reply.status(404).send({ error: "Unknown key family" });
        const accessContext = await resolveAccessContext(request);
        const keys = await dataContext.withDataContext(accessContext, async (scopedDb) => {
          await assertAdminUser(repository, scopedDb, accessContext.actorUserId);
          await generateFamilyKey(scopedDb, store, {
            family,
            actorUserId: accessContext.actorUserId,
            requestId: requireRequestId(accessContext)
          });
          return getFamilyKeyStatus(scopedDb);
        });
        dependencies.onKeyChanged?.();
        return { keys: keys satisfies FamilyKeyStatusDto[] };
      } catch (error) {
        return handleSettingsRouteError(error, reply);
      }
    }
  );

  server.post(
    "/api/admin/settings/encryption-keys/rotate",
    { schema: rotateFamilyKeyRouteSchema },
    async (request, reply) => {
      try {
        const body = request.body as { family?: unknown };
        const family = typeof body?.family === "string" ? familyByName(body.family) : null;
        if (!family) return reply.status(404).send({ error: "Unknown key family" });
        const accessContext = await resolveAccessContext(request);
        const keys = await dataContext.withDataContext(accessContext, async (scopedDb) => {
          await assertAdminUser(repository, scopedDb, accessContext.actorUserId);
          await rotateFamilyKey(scopedDb, store, {
            family,
            actorUserId: accessContext.actorUserId,
            requestId: requireRequestId(accessContext)
          });
          return getFamilyKeyStatus(scopedDb);
        });
        dependencies.onKeyChanged?.();
        return { keys: keys satisfies FamilyKeyStatusDto[] };
      } catch (error) {
        return handleSettingsRouteError(error, reply);
      }
    }
  );
}
