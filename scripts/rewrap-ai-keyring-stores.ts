/**
 * Stores sealed with the AI secret keyring that live outside the per-user connector and AI
 * tables: the master key store rows, the Brave search key, the push signing key and the push
 * subscriptions. They all reuse JARVIS_AI_SECRET_KEY(S), so retiring the old AI key without
 * rewrapping them strands every row.
 *
 * Runs on the bootstrap connection (superuser, RLS bypassed) because the instance settings and
 * push signing key tables are instance-wide and the rewrap must see every row.
 */
import {
  INTEGRATIONS_FAMILY_KEY_SETTING,
  MODULE_CREDENTIAL_FAMILY_KEY_SETTING,
  NEWS_CREDENTIAL_FAMILY_KEY_SETTING,
  WEB_SEARCH_API_KEY_SETTING
} from "@moss/settings";
import { createAiSecretCipher } from "@moss/ai";
import { createConnectorSecretCipher } from "@moss/connectors";
import type { MossDatabase } from "@moss/db";
import { sql, type Kysely } from "kysely";

type Cipher = ReturnType<typeof createAiSecretCipher>;
type Db = Kysely<MossDatabase>;

export interface SealedRow {
  readonly id: string;
  readonly envelope: unknown;
}

interface SealedStore {
  readonly name: string;
  readonly keyring: "ai" | "connector";
  readonly load: (db: Db) => Promise<SealedRow[]>;
  /** Present only for stores this module rewraps; the per-user tables are rewrapped elsewhere. */
  readonly save?: (db: Db, id: string, envelope: unknown) => Promise<void>;
}

const INSTANCE_SETTING_KEYS = [
  INTEGRATIONS_FAMILY_KEY_SETTING,
  MODULE_CREDENTIAL_FAMILY_KEY_SETTING,
  NEWS_CREDENTIAL_FAMILY_KEY_SETTING,
  WEB_SEARCH_API_KEY_SETTING
];

const instanceSettingsStore: SealedStore = {
  name: "instance_settings (family keys, Brave key)",
  keyring: "ai",
  async load(db) {
    const rows = await sql<{ key: string; value: { value?: unknown } | null }>`
      SELECT key, value FROM app.instance_settings
      WHERE key IN (${sql.join(INSTANCE_SETTING_KEYS)})
    `.execute(db);
    return rows.rows.flatMap((row) =>
      row.value?.value == null ? [] : [{ id: row.key, envelope: row.value.value }]
    );
  },
  async save(db, id, envelope) {
    await sql`
      UPDATE app.instance_settings
      SET value = ${JSON.stringify({ value: envelope })}::jsonb, updated_at = now()
      WHERE key = ${id}
    `.execute(db);
  }
};

const pushSigningKeyStore: SealedStore = {
  name: "push_signing_key",
  keyring: "ai",
  async load(db) {
    const rows = await sql<{ id: string; private_key_ciphertext: unknown }>`
      SELECT id, private_key_ciphertext FROM app.push_signing_key
    `.execute(db);
    return rows.rows.map((row) => ({ id: row.id, envelope: row.private_key_ciphertext }));
  },
  async save(db, id, envelope) {
    await sql`
      UPDATE app.push_signing_key
      SET private_key_ciphertext = ${JSON.stringify(envelope)}::jsonb
      WHERE id = ${id}
    `.execute(db);
  }
};

const pushSubscriptionsStore: SealedStore = {
  name: "push_subscriptions",
  keyring: "ai",
  async load(db) {
    const rows = await sql<{ id: string; credentials_ciphertext: unknown }>`
      SELECT id, credentials_ciphertext FROM app.push_subscriptions
    `.execute(db);
    return rows.rows.map((row) => ({ id: row.id, envelope: row.credentials_ciphertext }));
  },
  async save(db, id, envelope) {
    await sql`
      UPDATE app.push_subscriptions
      SET credentials_ciphertext = ${JSON.stringify(envelope)}::jsonb
      WHERE id = ${id}
    `.execute(db);
  }
};

