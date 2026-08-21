import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AccessContext, DataContextDb, DataContextRunner, User } from "@moss/db";
import { HttpError } from "@moss/module-sdk";
import {
  getAdminYoloSettingsRouteSchema,
  getYoloSettingsRouteSchema,
  putAdminYoloInstanceRouteSchema,
  putAdminYoloUserRouteSchema,
  putYoloSelfRouteSchema,
  type PutYoloSelfRequest,
  type PutYoloInstanceRequest,
  type PutYoloUserRequest,
  type YoloAdminSettingsResponse,
  type YoloSettingsResponse
} from "@moss/shared";

import type { ProfilePreferencesPort } from "./preferences-port.js";
import type { SettingsRepository } from "./repository.js";
import { serializeUser } from "./routes-serializers.js";

const YOLO_INSTANCE_SETTING_KEY = "yolo.instance_enabled";
const YOLO_ALLOWED_PREF_KEY = "yolo.allowed";
const YOLO_ENABLED_PREF_KEY = "yolo.enabled";

export function registerYoloRoutes(
  server: FastifyInstance,
  deps: {
    readonly dataContext: DataContextRunner;
    readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
    readonly repository: SettingsRepository;
    readonly preferencesRepository: ProfilePreferencesPort;
    readonly assertAdminUser: (scopedDb: DataContextDb, userId: string) => Promise<User>;
    readonly handleRouteError: (error: unknown, reply: FastifyReply) => unknown;
    readonly requireRequestId: (accessContext: AccessContext) => string;
  }
): void {
  server.get("/api/me/yolo", { schema: getYoloSettingsRouteSchema }, async (request, reply) => {
    try {
      const access = await deps.resolveAccessContext(request);
      return await deps.dataContext.withDataContext(access, (scopedDb) =>
        readSelf(scopedDb, deps.preferencesRepository)
      );
    } catch (error) {
      return deps.handleRouteError(error, reply);
    }
  });

  server.put("/api/me/yolo", { schema: putYoloSelfRouteSchema }, async (request, reply) => {
    try {
      const access = await deps.resolveAccessContext(request);
      const body = request.body as PutYoloSelfRequest;
      return await deps.dataContext.withDataContext(access, async (scopedDb) => {
        const current = await readSelf(scopedDb, deps.preferencesRepository);
        if (body.enabled && !current.self.allowed) {
          throw new HttpError(403, "YOLO mode is not enabled for this account");
        }
        await deps.preferencesRepository.upsert(scopedDb, YOLO_ENABLED_PREF_KEY, body.enabled);
        return readSelf(scopedDb, deps.preferencesRepository);
      });
    } catch (error) {
      return deps.handleRouteError(error, reply);
    }
  });

  server.get(
    "/api/admin/yolo",
    { schema: getAdminYoloSettingsRouteSchema },
    async (request, reply) => {
      try {
        const access = await deps.resolveAccessContext(request);
        return await readAdmin(deps, access);
      } catch (error) {
        return deps.handleRouteError(error, reply);
      }
    }
  );

  server.put(
    "/api/admin/yolo/instance",
    { schema: putAdminYoloInstanceRouteSchema },
    async (request, reply) => {
      try {
        const access = await deps.resolveAccessContext(request);
        const body = request.body as PutYoloInstanceRequest;
        await deps.dataContext.withDataContext(access, async (scopedDb) => {
          await deps.assertAdminUser(scopedDb, access.actorUserId);
          await deps.repository.upsertInstanceSetting(scopedDb, {
            key: YOLO_INSTANCE_SETTING_KEY,
            value: { enabled: body.enabled },
            updatedByUserId: access.actorUserId,
            requestId: deps.requireRequestId(access),
            action: "yolo.instance.set"
          });
          if (body.enabled) {
            await deps.preferencesRepository.upsert(scopedDb, YOLO_ALLOWED_PREF_KEY, true);
            await deps.preferencesRepository.upsert(scopedDb, YOLO_ENABLED_PREF_KEY, true);
          }
        });
        return await readAdmin(deps, access);
      } catch (error) {
        return deps.handleRouteError(error, reply);
      }
    }
  );

  server.put(
    "/api/admin/yolo/users/:id",
    { schema: putAdminYoloUserRouteSchema },
    async (request, reply) => {
      try {
        const access = await deps.resolveAccessContext(request);
        const { id } = request.params as { id: string };
        const body = request.body as PutYoloUserRequest;
        await deps.dataContext.withDataContext(access, async (scopedDb) => {
          await deps.assertAdminUser(scopedDb, access.actorUserId);
          const user = await deps.repository.getUserById(scopedDb, id);
          if (!user) throw new HttpError(404, "User not found");
        });
        await writeUserPrefs(deps, id, {
          allowed: body.allowed,
          enabled: body.allowed ? undefined : false
        });
        return await readAdmin(deps, access);
      } catch (error) {
        return deps.handleRouteError(error, reply);
      }
    }
  );

  server.post(
    "/api/admin/yolo/allow-all",
    { schema: getAdminYoloSettingsRouteSchema },
    async (request, reply) => {
      try {
        const access = await deps.resolveAccessContext(request);
        const users = await deps.dataContext.withDataContext(access, async (scopedDb) => {
          await deps.assertAdminUser(scopedDb, access.actorUserId);
          return deps.repository.listUsers(scopedDb);
        });
        for (const user of users.filter((u) => !u.is_instance_admin)) {
          await writeUserPrefs(deps, user.id, { allowed: true });
        }
        return await readAdmin(deps, access);
      } catch (error) {
        return deps.handleRouteError(error, reply);
      }
    }
  );
}

