import { describe, expect, it } from "vitest";
import { dataContextBrand, type DataContextDb } from "@moss/db";
import {
  createMasterKeyStoreCipher,
  generateFamilyKey,
  invalidateFamilyKeyCache,
  loadFamilyKeyring,
  NEWS_CREDENTIAL_FAMILY,
  rotateFamilyKey
} from "@moss/settings";

import {
  createNewsCredentialCipherPortFromKeyring,
  createNewsCredentialDecryptor,
  resolveNewsCredentialCipherPort
} from "../../packages/module-registry/src/news-credential-cipher.js";

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
  return {
    async upsertInstanceSetting(_scopedDb: DataContextDb, input: { key: string; value: unknown }) {
      store.set(input.key, (input.value as { value?: unknown })?.value ?? null);
    }
  };
}

const MASTER_ENV = { JARVIS_AI_SECRET_KEY: "m".repeat(40) };
const PROD_ENV = { ...MASTER_ENV, NODE_ENV: "production" };

describe("news credential decryptor (#2322 slice 2)", () => {
  it("reads a stored key and returns null when the family key exists nowhere", async () => {
    invalidateFamilyKeyCache();
    const { scopedDb, store } = createMockDb();
    const repository = createMockRepository(store);
    const decryptApiKey = createNewsCredentialDecryptor({ ...PROD_ENV });

    // Nothing anywhere: the caller degrades instead of throwing.
    await expect(decryptApiKey(scopedDb, { version: 1 } as never)).resolves.toBeNull();

    await generateFamilyKey(scopedDb, repository, {
      family: NEWS_CREDENTIAL_FAMILY,
      actorUserId: "u1",
      requestId: "r1",
      env: MASTER_ENV
    });
    invalidateFamilyKeyCache();
    const keyring = await loadFamilyKeyring(scopedDb, NEWS_CREDENTIAL_FAMILY, PROD_ENV);
    const envelope = createNewsCredentialCipherPortFromKeyring(keyring!).encrypt({
      apiKey: "publisher-key"
    });
    await expect(decryptApiKey(scopedDb, envelope)).resolves.toEqual({
      apiKey: "publisher-key"
    });
  });

  it("a worker holding a pre-rotation key reads post-rotation data after one reload", async () => {
    invalidateFamilyKeyCache();
    const { scopedDb, store } = createMockDb();
    const repository = createMockRepository(store);
    const write = { family: NEWS_CREDENTIAL_FAMILY, actorUserId: "u1", requestId: "r1" };
    await generateFamilyKey(scopedDb, repository, { ...write, env: MASTER_ENV });
    // The worker loads early and never sees the refresh call.
    const workerKeyring = await loadFamilyKeyring(scopedDb, NEWS_CREDENTIAL_FAMILY, PROD_ENV);
    expect(workerKeyring).not.toBeNull();
    await rotateFamilyKey(scopedDb, repository, { ...write, env: MASTER_ENV });

    // Post-rotation envelope, built from the row without touching this cache.
    const masterCipher = createMasterKeyStoreCipher({ ...MASTER_ENV });
    const rotated = masterCipher.decryptJson(
      masterCipher.parseEnvelope(store.get("keys.news_credential"))
    ) as { keyId: string; secret: string };
    const fresh = createNewsCredentialCipherPortFromKeyring({
      currentKeyId: rotated.keyId,
      keys: new Map([[rotated.keyId, Buffer.from(rotated.secret, "hex")]]),
      legacyCandidates: [Buffer.from(rotated.secret, "hex")]
    });
    const envelope = fresh.encrypt({ apiKey: "post-rotation-news" });

    // The stale worker object genuinely cannot read it.
    const stale = createNewsCredentialCipherPortFromKeyring(workerKeyring!);
    expect(() => stale.decrypt(envelope)).toThrow();
    // Through the decryptor the same worker succeeds after one reload.
    const decryptApiKey = createNewsCredentialDecryptor({ ...PROD_ENV });
    await expect(decryptApiKey(scopedDb, envelope)).resolves.toEqual({
      apiKey: "post-rotation-news"
    });
  });

  it("the write resolver always returns the current key", async () => {
    invalidateFamilyKeyCache();
    const { scopedDb, store } = createMockDb();
    const repository = createMockRepository(store);
    await expect(resolveNewsCredentialCipherPort(scopedDb, PROD_ENV)).resolves.toBeNull();
    await generateFamilyKey(scopedDb, repository, {
      family: NEWS_CREDENTIAL_FAMILY,
      actorUserId: "u1",
      requestId: "r1",
      env: MASTER_ENV
    });
    invalidateFamilyKeyCache();
    const port = await resolveNewsCredentialCipherPort(scopedDb, PROD_ENV);
    expect(port).not.toBeNull();
    const envelope = port!.encrypt({ apiKey: "fresh-write" });
    const decryptApiKey = createNewsCredentialDecryptor({ ...PROD_ENV });
    await expect(decryptApiKey(scopedDb, envelope)).resolves.toEqual({ apiKey: "fresh-write" });
  });
});
