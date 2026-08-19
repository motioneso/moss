import type { FastifyInstance, FastifyRequest } from "fastify";

import type { AccessContext, DataContextRunner } from "@moss/db";
import { HttpError } from "@moss/module-sdk";
import {
  getRuntimeConfigRouteSchema,
  putRuntimeConfigRouteSchema,
  type PutRuntimeConfigRequest,
  type RuntimeConfigStatusDto
} from "@moss/shared";

import {
  getRuntimeConfigEntry,
  type RuntimeConfigKeyEntry,
  type RuntimeConfigType
} from "./runtime-config-keys.js";
import { RuntimeConfigResolver } from "./runtime-config-resolver.js";
import type { SettingsRepository } from "./repository.js";
import { handleSettingsRouteError } from "./route-error.js";
import { assertAdminUser } from "./routes.js";

export interface RuntimeConfigRoutesDependencies {
  readonly dataContext: DataContextRunner;
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  readonly repository: SettingsRepository;
  readonly env?: NodeJS.ProcessEnv;
  readonly onConfigChanged?: (key: string) => void;
}

function requireRequestId(accessContext: AccessContext): string {
  if (!accessContext.requestId) {
    throw new HttpError(500, "Request id is missing");
  }
  return accessContext.requestId;
}

function readKeyParam(request: FastifyRequest): string {
  const key = (request.params as { key?: unknown }).key;
  if (typeof key !== "string" || key.length === 0) {
    throw new HttpError(400, "Runtime config key is required");
  }
  return key;
}

function requireRuntimeEntry(key: string): RuntimeConfigKeyEntry {
  const entry = getRuntimeConfigEntry(key);
  if (!entry) {
    throw new HttpError(404, "Unknown runtime config key");
  }
  return entry;
}

function validateRuntimeValue(entry: RuntimeConfigKeyEntry, value: string): void {
  if (value.length === 0) return;
  const display = entry.secret ? "[REDACTED]" : value;
  if (entry.type === "enum" && !entry.enumValues?.includes(value)) {
    throw new HttpError(
      400,
      `Invalid runtime config "${entry.key}" value "${display}" (expected one of: ${entry.enumValues?.join(", ") ?? ""})`
    );
  }
  if (entry.type === "int") {
    const n = Number(value);
    if (!Number.isInteger(n)) {
      throw new HttpError(
        400,
        `Invalid runtime config "${entry.key}" value "${display}" (expected int)`
      );
    }
    if (entry.minValue !== undefined && n < entry.minValue) {
      throw new HttpError(
        400,
        `Invalid runtime config "${entry.key}" value "${display}" (must be >= ${entry.minValue})`
      );
    }
    if (entry.maxValue !== undefined && n > entry.maxValue) {
      throw new HttpError(
        400,
        `Invalid runtime config "${entry.key}" value "${display}" (must be <= ${entry.maxValue})`
      );
    }
  }
}

function assertWritableType(entry: RuntimeConfigKeyEntry): void {
  const writableTypes: readonly RuntimeConfigType[] = ["string", "enum", "int", "secret"];
  if (!writableTypes.includes(entry.type)) {
    throw new HttpError(400, `Runtime config "${entry.key}" is not writable`);
  }
}

export function registerRuntimeConfigRoutes(
  server: FastifyInstance,
  dependencies: RuntimeConfigRoutesDependencies
): void {
  const { dataContext, resolveAccessContext, repository } = dependencies;

  server.get(
    "/api/admin/runtime-config/:key",
    { schema: getRuntimeConfigRouteSchema },
    async (request, reply) => {
      try {
        const key = readKeyParam(request);
        requireRuntimeEntry(key);
        const accessContext = await resolveAccessContext(request);
        const config = await dataContext.withDataContext(accessContext, async (scopedDb) => {
          await assertAdminUser(repository, scopedDb, accessContext.actorUserId);
          const resolver = new RuntimeConfigResolver(scopedDb, dependencies.env);
          return resolver.getStatus(key);
        });
        return { config: config satisfies RuntimeConfigStatusDto };
      } catch (error) {
        return handleSettingsRouteError(error, reply);
      }
    }
  );

  server.put(
    "/api/admin/runtime-config/:key",
    { schema: putRuntimeConfigRouteSchema },
    async (request, reply) => {
      try {
        const key = readKeyParam(request);
        const entry = requireRuntimeEntry(key);
        assertWritableType(entry);
        const body = request.body as PutRuntimeConfigRequest;
        const value = typeof body?.value === "string" ? body.value.trim() : "";
        validateRuntimeValue(entry, value);

        const accessContext = await resolveAccessContext(request);
        const config = await dataContext.withDataContext(accessContext, async (scopedDb) => {
          await assertAdminUser(repository, scopedDb, accessContext.actorUserId);
          if (value.length === 0) {
            await repository.deleteInstanceSetting(scopedDb, {
              key,
              actorUserId: accessContext.actorUserId,
              requestId: requireRequestId(accessContext),
              action: `runtime_config.${key}.delete`
            });
          } else {
            await repository.upsertInstanceSetting(scopedDb, {
              key,
              value: { value },
              updatedByUserId: accessContext.actorUserId,
              requestId: requireRequestId(accessContext),
              action: `runtime_config.${key}.set`,
              metadata: { key }
            });
          }
          const resolver = new RuntimeConfigResolver(scopedDb, dependencies.env);
          return resolver.getStatus(key);
        });
        dependencies.onConfigChanged?.(key);
        return { config: config satisfies RuntimeConfigStatusDto };
      } catch (error) {
        return handleSettingsRouteError(error, reply);
      }
    }
  );
}
