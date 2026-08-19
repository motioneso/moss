// apps/api/src/module-preferences.ts
//
// #1725: read/write endpoints for an installed module's on/off switches. The module
// declares them (ExternalModulePreferenceDeclaration) and the host owns everything else:
// rendering, storage and the write path. A module never writes its own preference and
// never reads another user's — every query below runs inside the ACTOR's data context, so
// RLS on app.preferences (owner-only) is what enforces that, not this file.
//
// Storage is app.preferences under the namespaced key `module:<moduleId>:<key>`. Nothing
// is written at install: an absent row means "never touched", which resolves to the
// manifest default. That is why uninstall only has to delete the namespace.
import type { FastifyInstance, FastifyRequest } from "fastify";

import { resolveMossEnv, type AccessContext, type DataContextRunner } from "@moss/db";
import {
  resolveModulePreferences,
  writeModulePreferences,
  type ReconciledExternalModule
} from "@moss/module-registry";

export function registerModulePreferenceRoutes(
  server: FastifyInstance,
  deps: {
    readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
    readonly getActiveExternalModules: (
      access: AccessContext
    ) => Promise<readonly ReconciledExternalModule[]>;
    readonly runner: DataContextRunner;
    readonly rateLimitKey?: (request: FastifyRequest) => string;
  }
): void {
  // An inactive or unknown module is a 404, never a 403 with a different body: the same
  // response for "no such module" and "not installed for you" keeps /api/modules the only
  // place that discloses what exists.
  async function loadModule(
    request: FastifyRequest,
    access: AccessContext
  ): Promise<ReconciledExternalModule | null> {
    const { moduleId } = request.params as { moduleId: string };
    const modules = await deps.getActiveExternalModules(access);
    return modules.find((module) => module.id === moduleId) ?? null;
  }

  server.get("/api/modules/:moduleId/preferences", async (request, reply) => {
    let access: AccessContext;
    try {
      access = await deps.resolveAccessContext(request);
    } catch {
      return reply.code(401).send({ error: "Session is missing or expired" });
    }
    const module = await loadModule(request, access);
    if (!module) return reply.code(404).send({ error: "Not found" });

    const values = await resolveModulePreferences(deps.runner, access, module);
    return {
      // The declarations travel with the values so the settings pane renders straight from
      // the response — it never needs a second call to /api/modules to learn the labels.
      preferences: module.preferences.map((declaration) => ({
        key: declaration.key,
        label: declaration.label,
        description: declaration.description ?? null,
        type: declaration.type,
        default: declaration.default,
        value: values[declaration.key] ?? declaration.default
      }))
    };
  });

  server.patch(
    "/api/modules/:moduleId/preferences",
    {
      config: {
        rateLimit: {
          max: Number(resolveMossEnv(process.env, "JARVIS_RL_MODULE_PREFS_MAX") ?? 30),
          timeWindow: "1 minute",
          ...(deps.rateLimitKey ? { keyGenerator: deps.rateLimitKey } : {})
        }
      }
    },
    async (request, reply) => {
      let access: AccessContext;
      try {
        access = await deps.resolveAccessContext(request);
      } catch {
        return reply.code(401).send({ error: "Session is missing or expired" });
      }
      const module = await loadModule(request, access);
      if (!module) return reply.code(404).send({ error: "Not found" });

      const body = request.body;
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return reply.code(400).send({ error: "Invalid request" });
      }
      // Only keys the manifest declares, only booleans. An undeclared key is a 400 rather
      // than a silent drop, so a module update that removes a switch surfaces as an error
      // in the pane instead of a write that appears to succeed and does nothing.
      const declared = new Map(module.preferences.map((p) => [p.key, p]));
      const updates = Object.entries(body as Record<string, unknown>);
      if (
        updates.length === 0 ||
        updates.some(([key, value]) => !declared.has(key) || typeof value !== "boolean")
      ) {
        return reply.code(400).send({ error: "Invalid request" });
      }

      await writeModulePreferences(
        deps.runner,
        access,
        module.id,
        updates as ReadonlyArray<readonly [string, boolean]>
      );

      const values = await resolveModulePreferences(deps.runner, access, module);
      return { preferences: values };
    }
  );
}
