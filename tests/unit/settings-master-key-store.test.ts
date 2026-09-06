import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import { dataContextBrand, JsonSecretCipher, type DataContextDb } from "@moss/db";

import { createIntegrationsCipherFromKeyring } from "@moss/integrations";

import {
  createMasterKeyStoreCipher,
  decryptWithFamilyKeyRefresh,
  familyByName,
  FAMILY_KEY_CACHE_TTL_MS,
  generateFamilyKey,
  getFamilyKeyStatus,
  INTEGRATIONS_FAMILY,
  invalidateFamilyKeyCache,
  loadFamilyKeyring,
  MODULE_CREDENTIAL_FAMILY,
  NEWS_CREDENTIAL_FAMILY,
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

describe("family key store (#2312 slice 1, #2322 slice 2)", () => {
  it("resolves all three families by name with their store keys and env names", () => {
    expect(familyByName("integrations")).toBe(INTEGRATIONS_FAMILY);
    expect(familyByName("module_credential")).toBe(MODULE_CREDENTIAL_FAMILY);
    expect(familyByName("news_credential")).toBe(NEWS_CREDENTIAL_FAMILY);
    expect(MODULE_CREDENTIAL_FAMILY?.settingKey).toBe("keys.module_credential");
    expect(MODULE_CREDENTIAL_FAMILY?.keyEnvVar).toBe("JARVIS_MODULE_CREDENTIAL_SECRET_KEY");
    expect(NEWS_CREDENTIAL_FAMILY?.settingKey).toBe("keys.news_credential");
    expect(NEWS_CREDENTIAL_FAMILY?.keyEnvVar).toBe("JARVIS_NEWS_CREDENTIAL_SECRET_KEY");
    expect(familyByName("nope")).toBeNull();
  });

  it("both new families read env through the newer prefix with legacy fallback", async () => {
    invalidateFamilyKeyCache();
    const { scopedDb } = createMockDb();
    const base = { NODE_ENV: "production", ...MASTER_ENV };
    for (const [family, mossName, jarvisName] of [
      [
        MODULE_CREDENTIAL_FAMILY,
        "MOSS_MODULE_CREDENTIAL_SECRET_KEY",
        "JARVIS_MODULE_CREDENTIAL_SECRET_KEY"
      ],
      [
        NEWS_CREDENTIAL_FAMILY,
        "MOSS_NEWS_CREDENTIAL_SECRET_KEY",
        "JARVIS_NEWS_CREDENTIAL_SECRET_KEY"
      ]
    ] as const) {
      invalidateFamilyKeyCache();
      const fromMoss = await loadFamilyKeyring(scopedDb, family, {
        ...base,
        [mossName]: "n".repeat(40)
      });
      expect(fromMoss).not.toBeNull();
      const statusMoss = await getFamilyKeyStatus(scopedDb, {
        ...base,
        [mossName]: "n".repeat(40)
      });
      expect(statusMoss.find((s) => s.family === family.name)?.source).toBe("env");
      invalidateFamilyKeyCache();
      const fromLegacy = await loadFamilyKeyring(scopedDb, family, {
        ...base,
        [jarvisName]: "o".repeat(40)
      });
      expect(fromLegacy).not.toBeNull();
    }
  });

  it("falls back to the development default outside hardened environments", async () => {
    invalidateFamilyKeyCache();
    const { scopedDb } = createMockDb();
    // No NODE_ENV, no keys anywhere: the old constructor behavior, so a fresh
    // dev install works with zero setup.
    const keyring = await loadFamilyKeyring(scopedDb, MODULE_CREDENTIAL_FAMILY, {
      ...MASTER_ENV
    });
    expect(keyring).not.toBeNull();
    const expected = createHash("sha256")
      .update("jarv1s-development-module-credential-secret")
      .digest("hex");
    expect(keyring?.keys.get("v1")?.toString("hex")).toBe(expected);
  });

  it("status lists all three families as missing on an empty store", async () => {
    invalidateFamilyKeyCache();
    const { scopedDb } = createMockDb();
    const missing = await getFamilyKeyStatus(scopedDb, {
      NODE_ENV: "production",
      ...MASTER_ENV
    });
    expect(missing).toEqual([
      { family: "integrations", source: "missing" },
      { family: "module_credential", source: "missing" },
      { family: "news_credential", source: "missing" }
    ]);
  });

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
    expect(missing).toEqual([
      { family: "integrations", source: "missing" },
      { family: "module_credential", source: "missing" },
      { family: "news_credential", source: "missing" }
    ]);

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
    expect(stored).toEqual([
      { family: "integrations", source: "store" },
      { family: "module_credential", source: "missing" },
      { family: "news_credential", source: "missing" }
    ]);

    const fromEnv = await getFamilyKeyStatus(scopedDb, {
      NODE_ENV: "production",
      ...MASTER_ENV,
      JARVIS_INTEGRATIONS_SECRET_KEY: "e".repeat(40)
    });
    expect(fromEnv).toEqual([
      { family: "integrations", source: "env" },
      { family: "module_credential", source: "missing" },
      { family: "news_credential", source: "missing" }
    ]);
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
    expect(status).toEqual([
      { family: "integrations", source: "broken" },
      { family: "module_credential", source: "missing" },
      { family: "news_credential", source: "missing" }
    ]);
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
      { family: "integrations", source: "store" },
      { family: "module_credential", source: "missing" },
      { family: "news_credential", source: "missing" }
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

  it("a second process holding a pre-rotation key decrypts post-rotation data after one reload", async () => {
    invalidateFamilyKeyCache();
    const { scopedDb, store } = createMockDb();
    const repository = createMockRepository(store);
    const write = { family: INTEGRATIONS_FAMILY, actorUserId: "u1", requestId: "r1" };
    await generateFamilyKey(scopedDb, repository, { ...write, env: MASTER_ENV });
    // The worker loads early and never sees the refresh call.
    const workerKeyring = await loadFamilyKeyring(scopedDb, INTEGRATIONS_FAMILY, {
      ...MASTER_ENV,
      NODE_ENV: "production"
    });
    expect(workerKeyring).not.toBeNull();
    // Admin rotates in another process: the row moves on, this cache does not.
    await rotateFamilyKey(scopedDb, repository, { ...write, env: MASTER_ENV });
    // Post-rotation envelope, built from the row without touching this cache.
    const masterCipher = createMasterKeyStoreCipher({ ...MASTER_ENV });
    const rotated = masterCipher.decryptJson(
      masterCipher.parseEnvelope(store.get("keys.integrations"))
    ) as { keyId: string; secret: string };
    const freshCipher = createIntegrationsCipherFromKeyring({
      currentKeyId: rotated.keyId,
      keys: new Map([[rotated.keyId, Buffer.from(rotated.secret, "hex")]]),
      legacyCandidates: [Buffer.from(rotated.secret, "hex")]
    });
    const envelope = freshCipher.encryptJson({ value: "post-rotation" });
    // The stale worker object genuinely cannot read it: this is the live hole.
    const workerCipher = createIntegrationsCipherFromKeyring(workerKeyring!);
    await expect((async () => workerCipher.decryptJson(envelope))()).rejects.toThrow();
    // Through the retry helper the same worker succeeds after one reload.
    const value = await decryptWithFamilyKeyRefresh(
      scopedDb,
      INTEGRATIONS_FAMILY,
      { ...MASTER_ENV, NODE_ENV: "production" },
      (keyring) => createIntegrationsCipherFromKeyring(keyring).decryptJson(envelope)
    );
    expect(value).toEqual({ value: "post-rotation" });
  });

  it("genuinely unreadable data still throws after the single retry", async () => {
    invalidateFamilyKeyCache();
    const { scopedDb, store } = createMockDb();
    const repository = createMockRepository(store);
    await generateFamilyKey(scopedDb, repository, {
      family: INTEGRATIONS_FAMILY,
      actorUserId: "u1",
      requestId: "r1",
      env: MASTER_ENV
    });
    const envelope = { keyId: "nope", ciphertext: "AA==", iv: "AA==" } as never;
    await expect(
      decryptWithFamilyKeyRefresh(
        scopedDb,
        INTEGRATIONS_FAMILY,
        { ...MASTER_ENV, NODE_ENV: "production" },
        (keyring) => createIntegrationsCipherFromKeyring(keyring).decryptJson(envelope)
      )
    ).rejects.toThrow();
  });

  it("expired cache entries reload instead of serving stale keys", async () => {
    vi.useFakeTimers();
    try {
      invalidateFamilyKeyCache();
      const { scopedDb, store } = createMockDb();
      const repository = createMockRepository(store);
      await generateFamilyKey(scopedDb, repository, {
        family: INTEGRATIONS_FAMILY,
        actorUserId: "u1",
        requestId: "r1",
        env: MASTER_ENV
      });
      const env = { ...MASTER_ENV, NODE_ENV: "production" };
      expect(await loadFamilyKeyring(scopedDb, INTEGRATIONS_FAMILY, env)).not.toBeNull();
      // The row disappears while cached: before expiry the cache hides that.
      store.delete("keys.integrations");
      expect(await loadFamilyKeyring(scopedDb, INTEGRATIONS_FAMILY, env)).not.toBeNull();
      vi.advanceTimersByTime(FAMILY_KEY_CACHE_TTL_MS + 1);
      expect(await loadFamilyKeyring(scopedDb, INTEGRATIONS_FAMILY, env)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
