// Module-management route family (#917).
//
// Extracted verbatim from routes.ts to satisfy the 1000-line file-size gate: Task 9 added the
// external-module admin routes and pushed routes.ts over the cap. This is a PURE MOVE — the
// admin-modules, external-modules, and per-user-modules handlers keep the same order, the same
// admin authorization (assertAdminUser runs FIRST, before any 404/409 branch, so a non-admin
// can never distinguish unknown vs required vs feature-off), the same fail-closed 404/409 codes,
// and the same metadata-only writes. registerSettingsRoutes keeps its signature and just calls
// registerModuleRoutes(server, ctx). Nothing here changes the @moss/settings public surface.
//
// `assertAdminUser` and `requireRequestId` are threaded via ctx (they live in routes.ts) rather
// than imported, to avoid an import cycle with routes.ts. Everything else is imported directly.
import type { FastifyInstance } from "fastify";

import type { AccessContext, DataContextDb, User } from "@moss/db";
import {
  deleteExternalModuleDraftRouteSchema,
  listAdminModulesRouteSchema,
  listExternalModulesRouteSchema,
  listMyModulesRouteSchema,
  patchModuleEnablementRouteSchema,
  rescanExternalModulesRouteSchema,
  setExternalModuleEnablementRouteSchema,
  shipExternalModuleRouteSchema,
  type AdminModuleDto,
  type ExternalModuleDto
} from "@moss/shared";
import { HttpError } from "@moss/module-sdk";
import type { MossModuleManifest } from "@moss/module-sdk";
import { sendModuleControl } from "@moss/jobs";

import type { SettingsRepository } from "./repository.js";
import type { InstalledExternalModuleSummary, SettingsRoutesDependencies } from "./routes.js";
import { deleteExternalModuleDraft, shipExternalModule } from "./repository-external-modules.js";
import { listModuleBuildsForUser } from "./module-builds-repository.js";
import {
  computeMyModuleDto,
  handleRouteError,
  toMyModuleDto,
  toMyModuleDtoFromExternal
} from "./routes-serializers.js";

// Only the fields the module routes consume; the composition root passes the full deps object.
export interface ModuleRoutesContext {
  readonly dependencies: SettingsRoutesDependencies;
  readonly repository: SettingsRepository;
  // Module-level helpers from routes.ts, passed in to avoid an import cycle (#917).
  readonly assertAdminUser: (
    repository: SettingsRepository,
    scopedDb: DataContextDb,
    userId: string
  ) => Promise<User>;
  readonly requireRequestId: (accessContext: AccessContext) => string;
}

/**
 * Register the admin/external/per-user module routes on `server` (#917). Called once by
 * registerSettingsRoutes; the handler bodies are unchanged from their previous inline home.
 */
