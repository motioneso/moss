import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import {
  dataContextBrand,
  type AccessContext,
  type DataContextDb,
  type DataContextRunner
} from "../../packages/db/src/index.js";
import {
  BRAVE_API_KEY_CONFIG_KEY,
  CHAT_PERSISTENT_POOL_CAP_CONFIG_KEY,
  EMBED_PROVIDER_CONFIG_KEY
} from "../../packages/settings/src/runtime-config-keys.js";
import { registerRuntimeConfigRoutes } from "../../packages/settings/src/runtime-config-routes.js";
import type { SettingsRepository } from "../../packages/settings/src/repository.js";

const ACTOR_ID = "00000000-0000-4000-8000-000000000001";

function makeScopedDb(settings: Map<string, Record<string, unknown>>): DataContextDb {
  return {
    [dataContextBrand]: true,
    db: {
      selectFrom: () => ({
        select: () => ({
          where: (_column: string, _op: string, key: string) => ({
            executeTakeFirst: async () => {
              const value = settings.get(key);
              return value === undefined ? undefined : { value };
            }
          })
        })
      })
    }
  } as unknown as DataContextDb;
}

function makeServer(options?: {
  readonly initialSettings?: readonly [string, Record<string, unknown>][];
  readonly env?: NodeJS.ProcessEnv;
}): {
  readonly server: FastifyInstance;
  readonly upserts: unknown[];
} {
  const server = Fastify({ logger: false });
  const settings = new Map(options?.initialSettings ?? []);
  const scopedDb = makeScopedDb(settings);
  const upserts: unknown[] = [];

  registerRuntimeConfigRoutes(server, {
    dataContext: {
      withDataContext: async <T>(
        _accessContext: AccessContext,
        work: (db: DataContextDb) => Promise<T>
      ): Promise<T> => work(scopedDb)
    } as unknown as DataContextRunner,
    resolveAccessContext: async () => ({ actorUserId: ACTOR_ID, requestId: "req-runtime-config" }),
    repository: {
      getUserById: async () => ({
        id: ACTOR_ID,
        email: "admin@example.com",
        name: "Admin",
        email_verified: true,
        image: null,
        is_instance_admin: true,
        status: "active",
        is_bootstrap_owner: false,
        created_at: new Date("2026-01-01T00:00:00.000Z"),
        updated_at: new Date("2026-01-01T00:00:00.000Z")
      }),
      upsertInstanceSetting: async (_db: DataContextDb, input) => {
        upserts.push(input);
        settings.set(String(input.key), input.value as Record<string, unknown>);
        return {
          key: input.key,
          value: input.value,
          updated_by_user_id: input.updatedByUserId,
          created_at: new Date("2026-01-01T00:00:00.000Z"),
          updated_at: new Date("2026-01-01T00:00:00.000Z")
        };
      },
      deleteInstanceSetting: async (_db: DataContextDb, input: { key: string }) => {
        return settings.delete(input.key);
      }
    } satisfies Pick<
      SettingsRepository,
      "getUserById" | "upsertInstanceSetting" | "deleteInstanceSetting"
    > as unknown as SettingsRepository,
    env: options?.env ?? {}
  });

  return { server, upserts };
}