async function readSelf(
  scopedDb: DataContextDb,
  prefs: ProfilePreferencesPort
): Promise<YoloSettingsResponse> {
  const instanceEnabled = await readMaster(scopedDb);
  const allowed = (await prefs.get(scopedDb, YOLO_ALLOWED_PREF_KEY)) === true;
  const enabled = (await prefs.get(scopedDb, YOLO_ENABLED_PREF_KEY)) === true;
  return {
    instanceEnabled,
    self: { allowed, enabled, active: composeYoloActive(instanceEnabled, allowed, enabled) }
  };
}

function composeYoloActive(instanceEnabled: boolean, allowed: boolean, enabled: boolean): boolean {
  return instanceEnabled && allowed && enabled;
}

/**
 * The single "stop asking me" gate: instance flag, per-user allow, per-user enable.
 * Shared so no third consumer (after the routes above) re-composes these three reads itself.
 */
export async function isYoloActiveForActor(
  scopedDb: DataContextDb,
  prefs: Pick<ProfilePreferencesPort, "get">
): Promise<boolean> {
  const instanceEnabled = await readMaster(scopedDb);
  const allowed = (await prefs.get(scopedDb, YOLO_ALLOWED_PREF_KEY)) === true;
  const enabled = (await prefs.get(scopedDb, YOLO_ENABLED_PREF_KEY)) === true;
  return composeYoloActive(instanceEnabled, allowed, enabled);
}

async function readAdmin(
  deps: Parameters<typeof registerYoloRoutes>[1],
  access: AccessContext
): Promise<YoloAdminSettingsResponse> {
  const { instanceEnabled, users } = await deps.dataContext.withDataContext(
    access,
    async (scopedDb) => {
      await deps.assertAdminUser(scopedDb, access.actorUserId);
      return {
        instanceEnabled: await readMaster(scopedDb),
        users: await deps.repository.listUsers(scopedDb)
      };
    }
  );
  const rows = [];
  for (const user of users) {
    const state = await deps.dataContext.withDataContext(
      { actorUserId: user.id, requestId: access.requestId },
      (scopedDb) => readSelf(scopedDb, deps.preferencesRepository)
    );
    rows.push({
      ...serializeUser(user),
      yoloAllowed: state.self.allowed,
      yoloEnabled: state.self.enabled,
      yoloActive: instanceEnabled && state.self.allowed && state.self.enabled
    });
  }
  return { instanceEnabled, users: rows };
}

async function readMaster(scopedDb: DataContextDb): Promise<boolean> {
  const row = await scopedDb.db
    .selectFrom("app.instance_settings")
    .select("value")
    .where("key", "=", YOLO_INSTANCE_SETTING_KEY)
    .executeTakeFirst();
  return (row?.value as { enabled?: boolean } | undefined)?.enabled === true;
}

async function writeUserPrefs(
  deps: Parameters<typeof registerYoloRoutes>[1],
  userId: string,
  input: { readonly allowed?: boolean; readonly enabled?: boolean }
): Promise<void> {
  await deps.dataContext.withDataContext(
    { actorUserId: userId, requestId: "yolo:admin" },
    async (scopedDb) => {
      if (input.allowed !== undefined) {
        await deps.preferencesRepository.upsert(scopedDb, YOLO_ALLOWED_PREF_KEY, input.allowed);
      }
      if (input.enabled !== undefined) {
        await deps.preferencesRepository.upsert(scopedDb, YOLO_ENABLED_PREF_KEY, input.enabled);
      }
    }
  );
}
