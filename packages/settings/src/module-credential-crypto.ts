import {
  JsonSecretCipher,
  resolveKeyring,
  type DataContextDb,
  type EncryptedSecret,
  type Keyring
} from "@moss/db";
import { HttpError } from "@moss/module-sdk";

import { loadFamilyKeyring, MODULE_CREDENTIAL_FAMILY } from "./master-key-store.js";

/**
 * AES-256-GCM envelope stored in app.module_credentials.encrypted_secret (#918).
 * NOTE: Slice 2 has ZERO production decrypt call sites — the only consumer of
 * stored module credentials is Slice 3's worker RPC (ctx.auth.getCredential).
 * decryptJson exists on the base class and is exercised only by unit tests.
 */
export type EncryptedModuleCredentialSecret = EncryptedSecret;

/** {@link JsonSecretCipher} bound to the "module credential secret" domain label. */
export class ModuleCredentialCipher extends JsonSecretCipher {
  constructor(keyring: Keyring) {
    super(keyring, "module credential secret");
  }
}

/**
 * Build the cipher from an already-loaded family keyring (master key store,
 * #2322). The keyring arrives decrypted; this only wraps it with the domain label.
 */
export function createModuleCredentialCipherFromKeyring(keyring: Keyring): ModuleCredentialCipher {
  return new ModuleCredentialCipher(keyring);
}

/**
 * Cipher for one use: the env key with its existing semantics wins, else the
 * family key from the master store. Missing everywhere means the feature is
 * paused for setup — a 503 naming the fix, never a boot-style throw and never
 * key material. Resolved per use because the family key can rotate under a
 * running process (#2322 slice 2).
 */
export async function resolveModuleCredentialCipher(
  scopedDb: DataContextDb,
  env: NodeJS.ProcessEnv = process.env
): Promise<ModuleCredentialCipher> {
  const keyring = await loadFamilyKeyring(scopedDb, MODULE_CREDENTIAL_FAMILY, env);
  if (keyring) return createModuleCredentialCipherFromKeyring(keyring);
  throw new HttpError(
    503,
    "Module credentials are paused until an encryption key is set up. " +
      "Ask an admin to open Settings, Encryption keys, and press Generate."
  );
}

/**
 * Dedicated key family so module-credential keys rotate independently of
 * connector/AI keys. Hardened env requires a >=32-byte secret via
 * JARVIS_MODULE_CREDENTIAL_SECRET_KEY (resolveKeyring enforces this); the dev
 * default is only ever used outside hardened mode.
 */
export function createModuleCredentialSecretCipher(
  env: NodeJS.ProcessEnv = process.env
): ModuleCredentialCipher {
  return new ModuleCredentialCipher(
    resolveKeyring(
      "JARVIS_MODULE_CREDENTIAL_SECRET_KEY",
      "JARVIS_MODULE_CREDENTIAL_SECRET_KEY_ID",
      "JARVIS_MODULE_CREDENTIAL_SECRET_KEYS",
      "jarv1s-development-module-credential-secret",
      env
    )
  );
}