describe("runtime config admin routes", () => {
  let server: FastifyInstance | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("returns instance config status without exposing anything extra", async () => {
    // #1313: GET intentionally still surfaces a legacy/misconfigured "stub" instance-settings
    // row rather than erroring — GET reads via `resolve()`, which does no enum validation, so an
    // admin can still see (and then correct) an instance that somehow ended up on the fake
    // provider before this fix shipped. The PATCH write path below is what's actually gated.
    ({ server } = makeServer({
      initialSettings: [[EMBED_PROVIDER_CONFIG_KEY, { value: "stub" }]],
      env: { JARVIS_EMBED_PROVIDER: "local" }
    }));

    const res = await server.inject({
      method: "GET",
      url: `/api/admin/runtime-config/${EMBED_PROVIDER_CONFIG_KEY}`
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ config: { value: "stub", source: "instance" } });
  });

  it("validates and upserts runtime config with metadata-only audit data", async () => {
    const made = makeServer();
    server = made.server;

    const res = await server.inject({
      method: "PUT",
      url: `/api/admin/runtime-config/${EMBED_PROVIDER_CONFIG_KEY}`,
      payload: { value: "local" }
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ config: { value: "local", source: "instance" } });
    expect(made.upserts).toMatchObject([
      {
        key: EMBED_PROVIDER_CONFIG_KEY,
        value: { value: "local" },
        updatedByUserId: ACTOR_ID,
        requestId: "req-runtime-config",
        action: "runtime_config.ai.embed_provider.set",
        metadata: { key: EMBED_PROVIDER_CONFIG_KEY }
      }
    ]);
    expect(JSON.stringify(made.upserts)).not.toContain('"stub","');
  });

  it("rejects invalid enum values before writing", async () => {
    const made = makeServer();
    server = made.server;

    const res = await server.inject({
      method: "PUT",
      url: `/api/admin/runtime-config/${EMBED_PROVIDER_CONFIG_KEY}`,
      payload: { value: "stb" }
    });

    expect(res.statusCode).toBe(400);
    expect(made.upserts).toEqual([]);
  });

  // #1313: acceptance criterion — a PATCH/PUT of ai.embed_provider=stub must be rejected on a
  // normal instance. "stub" used to be a valid enum value; it's now excluded specifically so
  // neither an admin nor module self-operation (epic #1262) can silently disable search by
  // switching a real instance onto the fake, test-only embedding provider.
  it("rejects the test-only stub embedding provider on a normal instance (#1313)", async () => {
    const made = makeServer();
    server = made.server;

    const res = await server.inject({
      method: "PUT",
      url: `/api/admin/runtime-config/${EMBED_PROVIDER_CONFIG_KEY}`,
      payload: { value: "stub" }
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("stub");
    expect(made.upserts).toEqual([]);
  });

  it("rejects an int value below minValue, leaving the existing value unchanged (#1554)", async () => {
    const made = makeServer();
    server = made.server;

    const res = await server.inject({
      method: "PUT",
      url: `/api/admin/runtime-config/${CHAT_PERSISTENT_POOL_CAP_CONFIG_KEY}`,
      payload: { value: "0" }
    });

    expect(res.statusCode).toBe(400);
    expect(made.upserts).toEqual([]);

    const getRes = await server.inject({
      method: "GET",
      url: `/api/admin/runtime-config/${CHAT_PERSISTENT_POOL_CAP_CONFIG_KEY}`
    });
    expect(getRes.json()).toEqual({ config: { value: "4", source: "default" } });
  });

  it("accepts an int value at or above minValue (#1554)", async () => {
    const made = makeServer();
    server = made.server;

    const res = await server.inject({
      method: "PUT",
      url: `/api/admin/runtime-config/${CHAT_PERSISTENT_POOL_CAP_CONFIG_KEY}`,
      payload: { value: "8" }
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ config: { value: "8", source: "instance" } });
  });

  it("still rejects non-integer values for a bounded int key (#1554)", async () => {
    const made = makeServer();
    server = made.server;

    const res = await server.inject({
      method: "PUT",
      url: `/api/admin/runtime-config/${CHAT_PERSISTENT_POOL_CAP_CONFIG_KEY}`,
      payload: { value: "3.5" }
    });

    expect(res.statusCode).toBe(400);
    expect(made.upserts).toEqual([]);
  });

  it("redacts secret values in GET status response", async () => {
    ({ server } = makeServer({
      initialSettings: [[BRAVE_API_KEY_CONFIG_KEY, { value: "BSA-secret-key-123" }]]
    }));

    const res = await server.inject({
      method: "GET",
      url: `/api/admin/runtime-config/${BRAVE_API_KEY_CONFIG_KEY}`
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.config.value).toBeNull();
    expect(body.config.source).toBe("instance");
    expect(res.body).not.toContain("BSA-secret-key-123");
  });
});
