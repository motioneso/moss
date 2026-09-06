import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import { dataContextBrand, JsonSecretCipher, type DataContextDb } from "@moss/db";

import {
  generateFamilyKey,
  getFamilyKeyStatus,
  INTEGRATIONS_FAMILY,
  invalidateFamilyKeyCache,
  loadFamilyKeyring,
  rotateFamilyKey,
  SECRET_INSTANCE_SETTING_KEYS
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

  it("data locked under the env key stays readable after moving into the store", async () => {
    invalidateFamilyKeyCache();
    const envSecret = "e".repeat(40);
    const env = {
      NODE_ENV: "production",
      ...MASTER_ENV,
      JARVIS_INTEGRATIONS_SECRET_KEY: envSecret
    };
    const { scopedDb, store } = createMockDb();
    const repository = createMockRepository(store);

    const before = await loadFamilyKeyring(scopedDb, INTEGRATIONS_FAMILY, env);
    expect(before).not.toBeNull();
    const sealed = new JsonSecretCipher(before!, "test").encryptJson({ secret: "credential-1" });

    await generateFamilyKey(scopedDb, repository, {
      family: INTEGRATIONS_FAMILY,
      actorUserId: "u1",
      requestId: "r1",
      env
    });
    invalidateFamilyKeyCache();
    const after = await loadFamilyKeyring(scopedDb, INTEGRATIONS_FAMILY, {
      NODE_ENV: "production",
      ...MASTER_ENV
    });
    expect(after).not.toBeNull();
    const opened = new JsonSecretCipher(after!, "test").decryptJson(
      new JsonSecretCipher(after!, "test").parseEnvelope(sealed)
    );
    expect(opened.secret).toBe("credential-1");
  });

  it("data locked under the first key stays readable after two rotations", async () => {
    invalidateFamilyKeyCache();
    const env = { NODE_ENV: "production", ...MASTER_ENV };
    const { scopedDb, store } = createMockDb();
    const repository = createMockRepository(store);
    const write = { family: INTEGRATIONS_FAMILY, actorUserId: "u1", requestId: "r1", env };

    await generateFamilyKey(scopedDb, repository, write);
    const first = await loadFamilyKeyring(scopedDb, INTEGRATIONS_FAMILY, env);
    const sealed = new JsonSecretCipher(first!, "test").encryptJson({ secret: "credential-1" });

    await generateFamilyKey(scopedDb, repository, write);
    invalidateFamilyKeyCache();
    await generateFamilyKey(scopedDb, repository, write);
    invalidateFamilyKeyCache();
    const third = await loadFamilyKeyring(scopedDb, INTEGRATIONS_FAMILY, env);
    expect(third?.currentKeyId).toBe("s3");
    const opened = new JsonSecretCipher(third!, "test").decryptJson(
      new JsonSecretCipher(third!, "test").parseEnvelope(sealed)
    );
    expect(opened.secret).toBe("credential-1");
  });

  it("carries every retired env key into the store, not just the current one", async () => {
    invalidateFamilyKeyCache();
    const env = {
      NODE_ENV: "production",
      ...MASTER_ENV,
      JARVIS_INTEGRATIONS_SECRET_KEY: "e".repeat(40),
      JARVIS_INTEGRATIONS_SECRET_KEYS: JSON.stringify({ v0: "o".repeat(40) })
    };
    const { scopedDb, store } = createMockDb();
    const repository = createMockRepository(store);

    // Seal under the RETIRED env key ("v0"), not the current one, so the test
    // fails if the move carries only the current secret.
    const retiredKeyring = {
      currentKeyId: "v0",
      keys: new Map([["v0", createHash("sha256").update("o".repeat(40)).digest()]]),
      legacyCandidates: [createHash("sha256").update("o".repeat(40)).digest()]
    };
    const sealed = new JsonSecretCipher(retiredKeyring, "test").encryptJson({
      secret: "old-data"
    });

    await generateFamilyKey(scopedDb, repository, {
      family: INTEGRATIONS_FAMILY,
      actorUserId: "u1",
      requestId: "r1",
      env
    });
    invalidateFamilyKeyCache();
    const after = await loadFamilyKeyring(scopedDb, INTEGRATIONS_FAMILY, {
      NODE_ENV: "production",
      ...MASTER_ENV
    });
    expect(after!.keys.has("v0")).toBe(true);
    const opened = new JsonSecretCipher(after!, "test").decryptJson(
      new JsonSecretCipher(after!, "test").parseEnvelope(sealed)
    );
    expect(opened.secret).toBe("old-data");
  });

  it("a row that no longer decrypts reports broken and recovers by replacement", async () => {
    invalidateFamilyKeyCache();
    const masterA = { ...MASTER_ENV };
    const masterB = { JARVIS_AI_SECRET_KEY: "n".repeat(40) };
    const envA = { NODE_ENV: "production", ...masterA };
    const envB = { NODE_ENV: "production", ...masterB };
    const { scopedDb, store } = createMockDb();
    const repository = createMockRepository(store);

    // The real operator case: a well-formed row sealed under one master secret,
    // read after the master changed without keeping the old one.
    await generateFamilyKey(scopedDb, repository, {
      family: INTEGRATIONS_FAMILY,
      actorUserId: "u1",
      requestId: "r1",
      env: envA
    });
    invalidateFamilyKeyCache();
    const status = await getFamilyKeyStatus(scopedDb, envB);
    expect(status).toEqual([{ family: "integrations", source: "broken" }]);
    await expect(loadFamilyKeyring(scopedDb, INTEGRATIONS_FAMILY, envB)).resolves.toBeNull();

    await rotateFamilyKey(scopedDb, repository, {
      family: INTEGRATIONS_FAMILY,
      actorUserId: "u1",
      requestId: "r1",
      env: envB
    });
    const writes = repository.calls as { metadata: Record<string, unknown> }[];
    expect(writes).toHaveLength(2);
    expect(writes[1]!.metadata).toEqual({
      key: "keys.integrations",
      recoveredFromUnreadable: true
    });
    invalidateFamilyKeyCache();
    expect(await getFamilyKeyStatus(scopedDb, envB)).toEqual([
      { family: "integrations", source: "store" }
    ]);
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
    expect(SECRET_INSTANCE_SETTING_KEYS.has("keys.integrations")).toBe(true);
  });
});
