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
// manifest default. There is no uninstall path in the platform today (a module is removed
// by deleting its staged directory), so nothing cleans this namespace up; a left-behind row
// is inert, and re-installing the module restores the user's earlier choice.
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
        // `??` would be wrong here: a resolved integer of null is the user's own "unset", and
        // coalescing it back to the manifest default would redraw a target they had cleared.
        value: declaration.key in values ? values[declaration.key] : declaration.default,
        // #1757: bounds travel with the value so the pane can constrain the input without a
        // second call. A switch has none.
        min: declaration.type === "integer" ? (declaration.min ?? null) : null,
        max: declaration.type === "integer" ? (declaration.max ?? null) : null
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
      // Only keys the manifest declares, and only a value of the declared type. An undeclared
      // key is a 400 rather than a silent drop, so a module update that removes a setting
      // surfaces as an error in the pane instead of a write that appears to succeed and does
      // nothing. #1757: bounds are enforced here too — the number input is a convenience, not
      // the guard, and a module reading ctx.preferences must be able to trust its own range.
      const declared = new Map(module.preferences.map((p) => [p.key, p]));
      const updates = Object.entries(body as Record<string, unknown>);
      const acceptable = (key: string, value: unknown): boolean => {
        const declaration = declared.get(key);
        if (!declaration) return false;
        if (declaration.type === "boolean") return typeof value === "boolean";
        // null is how the user clears the field back to "no answer"; it is accepted only where
        // the manifest declared that unset is a real end state.
        if (value === null) return declaration.default === null;
        if (!Number.isSafeInteger(value)) return false;
        const numeric = value as number;
        if (declaration.min !== undefined && numeric < declaration.min) return false;
        if (declaration.max !== undefined && numeric > declaration.max) return false;
        return true;
      };
      if (updates.length === 0 || updates.some(([key, value]) => !acceptable(key, value))) {
        return reply.code(400).send({ error: "Invalid request" });
      }

      await writeModulePreferences(
        deps.runner,
        access,
        module.id,
        updates as ReadonlyArray<readonly [string, boolean | number | null]>
      );

      const values = await resolveModulePreferences(deps.runner, access, module);
      return { preferences: values };
    }
  );
}
