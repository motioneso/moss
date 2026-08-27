import { JsonSecretCipher, resolveKeyring, type EncryptedSecret, type Keyring } from "@moss/db";
import type { NewsCredentialCipherPort } from "@moss/news";

/** {@link JsonSecretCipher} bound to the "news credential secret" domain label (#2005). */
export class NewsCredentialCipher extends JsonSecretCipher {
  constructor(keyring: Keyring) {
    super(keyring, "news credential secret");
  }
}

/**
 * Dedicated key family so News publisher keys rotate independently of module,
 * connector and AI keys. Hardened env requires a >=32-byte secret via
 * JARVIS_NEWS_CREDENTIAL_SECRET_KEY (resolveKeyring enforces this and THROWS AT BOOT
 * when it is missing outside development/test); the dev default is only ever used
 * outside hardened mode. The variable is registered in infra/env.production.example,
 * .github/workflows/ci.yml, tests/uat/provisioner.ts and scripts/smoke-compose.ts —
 * a missing key of exactly this kind crash-looped the app container in #918.
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
