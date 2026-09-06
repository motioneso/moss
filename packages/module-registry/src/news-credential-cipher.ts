import {
  JsonSecretCipher,
  resolveKeyring,
  type DataContextDb,
  type EncryptedSecret,
  type Keyring
} from "@moss/db";
import type { NewsCredentialCipherPort } from "@moss/news";
import {
  decryptWithFamilyKeyRefresh,
  FamilyKeyMissingError,
  loadFamilyKeyring,
  NEWS_CREDENTIAL_FAMILY
} from "@moss/settings";

/** {@link JsonSecretCipher} bound to the "news credential secret" domain label (#2005). */
export class NewsCredentialCipher extends JsonSecretCipher {
  constructor(keyring: Keyring) {
    super(keyring, "news credential secret");
  }
}

/**
 * Build the port from an already-loaded family keyring (master key store,
 * #2322). The keyring arrives decrypted; this only wraps it with the domain label.
 */
export function createNewsCredentialCipherPortFromKeyring(
  keyring: Keyring
): NewsCredentialCipherPort {
  const cipher = new NewsCredentialCipher(keyring);
  return {
    encrypt: (secret) => cipher.encryptJson({ apiKey: secret.apiKey }),
    decrypt: (envelope: EncryptedSecret) => {
      const value = cipher.decryptJson(envelope);
      const apiKey = value.apiKey;
      if (typeof apiKey !== "string" || apiKey.length === 0) {
        // Deliberately says nothing about the envelope contents.
        throw new Error("News credential envelope did not contain an access key");
      }
      return { apiKey };
    }
  };
}

/**
 * Per-use credential reader for the news refresh path. Returns the key, or null
 * when the family key exists nowhere (the caller degrades to skipped/needs
 * attention, never a throw). A decrypt failure reloads once and retries, so a
 * worker holding a pre-rotation key survives rotation without a restart.
 */
export function createNewsCredentialDecryptor(env: NodeJS.ProcessEnv = process.env) {
  return async (
    scopedDb: DataContextDb,
    envelope: EncryptedSecret
  ): Promise<{ readonly apiKey: string } | null> => {
    try {
      return await decryptWithFamilyKeyRefresh(scopedDb, NEWS_CREDENTIAL_FAMILY, env, (keyring) =>
        createNewsCredentialCipherPortFromKeyring(keyring).decrypt(envelope)
      );
    } catch (error) {
      if (error instanceof FamilyKeyMissingError) return null;
      throw error;
    }
  };
}

/**
 * Cipher for a credential write: always the current family key, never a held
 * object, so post-rotation writes land under the new key. Null when the family
 * key exists nowhere — the caller pauses with setup guidance.
 */
export async function resolveNewsCredentialCipherPort(
  scopedDb: DataContextDb,
  env: NodeJS.ProcessEnv = process.env
): Promise<NewsCredentialCipherPort | null> {
  const keyring = await loadFamilyKeyring(scopedDb, NEWS_CREDENTIAL_FAMILY, env);
  if (!keyring) return null;
  return createNewsCredentialCipherPortFromKeyring(keyring);
}

/**
 * Dedicated key family so News publisher keys rotate independently of module,
 * connector and AI keys. Legacy constructor, kept for tests and seeding: nothing
 * resolves a key at boot any more. Production code loads the family lazily through
 * the master store, so JARVIS_NEWS_CREDENTIAL_SECRET_KEY is optional — Generate on
 * the Encryption keys screen is the normal path — and is only honored when set.
 * The dev default is only ever used outside hardened mode.
 */
export function createNewsCredentialSecretCipher(
  env: NodeJS.ProcessEnv = process.env
): NewsCredentialCipher {
  return new NewsCredentialCipher(
    resolveKeyring(
      "JARVIS_NEWS_CREDENTIAL_SECRET_KEY",
      "JARVIS_NEWS_CREDENTIAL_SECRET_KEY_ID",
      "JARVIS_NEWS_CREDENTIAL_SECRET_KEYS",
      "jarv1s-development-news-credential-secret",
      env
    )
  );
}

/**
 * Adapts the cipher to the port News declares. The narrow {apiKey} shape is the whole
 * plaintext contract: nothing else is ever encrypted into a News credential envelope.
 */
export function createNewsCredentialCipherPort(
  env: NodeJS.ProcessEnv = process.env
): NewsCredentialCipherPort {
  const cipher = createNewsCredentialSecretCipher(env);
  return {
    encrypt: (secret) => cipher.encryptJson({ apiKey: secret.apiKey }),
    decrypt: (envelope: EncryptedSecret) => {
      const value = cipher.decryptJson(envelope);
      const apiKey = value.apiKey;
      if (typeof apiKey !== "string" || apiKey.length === 0) {
        // Deliberately says nothing about the envelope contents.
        throw new Error("News credential envelope did not contain an access key");
      }
      return { apiKey };
    }
  };
}
