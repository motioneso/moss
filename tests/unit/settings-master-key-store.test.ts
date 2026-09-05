import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import { dataContextBrand, type DataContextDb } from "@moss/db";

import {
  generateFamilyKey,
  getFamilyKeyStatus,
  INTEGRATIONS_FAMILY,
  invalidateFamilyKeyCache,
  loadFamilyKeyring,
  SECRET_FAMILY_SETTINGS
} from "@moss/settings";

function createMockDb(settings: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(settings));
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
  return { scopedDb, store };
}

function createMockRepository(store: Map<string, unknown>) {
  const calls: unknown[] = [];
  return {
    calls,
    async upsertInstanceSetting(_scopedDb: DataContextDb, input: { key: string; value: unknown }) {
      calls.push(input);
      store.set(input.key, (input.value as { value?: unknown })?.value ?? null);
    }
  };
}

const MASTER_ENV = { JARVIS_AI_SECRET_KEY: "m".repeat(40) };

describe("family key store (#2312 slice 1)", () => {
  it("missing row and no env key resolves to null, never throws, even in production", async () => {
    invalidateFamilyKeyCache();
    const { scopedDb } = createMockDb();
    const env = { NODE_ENV: "production", ...MASTER_ENV };
    await expect(loadFamilyKeyring(scopedDb, INTEGRATIONS_FAMILY, env)).resolves.toBeNull();
  });

  it("env key wins when set, with existing rotation semantics", async () => {
    invalidateFamilyKeyCache();
    const { scopedDb } = createMockDb();
    const env = {
      NODE_ENV: "production",
      ...MASTER_ENV,
      JARVIS_INTEGRATIONS_SECRET_KEY: "e".repeat(40)
    };
    const keyring = await loadFamilyKeyring(scopedDb, INTEGRATIONS_FAMILY, env);
    expect(keyring).not.toBeNull();
    const expected = createHash("sha256").update("e".repeat(40)).digest("hex");
    expect(keyring?.keys.get("v1")?.toString("hex")).toBe(expected);
  });

  it("generate stores an envelope the loader reads back as the same bytes", async () => {
    invalidateFamilyKeyCache();
    const { scopedDb, store } = createMockDb();
    const repository = createMockRepository(store);
    await generateFamilyKey(scopedDb, repository, {
      family: INTEGRATIONS_FAMILY,
      actorUserId: "u1",
      requestId: "r1",
      env: MASTER_ENV
    });
    invalidateFamilyKeyCache();
    const keyring = await loadFamilyKeyring(scopedDb, INTEGRATIONS_FAMILY, {
      ...MASTER_ENV,
      NODE_ENV: "production"
    });
    expect(keyring).not.toBeNull();
    expect(keyring?.keys.get("s1")?.length).toBe(32);
  });

  it("status reports env, store, and missing sources", async () => {
    invalidateFamilyKeyCache();
    const { scopedDb, store } = createMockDb();
    const missing = await getFamilyKeyStatus(scopedDb, {
      NODE_ENV: "production",
      ...MASTER_ENV
    });
    expect(missing).toEqual([{ family: "integrations", source: "missing" }]);

    const repository = createMockRepository(store);
    await generateFamilyKey(scopedDb, repository, {
      family: INTEGRATIONS_FAMILY,
      actorUserId: "u1",
      requestId: "r1",
      env: MASTER_ENV
    });
    invalidateFamilyKeyCache();
    const stored = await getFamilyKeyStatus(scopedDb, {
      NODE_ENV: "production",
      ...MASTER_ENV
    });
    expect(stored).toEqual([{ family: "integrations", source: "store" }]);

    const fromEnv = await getFamilyKeyStatus(scopedDb, {
      NODE_ENV: "production",
      ...MASTER_ENV,
      JARVIS_INTEGRATIONS_SECRET_KEY: "e".repeat(40)
    });
    expect(fromEnv).toEqual([{ family: "integrations", source: "env" }]);
  });

  it("status payloads never contain key material", async () => {
    invalidateFamilyKeyCache();
    const { scopedDb, store } = createMockDb();
    const repository = createMockRepository(store);
    await generateFamilyKey(scopedDb, repository, {
      family: INTEGRATIONS_FAMILY,
      actorUserId: "u1",
      requestId: "r1",
      env: MASTER_ENV
    });
    invalidateFamilyKeyCache();
    const status = await getFamilyKeyStatus(scopedDb, { ...MASTER_ENV });
    const writes = repository.calls as { value: { value: { ciphertext: string } } }[];
    expect(writes).toHaveLength(1);
    const material = writes[0]!.value.value.ciphertext;
    expect(typeof material).toBe("string");
    expect(JSON.stringify(status)).not.toContain(material);
    expect(SECRET_FAMILY_SETTINGS.has("keys.integrations")).toBe(true);
  });
});
