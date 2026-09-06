import { describe, expect, it } from "vitest";
import { dataContextBrand, resolveKeyring, type DataContextDb } from "@moss/db";
import {
  createMasterKeyStoreCipher,
  decryptWithFamilyKeyRefresh,
  generateFamilyKey,
  invalidateFamilyKeyCache,
  loadFamilyKeyring,
  MODULE_CREDENTIAL_FAMILY,
  rotateFamilyKey
} from "@moss/settings";

import {
  createModuleCredentialCipherFromKeyring,
  createModuleCredentialSecretCipher
} from "../../packages/settings/src/module-credential-crypto.js";

describe("module credential cipher", () => {
  it("builds from a loaded keyring and reads what the env cipher wrote", () => {
    const keyring = resolveKeyring(
      "JARVIS_MODULE_CREDENTIAL_SECRET_KEY",
      "JARVIS_MODULE_CREDENTIAL_SECRET_KEY_ID",
      "JARVIS_MODULE_CREDENTIAL_SECRET_KEYS",
      "jarv1s-development-module-credential-secret",
      {}
    );
    const writer = createModuleCredentialCipherFromKeyring(keyring);
    const envelope = writer.encryptJson({ value: "from-keyring-check" });
    const reader = createModuleCredentialCipherFromKeyring(keyring);
    expect(reader.decryptJson(envelope)).toEqual({ value: "from-keyring-check" });
  });

  it("a worker holding a pre-rotation module key reads post-rotation data after one reload", async () => {
    invalidateFamilyKeyCache();
    const store = new Map<string, unknown>();
    const scopedDb = {
      [dataContextBrand]: true,
      db: {
        selectFrom: (_table: string) => ({
          select: (_cols: unknown) => ({
            where: (_col: string, _op: string, val: string) => ({
              executeTakeFirst: async () =>
                store.has(val) ? { value: { value: store.get(val) } } : undefined
            })
          })
        })
      }
    } as unknown as DataContextDb;
    const repository = {
      async upsertInstanceSetting(_db: DataContextDb, input: { key: string; value: unknown }) {
        store.set(input.key, (input.value as { value?: unknown })?.value ?? null);
      }
    };
    const masterEnv = { JARVIS_AI_SECRET_KEY: "m".repeat(40) };
    const prodEnv = { ...masterEnv, NODE_ENV: "production" };
    const write = { family: MODULE_CREDENTIAL_FAMILY, actorUserId: "u1", requestId: "r1" };
    await generateFamilyKey(scopedDb, repository, { ...write, env: masterEnv });
    const workerKeyring = await loadFamilyKeyring(scopedDb, MODULE_CREDENTIAL_FAMILY, prodEnv);
    expect(workerKeyring).not.toBeNull();
    await rotateFamilyKey(scopedDb, repository, { ...write, env: masterEnv });
    const masterCipher = createMasterKeyStoreCipher({ ...masterEnv });
    const rotated = masterCipher.decryptJson(
      masterCipher.parseEnvelope(store.get("keys.module_credential"))
    ) as { keyId: string; secret: string };
    const fresh = createModuleCredentialCipherFromKeyring({
      currentKeyId: rotated.keyId,
      keys: new Map([[rotated.keyId, Buffer.from(rotated.secret, "hex")]]),
      legacyCandidates: [Buffer.from(rotated.secret, "hex")]
    });
    const envelope = fresh.encryptJson({ value: "post-rotation-module" });
    const stale = createModuleCredentialCipherFromKeyring(workerKeyring!);
    await expect((async () => stale.decryptJson(envelope))()).rejects.toThrow();
    const value = await decryptWithFamilyKeyRefresh(
      scopedDb,
      MODULE_CREDENTIAL_FAMILY,
      prodEnv,
      (keyring) => createModuleCredentialCipherFromKeyring(keyring).decryptJson(envelope)
    );
    expect(value).toEqual({ value: "post-rotation-module" });
  });

  it("round-trips a value without the envelope containing plaintext", () => {
    const cipher = createModuleCredentialSecretCipher({});
    const envelope = cipher.encryptJson({ value: "super-secret-plaintext-123" });
    expect(envelope.version).toBe(1);
    expect(envelope.algorithm).toBe("aes-256-gcm");
    expect(JSON.stringify(envelope)).not.toContain("super-secret-plaintext-123");
    expect(cipher.decryptJson(envelope)).toEqual({ value: "super-secret-plaintext-123" });
  });
});
