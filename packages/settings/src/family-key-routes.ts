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
  invalidateFamilyKeyCache,
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
        const familyName = typeof body?.family === "string" ? body.family : null;
        // Pure lookup only — the 404 for an unknown name is thrown after the
        // identity check below, so callers learn nothing from 401 vs 404.
        const family = familyName ? familyByName(familyName) : null;
        const accessContext = await resolveAccessContext(request);
        const keys = await dataContext.withDataContext(accessContext, async (scopedDb) => {
          await assertAdminUser(repository, scopedDb, accessContext.actorUserId);
          if (!family) {
            throw new HttpError(404, "Unknown key family");
          }
          await generateFamilyKey(scopedDb, store, {
            family,
            actorUserId: accessContext.actorUserId,
            requestId: requireRequestId(accessContext)
          });
          return getFamilyKeyStatus(scopedDb);
        });
        // Caches clear after the write commits, never inside it: a request landing
        // in between would otherwise reload the old key and keep it.
        if (family) invalidateFamilyKeyCache(family);
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
        const familyName = typeof body?.family === "string" ? body.family : null;
        // Pure lookup only — the 404 is thrown after identity (see generate above).
        const family = familyName ? familyByName(familyName) : null;
        const accessContext = await resolveAccessContext(request);
        const keys = await dataContext.withDataContext(accessContext, async (scopedDb) => {
          await assertAdminUser(repository, scopedDb, accessContext.actorUserId);
          if (!family) {
            throw new HttpError(404, "Unknown key family");
          }
          await rotateFamilyKey(scopedDb, store, {
            family,
            actorUserId: accessContext.actorUserId,
            requestId: requireRequestId(accessContext)
          });
          return getFamilyKeyStatus(scopedDb);
        });
        // Caches clear after the write commits, never inside it (see generate above).
        if (family) invalidateFamilyKeyCache(family);
        dependencies.onKeyChanged?.();
        return { keys: keys satisfies FamilyKeyStatusDto[] };
      } catch (error) {
        return handleSettingsRouteError(error, reply);
      }
    }
  );
}