const REWRAPPED_STORES: readonly SealedStore[] = [
  instanceSettingsStore,
  pushSigningKeyStore,
  pushSubscriptionsStore
];

/** Per-user tables the main script rewraps; listed here so verification covers them too. */
const VERIFY_ONLY_STORES: readonly SealedStore[] = [
  {
    name: "connector_accounts",
    keyring: "connector",
    async load(db) {
      const rows = await sql<{ id: string; encrypted_secret: unknown }>`
        SELECT id, encrypted_secret FROM app.connector_accounts
      `.execute(db);
      return rows.rows.map((row) => ({ id: row.id, envelope: row.encrypted_secret }));
    }
  },
  {
    name: "connector_oauth_pending",
    keyring: "connector",
    async load(db) {
      const rows = await sql<{ id: string; encrypted_secret: unknown }>`
        SELECT id, encrypted_secret FROM app.connector_oauth_pending
      `.execute(db);
      return rows.rows.map((row) => ({ id: row.id, envelope: row.encrypted_secret }));
    }
  },
  {
    name: "ai_provider_configs",
    keyring: "ai",
    async load(db) {
      const rows = await sql<{ id: string; encrypted_credential: unknown }>`
        SELECT id, encrypted_credential FROM app.ai_provider_configs
        WHERE encrypted_credential IS NOT NULL
      `.execute(db);
      return rows.rows.map((row) => ({ id: row.id, envelope: row.encrypted_credential }));
    }
  }
];

export interface RewrapStoreResult {
  readonly store: string;
  readonly rewrapped: number;
  readonly failures: readonly string[];
}

/** Re-encrypts every row of the AI-keyring stores under the cipher's current key. */
export async function rewrapAiKeyringStores(
  db: Db,
  aiCipher: Cipher
): Promise<RewrapStoreResult[]> {
  const results: RewrapStoreResult[] = [];

  for (const store of REWRAPPED_STORES) {
    let rewrapped = 0;
    const failures: string[] = [];

    for (const row of await store.load(db)) {
      try {
        const plaintext = aiCipher.decryptJson(aiCipher.parseEnvelope(row.envelope));
        await store.save?.(db, row.id, aiCipher.encryptJson(plaintext));
        rewrapped++;
      } catch (err) {
        failures.push(`${store.name} row ${row.id}: ${err instanceof Error ? err.message : err}`);
      }
    }

    results.push({ store: store.name, rewrapped, failures });
  }

  return results;
}

export interface VerifyResult {
  readonly checked: number;
  readonly failures: readonly string[];
}

/**
 * Proves the old keys can be retired. Builds ciphers from the current key alone (retired-key
 * lists blanked) and requires every sealed row in every store to decrypt with them.
 */
export async function verifyCurrentKeyOnly(
  db: Db,
  env: NodeJS.ProcessEnv = process.env
): Promise<VerifyResult> {
  const currentOnlyEnv: NodeJS.ProcessEnv = {
    ...env,
    JARVIS_AI_SECRET_KEYS: "",
    MOSS_AI_SECRET_KEYS: "",
    JARVIS_CONNECTOR_SECRET_KEYS: "",
    MOSS_CONNECTOR_SECRET_KEYS: ""
  };
  const ciphers = {
    ai: createAiSecretCipher(currentOnlyEnv),
    connector: createConnectorSecretCipher(currentOnlyEnv)
  };

  let checked = 0;
  const failures: string[] = [];

  for (const store of [...REWRAPPED_STORES, ...VERIFY_ONLY_STORES]) {
    const cipher = ciphers[store.keyring];

    for (const row of await store.load(db)) {
      checked++;
      try {
        cipher.decryptJson(cipher.parseEnvelope(row.envelope));
      } catch (err) {
        failures.push(`${store.name} row ${row.id}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  return { checked, failures };
}
