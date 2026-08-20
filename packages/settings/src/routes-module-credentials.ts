// Module-credential route family (#918 Slice 2). Scope enforcement summary: instance-scope
// slots are reachable ONLY through /api/admin/... (admin-asserted), user-scope slots ONLY
// through /api/me/... (owner-bound) — a slot declared scope:"user" simply does not appear
// on the admin surface and vice versa, and RLS (migration 0153) enforces the same split at
// the database layer even if a route bug slipped. Mirrors routes-modules.ts's shape (ctx
// threading, handleRouteError, admin-authorize-first discipline).
import type { FastifyInstance } from "fastify";

import type { AccessContext, DataContextDb, User } from "@moss/db";
import { HttpError } from "@moss/module-sdk";
import type { ModuleAuthDeclaration } from "@moss/module-sdk";
import {
  listModuleCredentialsRouteSchema,
  revokeModuleCredentialRouteSchema,
  setModuleCredentialRouteSchema,
  type ListModuleCredentialsResponse,
  type ModuleCredentialStatusDto
} from "@moss/shared";

import type { ModuleCredentialCipher } from "./module-credential-crypto.js";
import type { SettingsRepository } from "./repository.js";
import {
  listModuleCredentialMetadata,
  revokeModuleCredential,
  upsertModuleCredential,
  type ModuleCredentialMetadataRow
} from "./repository-module-credentials.js";
import type { ExternalModuleAuditWriter } from "./repository-external-modules.js";
import { handleRouteError } from "./routes-serializers.js";
import type { SettingsRoutesDependencies } from "./routes.js";

// Same ctx shape as ModuleRoutesContext (routes-modules.ts), plus the cipher.
export interface ModuleCredentialRoutesContext {
  readonly dependencies: SettingsRoutesDependencies;
  readonly repository: SettingsRepository;
  readonly assertAdminUser: (
    repository: SettingsRepository,
    scopedDb: DataContextDb,
    userId: string
  ) => Promise<User>;
  readonly requireRequestId: (accessContext: AccessContext) => string;
  readonly cipher: ModuleCredentialCipher;
}

/**
 * Resolve the auth declarations for a module from the boot discovery snapshot.
 * Returns null when the feature is off or the module is unknown — callers map
 * that to a 404 AFTER authorization (never before, so a non-admin/non-owner
 * can never distinguish unknown-module from feature-off from wrong-scope).
 */
function declaredCredentials(
  ctx: ModuleCredentialRoutesContext,
  moduleId: string,
  scope: "instance" | "user"
): readonly ModuleAuthDeclaration[] | null {
  const ext = ctx.dependencies.externalModules;
  if (!ext?.enabled) return null;
  const discovery = ext.discoveries.find((d) => d.id === moduleId);
  if (!discovery) return null;
  return (discovery.manifest.auth ?? []).filter((a) => a.scope === scope);
}

function findDeclaration(
  declarations: readonly ModuleAuthDeclaration[],
  credentialId: string
): ModuleAuthDeclaration | undefined {
  return declarations.find((d) => d.id === credentialId);
}

function toStatusDto(
  declaration: ModuleAuthDeclaration,
  rows: readonly ModuleCredentialMetadataRow[]
): ModuleCredentialStatusDto {
  const row = rows.find((r) => r.credential_id === declaration.id);
  return {
    credentialId: declaration.id,
    // displayName comes from the manifest declaration (server-derived), never
    // from client input — one less field to sanitize.
    displayName: declaration.displayName,
    scope: declaration.scope,
    configured: row?.has_secret ?? false,
    updatedAt: row ? row.updated_at.toISOString() : null
  };
}

