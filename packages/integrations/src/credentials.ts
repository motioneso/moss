import {
  JsonSecretCipher,
  resolveKeyring,
  resolveMossEnv,
  type DataContextDb,
  type Keyring
} from "@moss/db";
import type { CredentialPlacement } from "@moss/shared";

import type { IntegrationsRepository } from "./repository.js";

export function createIntegrationsCipher(env: NodeJS.ProcessEnv = process.env): JsonSecretCipher {
  return new JsonSecretCipher(
    resolveKeyring(
      "JARVIS_INTEGRATIONS_SECRET_KEY",
      "JARVIS_INTEGRATIONS_SECRET_KEY_ID",
      "JARVIS_INTEGRATIONS_SECRET_KEYS",
      "jarv1s-development-integrations-secret",
      env
    ),
    "integration credential"
  );
}

/**
 * Build the cipher from an already-loaded family keyring (master key store,
 * #2312). The keyring arrives decrypted; this only wraps it with the domain label.
 */
export function createIntegrationsCipherFromKeyring(keyring: Keyring): JsonSecretCipher {
  return new JsonSecretCipher(keyring, "integration credential");
}

export interface IntegrationsCipherSources {
  /** A fixed cipher. Tests pass one. */
  readonly cipher?: JsonSecretCipher;
  readonly resolveKeyring?: (scopedDb: DataContextDb) => Promise<Keyring | null>;
}

/**
 * The cipher for this request or job: a fixed one, then the env key, then the master key store.
 * `null` means credentials are paused until an admin sets up a key.
 */
export async function resolveIntegrationsCipher(
  scopedDb: DataContextDb,
  sources: IntegrationsCipherSources,
  env: NodeJS.ProcessEnv = process.env
): Promise<JsonSecretCipher | null> {
  if (sources.cipher) return sources.cipher;
  if (resolveMossEnv(env, "JARVIS_INTEGRATIONS_SECRET_KEY") !== undefined) {
    return createIntegrationsCipher(env);
  }
  if (sources.resolveKeyring) {
    const keyring = await sources.resolveKeyring(scopedDb);
    if (keyring) return createIntegrationsCipherFromKeyring(keyring);
  }
  return null;
}

/**
 * A connection's decrypted credential for the classifier jobs' credential check, held in memory
 * only. `null` when the connection has none; `undefined` when it has one but no key is set up to
 * read it.
 */
export async function loadClassifierCheckCredential(
  scopedDb: DataContextDb,
  repository: IntegrationsRepository,
  connectionId: string,
  sources: IntegrationsCipherSources
): Promise<string | null | undefined> {
  const envelope = await repository.loadCredentialEnvelope(scopedDb, connectionId);
  if (!envelope) return null;
  const cipher = await resolveIntegrationsCipher(scopedDb, sources);
  if (!cipher) return undefined;
  const secret = cipher.decryptJson(cipher.parseEnvelope(envelope)).secret;
  return typeof secret === "string" ? secret : null;
}

export function applyCredential(
  placement: CredentialPlacement | null,
  secret: string | null,
  url: URL,
  headers: Headers
): void {
  if (!secret) return;
  const kind = placement?.kind ?? "bearer";
  if (kind === "bearer") headers.set("authorization", `Bearer ${secret}`);
  else if (kind === "header") headers.set(placement?.name ?? "X-Api-Key", secret);
  else url.searchParams.set(placement?.name ?? "apikey", secret);
}
