// Task 6 (#964): admin module-registry surface — list (index ⋈ local state), download,
// remove, cancel-purge. Same non-leak discipline as routes-modules.ts: assertAdminUser
// runs FIRST, before any 404/409 branch, so a non-admin can never probe module state.
// Network/fs work (index fetch, download pipeline) runs OUTSIDE withDataContext — a
// download can take tens of seconds and must not pin a pooled RLS connection.
import type { FastifyInstance } from "fastify";
import {
  cancelExternalModulePurgeRouteSchema,
  downloadExternalModuleRouteSchema,
  getModuleRegistryRouteSchema,
  removeExternalModuleRouteSchema,
  type GetModuleRegistryResponse,
  type ModuleRegistryRowDto
} from "@moss/shared";

import { deriveModuleRegistryRows, type ModuleRegistryEntryLike } from "./module-registry-rows.js";
import {
  listExternalModuleAdminStates,
  markExternalModuleRemoved,
  setExternalModulePurgeRequested,
  updateExternalModuleStaging,
  type ExternalModuleAdminState
} from "./repository-external-modules.js";
import { HttpError } from "@moss/module-sdk";
import { handleRouteError } from "./routes-serializers.js";
import type { ModuleRoutesContext } from "./routes-modules.js";

// Task 5 pipeline error code → HTTP status. Codes are strings across the port boundary
// (settings cannot import module-registry's ModuleDownloadError); unknown codes → 502.
const DOWNLOAD_ERROR_STATUS: Record<string, number> = {
  // #1319: the catalog was fetched but could not be authenticated. 409 (not 422) because the
  // admin can resolve it by reviewing that exact catalog and accepting it deliberately.
  "index-unverified": 409,
  "module-not-found": 404,
  "version-mismatch": 422,
  "integrity-mismatch": 422,
  "manifest-invalid": 422,
  "extract-failed": 422,
  "index-unavailable": 503,
  "download-failed": 502
};