export function registerModuleRoutes(server: FastifyInstance, ctx: ModuleRoutesContext): void {
  const { dependencies, repository, assertAdminUser, requireRequestId } = ctx;

  function requireManifests(): readonly MossModuleManifest[] {
    return dependencies.listModuleManifests();
  }

  function findManifest(id: string): MossModuleManifest | undefined {
    return requireManifests().find((m) => m.id === id);
  }

  // #1762: absent port = no external module support in this composition (tests, and any host that
  // does not wire it). An empty list is the honest answer there, not an error.
  async function listInstalledExternalModules(
    accessContext: AccessContext
  ): Promise<readonly InstalledExternalModuleSummary[]> {
    return (await dependencies.listInstalledExternalModules?.(accessContext)) ?? [];
  }

  function isRequired(m: MossModuleManifest): boolean {
    return m.availability?.required === true;
  }

  function supportsUserDisable(m: MossModuleManifest): boolean {
    return m.availability?.supportsUserDisable !== false;
  }

  server.get(
    "/api/admin/modules",
    { schema: listAdminModulesRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const instanceRows = await dependencies.dataContext.withDataContext(
          accessContext,
          async (scopedDb) => {
            await assertAdminUser(repository, scopedDb, accessContext.actorUserId);
            return repository.listInstanceModuleDenyRows(scopedDb);
          }
        );
        const instanceDisabled = new Set(instanceRows.map((r) => r.module_id));
        const modules: AdminModuleDto[] = requireManifests().map((m) => ({
          id: m.id,
          name: m.name,
          version: m.version,
          lifecycle: m.lifecycle,
          required: isRequired(m),
          supportsUserDisable: supportsUserDisable(m),
          instanceDisabled: instanceDisabled.has(m.id)
        }));
        return { modules };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.patch<{ Params: { id: string } }>(
    "/api/admin/modules/:id",
    { schema: patchModuleEnablementRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const disabled = parseDisabledBody(request.body);
        // SECURITY: authorize FIRST, before any manifest lookup or required/unknown
        // check, so a non-admin can never distinguish unknown (404) vs required (409)
        // modules — they always get the admin 403. assertAdminUser must run before the
        // 404/409 branches. All checks live inside one withDataContext.
        const dto = await dependencies.dataContext.withDataContext(
          accessContext,
          async (scopedDb) => {
            await assertAdminUser(repository, scopedDb, accessContext.actorUserId);
            const manifest = findManifest(request.params.id);
            if (!manifest) throw new HttpError(404, "Module not found");
            if (disabled && isRequired(manifest)) {
              throw new HttpError(409, "Required modules cannot be disabled");
            }
            await repository.setInstanceModuleDisabled(scopedDb, {
              moduleId: manifest.id,
              disabled,
              actorUserId: accessContext.actorUserId,
              requestId: requireRequestId(accessContext)
            });
            // #1263 Task 15: install-time grants also apply on (re-)enable, so a module
            // disabled before #1263 shipped still gets its granted_at_install families
            // wired up. insertActionPolicyIfAbsent never overwrites a user's own choice.
            if (!disabled) {
              await dependencies.grantSelfOperationForModule?.(scopedDb, manifest);
            }
            return computeMyModuleDto(repository, scopedDb, manifest, accessContext.actorUserId);
          }
        );
        return { module: dto };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  // #917: list discovered external modules with reconciled activation state. Admin-only.
  // This is the ONE path that PERSISTS drift auto-disables — it runs in an admin RLS
  // context, so autoDisableExternalModule's UPDATE passes current_actor_is_admin(). The
  // /api/modules provider (apps/api) reconciles in the ACTOR context and never persists.
  server.get(
    "/api/admin/external-modules",
    { schema: listExternalModulesRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const ext = dependencies.externalModules;
        const body = await dependencies.dataContext.withDataContext(
          accessContext,
          async (scopedDb) => {
            // Authorize FIRST — a non-admin gets 403 regardless of feature state.
            await assertAdminUser(repository, scopedDb, accessContext.actorUserId);
            if (!ext || !ext.enabled) {
              // Feature off: still admin-gated, just an empty read-only surface.
              return {
                enabled: false,
                modules: [] as readonly ExternalModuleDto[],
                rejected: [] as readonly { id: string; reason: string }[]
              };
            }
            const states = await repository.listExternalModuleStates(scopedDb);
            // reconcile is injected by the composition root (apps/api). It closes over the
            // boot discovery snapshot; `modules` are already ExternalModuleDto-shaped.
            const { modules, driftDisable } = ext.reconcile(states);
            // Persist any drift auto-disables discovered this read (admin context only).
            for (const d of driftDisable) {
              await repository.autoDisableExternalModule(scopedDb, {
                id: d.id,
                reason: d.reason,
                actorUserId: accessContext.actorUserId,
                requestId: requireRequestId(accessContext)
              });
            }
            return {
              enabled: true,
              modules,
              rejected: ext.rejected.map((r) => ({ id: r.id, reason: r.reason }))
            };
          }
        );
        return body;
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  // #917: admin enable/disable of a single external module. Enable captures the CURRENT
  // on-disk hashes as the trusted baseline; disable pins it off. 404 if the id is not a
  // current on-disk discovery; 409 if the feature is off.
  server.post<{ Params: { id: string }; Body: { enabled: boolean } }>(
    "/api/admin/external-modules/:id",
    { schema: setExternalModuleEnablementRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const ext = dependencies.externalModules;
        const enable = request.body.enabled;
        const dto = await dependencies.dataContext.withDataContext(
          accessContext,
          async (scopedDb) => {
            // Authorize FIRST (same non-leak discipline as /api/admin/modules).
            await assertAdminUser(repository, scopedDb, accessContext.actorUserId);
            if (!ext || !ext.enabled) {
              throw new HttpError(409, "External modules are not enabled on this instance");
            }
            const discovery = ext.discoveries().find((d) => d.id === request.params.id);
            if (!discovery) throw new HttpError(404, "External module not found");

            if (enable) {
              await repository.setExternalModuleEnabled(scopedDb, {
                id: discovery.id,
                manifestHash: discovery.manifestHash,
                packageHash: discovery.packageHash,
                actorUserId: accessContext.actorUserId,
                requestId: requireRequestId(accessContext)
              });
            } else {
              await repository.setExternalModuleDisabled(scopedDb, {
                id: discovery.id,
                reason: "disabled by admin",
                actorUserId: accessContext.actorUserId,
                requestId: requireRequestId(accessContext)
              });
            }

            // Recompute this module's reconciled DTO from fresh state.
            const states = await repository.listExternalModuleStates(scopedDb);
            const { modules } = ext.reconcile(states);
            const updated = modules.find((m) => m.id === discovery.id);
            if (!updated) throw new HttpError(404, "External module not found");
            return updated;
          }
        );
        try {
          await dependencies.reconcileExternalModuleJobs?.({
            kind: "module",
            moduleId: request.params.id
          });
        } catch (error) {
          request.log.warn(
            { moduleId: request.params.id, errorName: (error as Error).name },
            "external module job reconcile signal failed"
          );
        }
        return { module: dto };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  // #1752: admin-triggered rescan of the modules directory on disk. Refreshes the discovery
  // snapshot in THIS process, then signals the worker process to do the same and reconcile —
  // this is what makes a module dropped onto the mount visible without a restart.
  server.post(
    "/api/admin/modules/rescan",
    { schema: rescanExternalModulesRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        await dependencies.dataContext.withDataContext(accessContext, async (scopedDb) => {
          await assertAdminUser(repository, scopedDb, accessContext.actorUserId);
        });
        await dependencies.externalModules?.rescan?.();
        if (dependencies.boss) {
          await sendModuleControl(dependencies.boss, { action: "rescan" });
        }
        return { ok: true };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  // #1753 Task 10: shipping — the human action that ends a draft's author-only exemption.
  // Same shape as the rescan route above: authorize first, 409 if the feature is off, 404 if
  // the id isn't a current on-disk discovery OR isn't the caller's own draft (shipExternalModule
  // can't tell those two apart on purpose — see its doc-comment).
  server.post<{ Params: { id: string } }>(
    "/api/admin/modules/:id/ship",
    { schema: shipExternalModuleRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const ext = dependencies.externalModules;
        await dependencies.dataContext.withDataContext(accessContext, async (scopedDb) => {
          await assertAdminUser(repository, scopedDb, accessContext.actorUserId);
          if (!ext || !ext.enabled) {
            throw new HttpError(409, "External modules are not enabled on this instance");
          }
          const discovery = ext.discoveries().find((d) => d.id === request.params.id);
          if (!discovery) throw new HttpError(404, "External module not found");

          const shipped = await shipExternalModule(
            scopedDb,
            {
              id: discovery.id,
              manifestHash: discovery.manifestHash,
              packageHash: discovery.packageHash,
              actorUserId: accessContext.actorUserId,
              requestId: requireRequestId(accessContext)
            },
            repository.externalModuleAuditWriter(scopedDb)
          );
          if (!shipped) throw new HttpError(404, "External module not found");
        });
        return { shipped: true, restartRequired: true };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  // #1890 Workshop 8: throwing a draft away — the other end of a draft's life from ship, and
  // built to the same rules. Authorize FIRST (a non-admin gets 403 whether or not the module
  // exists), 409 if the feature is off, then ONE owner-and-draft-scoped delete that answers 404
  // identically for "no such module", "that is shipped" and "that is someone else's draft".
  //
  // Deliberately NOT gated on ext.discoveries(): unlike ship, a throw-away must still work when
  // the module is not in the current on-disk discovery snapshot — a half-installed or already
  // hand-deleted draft is exactly the case where a user most needs the row cleaned up, and
  // requiring a live discovery would strand it with no way off the instance from the UI.
  server.delete<{ Params: { id: string } }>(
    "/api/admin/modules/:id/draft",
    { schema: deleteExternalModuleDraftRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const moduleId = request.params.id;
        const dist = dependencies.moduleDistribution;
        // Build ids are read BEFORE the delete: app.module_builds.module_id is
        // ON DELETE SET NULL, so once the external_modules row is gone the link from a
        // build to the module it produced is gone with it and the build directory could
        // never be found again. RLS already restricts this read to the caller's own builds.
        const buildIds = await dependencies.dataContext.withDataContext(
          accessContext,
          async (scopedDb) => {
            await assertAdminUser(repository, scopedDb, accessContext.actorUserId);
            if (!dependencies.externalModules?.enabled) {
              throw new HttpError(409, "External modules are not enabled on this instance");
            }
            const builds = await listModuleBuildsForUser(scopedDb, accessContext.actorUserId);
            const ids = builds.filter((b) => b.moduleId === moduleId).map((b) => b.id);
            const deleted = await deleteExternalModuleDraft(
              scopedDb,
              {
                id: moduleId,
                actorUserId: accessContext.actorUserId,
                requestId: requireRequestId(accessContext)
              },
              repository.externalModuleAuditWriter(scopedDb)
            );
            if (!deleted) throw new HttpError(404, "External module not found");
            return ids;
          }
        );

        // Files LAST, and only once the row is really gone — same ordering rule as admin
        // Remove (routes-module-registry.ts). A leftover directory with no row is inert; a
        // deleted directory with a live row would leave a broken module in everyone's nav.
        await dist?.removeModuleFiles(moduleId);
        for (const buildId of buildIds) {
          await dist?.removeModuleBuildFiles?.(buildId);
        }

        // Rescan here and in the worker — this is what drops the module from the sidebar
        // without a restart, the same path /api/admin/modules/rescan uses.
        try {
          await dependencies.externalModules?.rescan?.();
          if (dependencies.boss) {
            await sendModuleControl(dependencies.boss, { action: "rescan" });
          }
        } catch (error) {
          request.log.warn(
            { moduleId, errorName: (error as Error).name },
            "rescan after draft delete failed (#1890)"
          );
        }
        return { deleted: true };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.get("/api/me/modules", { schema: listMyModulesRouteSchema }, async (request, reply) => {
    try {
      const accessContext = await dependencies.resolveAccessContext(request);
      // #1762: read the installed external modules before opening the actor's data context — the
      // port opens one of its own, and nesting two is a deadlock risk on a single-connection pool.
      const installedExternal = await listInstalledExternalModules(accessContext);
      const modules = await dependencies.dataContext.withDataContext(
        accessContext,
        async (scopedDb) => {
          const rows = await repository.listModuleDenyRowsForActor(scopedDb);
          const instanceDisabled = new Set(
            rows.filter((r) => r.scope === "instance").map((r) => r.module_id)
          );
          const userDisabled = new Set(
            rows
              .filter((r) => r.scope === "user" && r.user_id === accessContext.actorUserId)
              .map((r) => r.module_id)
          );
          const builtIn = requireManifests().map((m) =>
            toMyModuleDto(m, instanceDisabled.has(m.id), userDisabled.has(m.id))
          );
          // #1762: installed external modules belong in the same list. Before this they were
          // absent entirely, so a downloaded module could never be configured by its user —
          // every branch the pane has for one was unreachable.
          const external = installedExternal.map((m) =>
            toMyModuleDtoFromExternal(m, userDisabled.has(m.id))
          );
          return [...builtIn, ...external];
        }
      );
      return { modules };
    } catch (error) {
      return handleRouteError(error, reply);
    }
  });

  server.patch<{ Params: { id: string } }>(
    "/api/me/modules/:id",
    { schema: patchModuleEnablementRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const disabled = parseDisabledBody(request.body);
        const manifest = findManifest(request.params.id);
        // #1762: an external module has no built-in manifest, so it has to be resolved from the
        // installed set. Without this the route 404s on every downloaded module, which would make
        // the switch the list now renders dead on arrival.
        const external = manifest
          ? undefined
          : (await listInstalledExternalModules(accessContext)).find(
              (m) => m.id === request.params.id
            );
        if (!manifest && !external) throw new HttpError(404, "Module not found");
        if (manifest && disabled && isRequired(manifest)) {
          throw new HttpError(409, "Required modules cannot be disabled");
        }
        if (manifest && disabled && !supportsUserDisable(manifest)) {
          throw new HttpError(422, "This module cannot be disabled per-user");
        }
        const moduleId = manifest?.id ?? request.params.id;
        const dto = await dependencies.dataContext.withDataContext(
          accessContext,
          async (scopedDb) => {
            await repository.setUserModuleDisabled(scopedDb, {
              moduleId,
              disabled,
              actorUserId: accessContext.actorUserId,
              requestId: requireRequestId(accessContext)
            });
            // #1263 Task 15: same install-time grant wiring as the admin enable path above.
            // External modules are skipped: the grant is keyed off a built-in manifest's declared
            // operations, and an external module's grants are issued by its install instead.
            if (!disabled && manifest) {
              await dependencies.grantSelfOperationForModule?.(scopedDb, manifest);
            }
            return manifest
              ? computeMyModuleDto(repository, scopedDb, manifest, accessContext.actorUserId)
              : toMyModuleDtoFromExternal(external as InstalledExternalModuleSummary, disabled);
          }
        );
        return { module: dto };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );
}

function parseDisabledBody(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "Expected JSON object body");
  }
  const disabled = (body as Record<string, unknown>).disabled;
  if (typeof disabled !== "boolean") {
    throw new HttpError(400, "disabled must be a boolean");
  }
  return disabled;
}
