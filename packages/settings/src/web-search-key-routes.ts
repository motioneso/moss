import type { FastifyInstance, FastifyRequest } from "fastify";

import type { AccessContext, DataContextRunner } from "@moss/db";
import { HttpError } from "@moss/module-sdk";
import {
  deleteWebSearchKeyRouteSchema,
  getWebSearchKeyRouteSchema,
  putWebSearchKeyRouteSchema,
  type PutWebSearchKeyRequest,
  type WebSearchKeyStatusDto
} from "@moss/shared";

import type { SettingsRepository } from "./repository.js";
import { handleSettingsRouteError } from "./route-error.js";
import { assertAdminUser } from "./routes.js";
import {
  clearBraveSearchApiKey,
  getWebSearchKeyConfig,
  setBraveSearchApiKey,
  type WebSearchSecretCipher
} from "./web-search-key.js";
import { setNativeSearchEnabled } from "./web-search-engine-resolver.js";

export interface WebSearchKeyRoutesDependencies {
  readonly dataContext: DataContextRunner;
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  readonly repository: SettingsRepository;
  readonly cipher: WebSearchSecretCipher;
  /** Optional hook fired after a save/revoke so the provider cache can be invalidated. */
  readonly onKeyChanged?: () => void;
}

function requireRequestId(accessContext: AccessContext): string {
  if (!accessContext.requestId) {
    throw new HttpError(500, "Request id is missing");
  }
  return accessContext.requestId;
}

/**
 * Admin-only routes for the instance-wide Brave Search API key. The key is AES-256-GCM
 * encrypted at rest and never returned — GET/PUT/DELETE all respond with `{ status: { configured,
 * source } }` only. Admin is asserted inside the same `withDataContext` transaction as the read/
 * write (RLS also gates instance_settings writes to admins as defense in depth).
 */
export function registerWebSearchKeyRoutes(
  server: FastifyInstance,
  dependencies: WebSearchKeyRoutesDependencies
): void {
  const { dataContext, resolveAccessContext, repository, cipher } = dependencies;

  server.get(
    "/api/admin/settings/web-search",
    { schema: getWebSearchKeyRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await resolveAccessContext(request);
        const status = await dataContext.withDataContext(accessContext, async (scopedDb) => {
          await assertAdminUser(repository, scopedDb, accessContext.actorUserId);
          return getWebSearchKeyConfig(scopedDb);
        });
        return { status: status satisfies WebSearchKeyStatusDto };
      } catch (error) {
        return handleSettingsRouteError(error, reply);
      }
    }
  );

  server.put(
    "/api/admin/settings/web-search",
    { schema: putWebSearchKeyRouteSchema },
    async (request, reply) => {
      try {
        const body = request.body as PutWebSearchKeyRequest;
        const hasApiKey = typeof body?.apiKey === "string";
        const hasNativeEnabled = typeof body?.nativeSearchEnabled === "boolean";
        if (!hasApiKey && !hasNativeEnabled) {
          return reply
            .status(400)
            .send({ error: "Either apiKey or nativeSearchEnabled must be provided" });
        }
        if (hasApiKey && body.apiKey!.trim().length === 0) {
          return reply.status(400).send({ error: "API key must not be empty" });
        }
        const accessContext = await resolveAccessContext(request);
        const status = await dataContext.withDataContext(accessContext, async (scopedDb) => {
          await assertAdminUser(repository, scopedDb, accessContext.actorUserId);
          const reqId = requireRequestId(accessContext);
          if (hasApiKey) {
            await setBraveSearchApiKey(scopedDb, repository, cipher, {
              apiKey: body.apiKey!.trim(),
              actorUserId: accessContext.actorUserId,
              requestId: reqId
            });
          }
          if (hasNativeEnabled) {
            await setNativeSearchEnabled(scopedDb, repository, {
              enabled: body.nativeSearchEnabled!,
              actorUserId: accessContext.actorUserId,
              requestId: reqId
            });
          }
          return getWebSearchKeyConfig(scopedDb);
        });
        dependencies.onKeyChanged?.();
        return { status: status satisfies WebSearchKeyStatusDto };
      } catch (error) {
        return handleSettingsRouteError(error, reply);
      }
    }
  );

  server.delete(
    "/api/admin/settings/web-search",
    { schema: deleteWebSearchKeyRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await resolveAccessContext(request);
        const status = await dataContext.withDataContext(accessContext, async (scopedDb) => {
          await assertAdminUser(repository, scopedDb, accessContext.actorUserId);
          await clearBraveSearchApiKey(scopedDb, repository, {
            actorUserId: accessContext.actorUserId,
            requestId: requireRequestId(accessContext)
          });
          return getWebSearchKeyConfig(scopedDb);
        });
        dependencies.onKeyChanged?.();
        return { status: status satisfies WebSearchKeyStatusDto };
      } catch (error) {
        return handleSettingsRouteError(error, reply);
      }
    }
  );
}
