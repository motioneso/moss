// External-module web asset route (#918). Extracted from server.ts (file-size gate,
// mirrors the routes.ts→routes-modules.ts / platform-api.ts→platform-api-modules.ts
// precedent) — a pure move, no behavior change.
import type { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";

import type { MossAuthRuntime } from "@moss/auth";
import type { AccessContext } from "@moss/db";
import type { ExternalModuleDiscovery, ReconciledExternalModule } from "@moss/module-registry";
import { ModuleAssetPathError, resolveModuleAssetPath } from "@moss/module-registry/node";

/**
 * Serves an external module's web assets (#918). Authenticated only — module assets
 * are instance content, not public files. Fail-closed on every branch: feature off,
 * unknown module, no web declaration, or module not ACTIVE for this actor are all
 * indistinguishable 404s (same posture as the route-enablement guard — never reveal
 * that a module exists but is disabled).
 */
export function registerExternalModuleWebAssetRoute(
  server: FastifyInstance,
  authRuntime: MossAuthRuntime,
  discoveries: () => readonly ExternalModuleDiscovery[],
  getActiveExternalModules: (
    accessContext: AccessContext
  ) => Promise<readonly ReconciledExternalModule[]>
): void {
  server.get("/api/modules/:moduleId/web/*", async (request, reply) => {
    let accessContext: AccessContext;
    try {
      accessContext = await authRuntime.resolveAccessContext(request);
    } catch {
      return reply.code(401).send({ error: "Session is missing or expired" });
    }
    const { moduleId } = request.params as { moduleId: string };
    const relPath = (request.params as Record<string, string>)["*"] ?? "";

    const discovery = discoveries().find((d) => d.id === moduleId);
    if (!discovery?.manifest.web) {
      return reply.code(404).send({ error: "Not found" });
    }
    let active: readonly ReconciledExternalModule[];
    try {
      active = await getActiveExternalModules(accessContext);
    } catch (error) {
      request.log.error({ err: error, moduleId }, "module web asset activity resolution failed");
      return reply.code(503).send({ error: "Service unavailable" });
    }
    if (!active.some((m) => m.id === moduleId)) {
      return reply.code(404).send({ error: "Not found" });
    }

    try {
      const asset = resolveModuleAssetPath(discovery.dir, relPath);
      const body = await readFile(asset.absPath);
      return (
        reply
          .header("content-type", asset.contentType)
          // no-store: enablement can flip at any time; a cached asset must not
          // outlive a disable.
          .header("cache-control", "no-store")
          .header("x-content-type-options", "nosniff")
          .send(body)
      );
    } catch (error) {
      // Reason token / errno code only — raw fs error messages embed absolute
      // host paths (node.ts discipline).
      const reason =
        error instanceof ModuleAssetPathError
          ? error.reason
          : ((error as NodeJS.ErrnoException).code ?? (error as Error).name);
      request.log.warn({ moduleId, reason }, "module web asset rejected (#918)");
      return reply.code(404).send({ error: "Not found" });
    }
  });
}