export function registerModuleRegistryRoutes(
  server: FastifyInstance,
  ctx: ModuleRoutesContext
): void {
  const { dependencies, repository, assertAdminUser, requireRequestId } = ctx;

  /** Everything a derive needs besides the index; runs inside ONE admin RLS context. */
  async function loadLocalState(accessContext: {
    readonly actorUserId: string;
  }): Promise<readonly ExternalModuleAdminState[]> {
    return dependencies.dataContext.withDataContext(
      accessContext as Parameters<typeof dependencies.dataContext.withDataContext>[0],
      async (scopedDb) => {
        // Authorize FIRST — before any feature/404/409 branch.
        await assertAdminUser(repository, scopedDb, accessContext.actorUserId);
        return listExternalModuleAdminStates(scopedDb);
      }
    );
  }

  async function deriveRows(
    entries: readonly ModuleRegistryEntryLike[] | null,
    adminStates: readonly ExternalModuleAdminState[]
  ): Promise<ModuleRegistryRowDto[]> {
    const ext = dependencies.externalModules;
    const dist = dependencies.moduleDistribution;
    const onDiskIds = dist ? await dist.listOnDiskModuleIds() : [];
    return deriveModuleRegistryRows({
      registryEntries: entries,
      discoveries: (ext?.discoveries() ?? []).map((d) => ({
        id: d.id,
        name: d.manifest.name,
        version: d.manifest.version,
        description: d.manifest.description
      })),
      rejected: ext?.rejected ?? [],
      adminStates,
      onDiskIds,
      ensureIds: dist?.ensureIds ?? []
    });
  }

  server.get<{ Querystring: { refresh?: string } }>(
    "/api/admin/module-registry",
    { schema: getModuleRegistryRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const adminStates = await loadLocalState(accessContext);
        const ext = dependencies.externalModules;
        const dist = dependencies.moduleDistribution;
        if (!ext?.enabled || !dist) {
          const body: GetModuleRegistryResponse = {
            enabled: false,
            registryUnavailable: false,
            catalogVerification: "unavailable",
            catalogDigestSha256: null,
            modules: []
          };
          return body;
        }
        const snapshot = await dist.fetchRegistryEntries({
          refresh: request.query.refresh === "1"
        });
        const body: GetModuleRegistryResponse = {
          enabled: true,
          registryUnavailable: snapshot.catalogVerification === "unavailable",
          catalogVerification: snapshot.catalogVerification,
          catalogDigestSha256: snapshot.catalogDigestSha256,
          modules: await deriveRows(snapshot.entries, adminStates)
        };
        return body;
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.post<{
    Params: { id: string };
    Body: { version?: string; acceptedCatalogDigestSha256?: string };
  }>(
    "/api/admin/external-modules/:id/download",
    { schema: downloadExternalModuleRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const moduleId = request.params.id;
        // Context 1: authorize + purge-guard. The download route must never clear or
        // race a pending purge (spec §9) — the admin cancels it explicitly first.
        const priorStates = await loadLocalState(accessContext);
        const dist = dependencies.moduleDistribution;
        if (!dependencies.externalModules?.enabled || !dist) {
          throw new HttpError(409, "External modules are not enabled on this instance");
        }
        if (priorStates.some((s) => s.id === moduleId && s.purgeRequestedAt != null)) {
          throw new HttpError(409, "A data purge is pending for this module — cancel it first");
        }

        // Network + fs pipeline, OUTSIDE any DB context.
        const result = await dist.download({
          moduleId,
          version: request.body?.version,
          acceptedCatalogDigestSha256: request.body?.acceptedCatalogDigestSha256
        });
        if (!result.ok) {
          // #1319: the generic error path can only carry a message, so the blocked-catalog
          // refusal replies here directly — the admin needs the digest to be able to review
          // and accept that exact catalog. Admin authorization already ran, above.
          if (result.code === "index-unverified") {
            return reply.code(409).send({
              error: result.message,
              code: result.code,
              ...(result.catalogDigestSha256
                ? { catalogDigestSha256: result.catalogDigestSha256 }
                : {})
            });
          }
          throw new HttpError(DOWNLOAD_ERROR_STATUS[result.code] ?? 502, result.message);
        }

        // Context 2: record staged intent (spec §6 step 8) and re-derive the row.
        const adminStates = await dependencies.dataContext.withDataContext(
          accessContext,
          async (scopedDb) => {
            await assertAdminUser(repository, scopedDb, accessContext.actorUserId);
            await updateExternalModuleStaging(
              scopedDb,
              {
                id: moduleId,
                stagedVersion: result.version,
                stagedPackageHash: result.packageHash,
                actorUserId: accessContext.actorUserId,
                requestId: requireRequestId(accessContext)
              },
              repository.externalModuleAuditWriter(scopedDb)
            );
            return listExternalModuleAdminStates(scopedDb);
          }
        );
        const snapshot = await dist.fetchRegistryEntries({ refresh: false });
        const rows = await deriveRows(snapshot.entries, adminStates);
        const row = rows.find((r) => r.id === moduleId);
        if (!row) throw new HttpError(404, "External module not found");
        return { module: row };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.post<{ Params: { id: string }; Body: { purgeData: boolean } }>(
    "/api/admin/external-modules/:id/remove",
    { schema: removeExternalModuleRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const moduleId = request.params.id;
        const dist = dependencies.moduleDistribution;
        const adminStates = await dependencies.dataContext.withDataContext(
          accessContext,
          async (scopedDb) => {
            await assertAdminUser(repository, scopedDb, accessContext.actorUserId);
            if (!dependencies.externalModules?.enabled || !dist) {
              throw new HttpError(409, "External modules are not enabled on this instance");
            }
            const onDisk = await dist.listOnDiskModuleIds();
            const states = await listExternalModuleAdminStates(scopedDb);
            const hasRow = states.some((s) => s.id === moduleId);
            if (!onDisk.includes(moduleId) && !hasRow) {
              throw new HttpError(404, "External module not found");
            }
            if (hasRow) {
              await markExternalModuleRemoved(
                scopedDb,
                {
                  id: moduleId,
                  actorUserId: accessContext.actorUserId,
                  requestId: requireRequestId(accessContext)
                },
                repository.externalModuleAuditWriter(scopedDb)
              );
            }
            if (request.body.purgeData) {
              // Records intent only; destruction runs in the boot reconcile (Task 7),
              // the sole holder of DROP privileges. No-op false is fine when there was
              // never a row (files-only leftovers have no data to purge).
              await setExternalModulePurgeRequested(
                scopedDb,
                {
                  id: moduleId,
                  requested: true,
                  actorUserId: accessContext.actorUserId,
                  requestId: requireRequestId(accessContext)
                },
                repository.externalModuleAuditWriter(scopedDb)
              );
            }
            return listExternalModuleAdminStates(scopedDb);
          }
        );
        // fs delete LAST — if it fails the module is already pinned disabled (safe),
        // and the admin can retry Remove.
        await dist!.removeModuleFiles(moduleId);
        const snapshot = await dist!.fetchRegistryEntries({ refresh: false });
        const rows = await deriveRows(snapshot.entries, adminStates);
        const row = rows.find((r) => r.id === moduleId);
        if (!row) throw new HttpError(404, "External module not found");
        return { module: row };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.delete<{ Params: { id: string } }>(
    "/api/admin/external-modules/:id/purge",
    { schema: cancelExternalModulePurgeRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const moduleId = request.params.id;
        const dist = dependencies.moduleDistribution;
        const adminStates = await dependencies.dataContext.withDataContext(
          accessContext,
          async (scopedDb) => {
            await assertAdminUser(repository, scopedDb, accessContext.actorUserId);
            if (!dependencies.externalModules?.enabled || !dist) {
              throw new HttpError(409, "External modules are not enabled on this instance");
            }
            const cancelled = await setExternalModulePurgeRequested(
              scopedDb,
              {
                id: moduleId,
                requested: false,
                actorUserId: accessContext.actorUserId,
                requestId: requireRequestId(accessContext)
              },
              repository.externalModuleAuditWriter(scopedDb)
            );
            if (!cancelled) throw new HttpError(404, "External module not found");
            return listExternalModuleAdminStates(scopedDb);
          }
        );
        const snapshot = await dist!.fetchRegistryEntries({ refresh: false });
        const rows = await deriveRows(snapshot.entries, adminStates);
        const row = rows.find((r) => r.id === moduleId);
        if (!row) throw new HttpError(404, "External module not found");
        return { module: row };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );
}