/** Registers the six admin + per-user module-credential routes on `server` (#918). */
export function registerModuleCredentialRoutes(
  server: FastifyInstance,
  ctx: ModuleCredentialRoutesContext
): void {
  const { dependencies, repository, assertAdminUser, requireRequestId, cipher } = ctx;

  function writeAudit(scopedDb: DataContextDb): ExternalModuleAuditWriter {
    return (event) => repository.insertAuditEvent(scopedDb, event);
  }

  server.get(
    "/api/admin/modules/:moduleId/credentials",
    { schema: listModuleCredentialsRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        requireRequestId(accessContext);
        const { moduleId } = request.params as { moduleId: string };
        return await dependencies.dataContext.withDataContext(accessContext, async (scopedDb) => {
          // SECURITY: authorize FIRST — non-admins get 403 before any branch could
          // reveal whether the module exists or the feature is on.
          await assertAdminUser(repository, scopedDb, accessContext.actorUserId);
          const declarations = declaredCredentials(ctx, moduleId, "instance");
          if (declarations === null) throw new HttpError(404, "Unknown module");
          const rows = await listModuleCredentialMetadata(scopedDb, moduleId);
          const body: ListModuleCredentialsResponse = {
            moduleId,
            credentials: declarations.map((d) => toStatusDto(d, rows))
          };
          return body;
        });
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.put(
    "/api/admin/modules/:moduleId/credentials/:credentialId",
    { schema: setModuleCredentialRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const requestId = requireRequestId(accessContext);
        const { moduleId, credentialId } = request.params as {
          moduleId: string;
          credentialId: string;
        };
        const { value } = request.body as { value: string };
        return await dependencies.dataContext.withDataContext(accessContext, async (scopedDb) => {
          await assertAdminUser(repository, scopedDb, accessContext.actorUserId);
          const declarations = declaredCredentials(ctx, moduleId, "instance");
          if (declarations === null) throw new HttpError(404, "Unknown module");
          const declaration = findDeclaration(declarations, credentialId);
          if (!declaration) throw new HttpError(404, "Unknown credential slot");
          // Plaintext lifetime: this handler frame only. Encrypted before it touches
          // the repository; never logged, never audited, never returned.
          const envelope = cipher.encryptJson({ value });
          await upsertModuleCredential(
            scopedDb,
            {
              moduleId,
              credentialId,
              scope: "instance",
              ownerUserId: null,
              displayName: declaration.displayName,
              encryptedSecret: envelope,
              actorUserId: accessContext.actorUserId,
              requestId
            },
            writeAudit(scopedDb)
          );
          const rows = await listModuleCredentialMetadata(scopedDb, moduleId);
          return { credential: toStatusDto(declaration, rows) };
        });
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.delete(
    "/api/admin/modules/:moduleId/credentials/:credentialId",
    { schema: revokeModuleCredentialRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const requestId = requireRequestId(accessContext);
        const { moduleId, credentialId } = request.params as {
          moduleId: string;
          credentialId: string;
        };
        return await dependencies.dataContext.withDataContext(accessContext, async (scopedDb) => {
          await assertAdminUser(repository, scopedDb, accessContext.actorUserId);
          const declarations = declaredCredentials(ctx, moduleId, "instance");
          if (declarations === null) throw new HttpError(404, "Unknown module");
          const declaration = findDeclaration(declarations, credentialId);
          if (!declaration) throw new HttpError(404, "Unknown credential slot");
          const revoked = await revokeModuleCredential(
            scopedDb,
            {
              moduleId,
              credentialId,
              scope: "instance",
              ownerUserId: null,
              actorUserId: accessContext.actorUserId,
              requestId
            },
            writeAudit(scopedDb)
          );
          if (!revoked) throw new HttpError(404, "Credential not configured");
          const rows = await listModuleCredentialMetadata(scopedDb, moduleId);
          return { credential: toStatusDto(declaration, rows) };
        });
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.get(
    "/api/me/modules/:moduleId/credentials",
    { schema: listModuleCredentialsRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        requireRequestId(accessContext);
        const { moduleId } = request.params as { moduleId: string };
        return await dependencies.dataContext.withDataContext(accessContext, async (scopedDb) => {
          // Any authenticated user manages their own user-scope slots; RLS owner-binds
          // the rows, so there is no admin gate here.
          const declarations = declaredCredentials(ctx, moduleId, "user");
          if (declarations === null) throw new HttpError(404, "Unknown module");
          const rows = await listModuleCredentialMetadata(scopedDb, moduleId);
          const body: ListModuleCredentialsResponse = {
            moduleId,
            credentials: declarations.map((d) => toStatusDto(d, rows)),
            // #1759: whether an admin also has keys to fill for this module. Read from the
            // manifest, so it says nothing about what the instance has actually stored.
            instanceManaged: (declaredCredentials(ctx, moduleId, "instance") ?? []).length > 0
          };
          return body;
        });
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.put(
    "/api/me/modules/:moduleId/credentials/:credentialId",
    { schema: setModuleCredentialRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const requestId = requireRequestId(accessContext);
        const { moduleId, credentialId } = request.params as {
          moduleId: string;
          credentialId: string;
        };
        const { value } = request.body as { value: string };
        return await dependencies.dataContext.withDataContext(accessContext, async (scopedDb) => {
          const declarations = declaredCredentials(ctx, moduleId, "user");
          if (declarations === null) throw new HttpError(404, "Unknown module");
          const declaration = findDeclaration(declarations, credentialId);
          if (!declaration) throw new HttpError(404, "Unknown credential slot");
          const envelope = cipher.encryptJson({ value });
          await upsertModuleCredential(
            scopedDb,
            {
              moduleId,
              credentialId,
              scope: "user",
              ownerUserId: accessContext.actorUserId,
              displayName: declaration.displayName,
              encryptedSecret: envelope,
              actorUserId: accessContext.actorUserId,
              requestId
            },
            writeAudit(scopedDb)
          );
          const rows = await listModuleCredentialMetadata(scopedDb, moduleId);
          return { credential: toStatusDto(declaration, rows) };
        });
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.delete(
    "/api/me/modules/:moduleId/credentials/:credentialId",
    { schema: revokeModuleCredentialRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const requestId = requireRequestId(accessContext);
        const { moduleId, credentialId } = request.params as {
          moduleId: string;
          credentialId: string;
        };
        return await dependencies.dataContext.withDataContext(accessContext, async (scopedDb) => {
          const declarations = declaredCredentials(ctx, moduleId, "user");
          if (declarations === null) throw new HttpError(404, "Unknown module");
          const declaration = findDeclaration(declarations, credentialId);
          if (!declaration) throw new HttpError(404, "Unknown credential slot");
          const revoked = await revokeModuleCredential(
            scopedDb,
            {
              moduleId,
              credentialId,
              scope: "user",
              ownerUserId: accessContext.actorUserId,
              actorUserId: accessContext.actorUserId,
              requestId
            },
            writeAudit(scopedDb)
          );
          if (!revoked) throw new HttpError(404, "Credential not configured");
          const rows = await listModuleCredentialMetadata(scopedDb, moduleId);
          return { credential: toStatusDto(declaration, rows) };
        });
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );
}
