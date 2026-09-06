import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { dataContextBrand, type DataContextDb } from "@moss/db";
import { registerFamilyKeyRoutes } from "@moss/settings";

function createHarness(admin: boolean | null) {
  const store = new Map<string, unknown>();
  const keyChanges: unknown[] = [];
  const scopedDb = {
    [dataContextBrand]: true,
    db: {
      selectFrom: (_table: string) => ({
        select: (_cols: unknown) => ({
          where: (_col: string, _op: string, val: string) => ({
            executeTakeFirst: async () => {
              if (store.has(val)) return { value: { value: store.get(val) } };
              return undefined;
            }
          })
        })
      })
    }
  } as unknown as DataContextDb;
  const repository = {
    async getUserById() {
      if (admin === null) return null;
      return { id: "admin", is_instance_admin: admin };
    },
    async upsertInstanceSetting(_db: DataContextDb, input: { key: string; value: unknown }) {
      store.set(input.key, (input.value as { value?: unknown })?.value ?? null);
    }
  };
  const app = Fastify();
  registerFamilyKeyRoutes(app, {
    dataContext: {
      withDataContext: async (_ctx: unknown, work: (db: unknown) => unknown) => work(scopedDb)
    } as never,
    resolveAccessContext: async () => ({ actorUserId: "admin", requestId: "r1" }),
    repository: repository as never,
    onKeyChanged: () => void keyChanges.push(true)
  });
  return { app, keyChanges };
}

describe("family key admin routes (#2312 slice 1)", () => {
  it("reports missing, generates, then reports stored, firing the change hook", async () => {
    const { app, keyChanges } = createHarness(true);
    const before = await app.inject({ method: "GET", url: "/api/admin/settings/encryption-keys" });
    expect(before.statusCode).toBe(200);
    expect(before.json()).toEqual({
      keys: [
        { family: "integrations", source: "missing" },
        { family: "module_credential", source: "missing" },
        { family: "news_credential", source: "missing" }
      ]
    });

    const put = await app.inject({
      method: "PUT",
      url: "/api/admin/settings/encryption-keys",
      payload: { family: "integrations" }
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({
      keys: [
        { family: "integrations", source: "store" },
        { family: "module_credential", source: "missing" },
        { family: "news_credential", source: "missing" }
      ]
    });
    expect(keyChanges).toHaveLength(1);
    expect(JSON.stringify(put.json())).not.toContain("ciphertext");
  });

  it("generates each new family with no route changes", async () => {
    const { app } = createHarness(true);
    for (const family of ["module_credential", "news_credential"]) {
      const put = await app.inject({
        method: "PUT",
        url: "/api/admin/settings/encryption-keys",
        payload: { family }
      });
      expect(put.statusCode).toBe(200);
      expect(
        (put.json() as { keys: { family: string; source: string }[] }).keys.find(
          (k) => k.family === family
        )?.source
      ).toBe("store");
    }
  });

  it("rejects unknown families and rotate-with-nothing as 404", async () => {
    const { app } = createHarness(true);
    const put = await app.inject({
      method: "PUT",
      url: "/api/admin/settings/encryption-keys",
      payload: { family: "nope" }
    });
    expect(put.statusCode).toBe(404);
    const rotate = await app.inject({
      method: "POST",
      url: "/api/admin/settings/encryption-keys/rotate",
      payload: { family: "integrations" }
    });
    expect(rotate.statusCode).toBe(404);
  });

  it("rotates an existing key and keeps the endpoint admin-only", async () => {
    const { app } = createHarness(true);
    await app.inject({
      method: "PUT",
      url: "/api/admin/settings/encryption-keys",
      payload: { family: "integrations" }
    });
    const rotate = await app.inject({
      method: "POST",
      url: "/api/admin/settings/encryption-keys/rotate",
      payload: { family: "integrations" }
    });
    expect(rotate.statusCode).toBe(200);
    expect(rotate.json()).toEqual({
      keys: [
        { family: "integrations", source: "store" },
        { family: "module_credential", source: "missing" },
        { family: "news_credential", source: "missing" }
      ]
    });

    const nonAdmin = createHarness(false);
    for (const request of [
      { method: "GET", url: "/api/admin/settings/encryption-keys" },
      {
        method: "PUT",
        url: "/api/admin/settings/encryption-keys",
        payload: { family: "integrations" }
      },
      {
        method: "POST",
        url: "/api/admin/settings/encryption-keys/rotate",
        payload: { family: "integrations" }
      }
    ] as const) {
      const denied = await nonAdmin.app.inject(request);
      expect(denied.statusCode).toBe(403);
    }
  });

  it("refuses callers with no identity on every endpoint", async () => {
    const { app } = createHarness(null);
    for (const request of [
      { method: "GET", url: "/api/admin/settings/encryption-keys" },
      {
        method: "PUT",
        url: "/api/admin/settings/encryption-keys",
        payload: { family: "integrations" }
      },
      {
        method: "POST",
        url: "/api/admin/settings/encryption-keys/rotate",
        payload: { family: "integrations" }
      }
    ] as const) {
      const denied = await app.inject(request);
      expect(denied.statusCode).toBe(401);
    }
  });
});
