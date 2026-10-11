import type { FastifyInstance } from "fastify";
import type { MossAuthRuntime } from "@moss/auth";
import type { AccessContext } from "@moss/db";
import { getBuiltInModuleManifests, type ReconciledExternalModule } from "@moss/module-registry";
import { listModulesRouteSchema } from "@moss/shared";
import { serializeExternalModule, serializeModule } from "./module-dto.js";

export function registerPlatformRoutes(
  server: FastifyInstance,
  authRuntime: Pick<MossAuthRuntime, "resolveAccessContext">,
  // #996/#860: always-on provider of the ACTIVE external modules for the actor.
  getActiveExternalModules: (
    accessContext: AccessContext
  ) => Promise<readonly ReconciledExternalModule[]>
): void {
  server.get("/api/modules", { schema: listModulesRouteSchema }, async (request, reply) => {
    try {
      const accessContext = await authRuntime.resolveAccessContext(request);

      const builtIns = getBuiltInModuleManifests().map(serializeModule);
      // #996/#860: append ACTIVE external modules (reconcile already filtered to active === true).
      // Runs in the actor's own data context, so /api/modules reflects only what is active.
      const external = (await getActiveExternalModules(accessContext)).map(serializeExternalModule);
      return {
        modules: [...builtIns, ...external]
      };
    } catch (error) {
      const code =
        (error instanceof Error && (error as Error & { code?: string }).code) || undefined;
      if (code === "account_pending_approval") {
        return reply.code(403).send({ error: "Account is pending approval", code });
      }
      if (code === "account_deactivated") {
        return reply.code(403).send({ error: "Account has been deactivated", code });
      }
      return reply.code(401).send({ error: "Session is missing or expired" });
    }
  });
}
