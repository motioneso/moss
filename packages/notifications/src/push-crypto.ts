import { sql } from "kysely";
import webpush from "web-push";

import {
  JsonSecretCipher,
  assertDataContextDb,
  resolveKeyring,
  type DataContextDb,
  type Keyring
} from "@moss/db";

/** {@link JsonSecretCipher} bound to the "push signing key" domain label. */
export class PushSigningCipher extends JsonSecretCipher {
  constructor(keyring: Keyring) {
    super(keyring, "push signing key");
  }
}

/**
 * Reuses `JARVIS_AI_SECRET_KEY` (Ben's 2026-09-01 ruling: no new feature may require a
 * hand-edited settings file) rather than introducing a push-specific key env var.
 */
export function createPushSigningCipher(env: NodeJS.ProcessEnv = process.env): PushSigningCipher {
  return new PushSigningCipher(
    resolveKeyring(
      "JARVIS_AI_SECRET_KEY",
      "JARVIS_AI_SECRET_KEY_ID",
      "JARVIS_AI_SECRET_KEYS",
      "jarv1s-development-ai-secret",
      env
    )
  );
}

export interface PushSigningKeyRecord {
  readonly id: string;
  readonly publicKey: string;
  readonly privateKey: string;
  readonly subject: string;
  readonly createdAt: Date;
}

interface PushSigningKeyRow {
  readonly id: string;
  readonly public_key: string;
  readonly private_key_ciphertext: unknown;
  readonly subject: string;
  readonly created_at: Date;
}

/**
 * Returns the instance's single VAPID key pair, generating and persisting it on first
 * call. `subject` (a `mailto:` or `https:` VAPID contact) is only used the first time the
 * key is created — later calls ignore it and return the stored subject, so the instance
 * keeps one identity even if the origin that first enabled push differs from a later one.
 * A unique constraint on the fixed row id (migration 0223) makes two racing first-enables
 * converge on one key: whichever insert wins, the loser's `ON CONFLICT DO NOTHING` is a
 * no-op and the final SELECT reads the winner's row.
 */
export async function getOrGeneratePushSigningKey(
  scopedDb: DataContextDb,
  cipher: PushSigningCipher,
  subject: string
): Promise<PushSigningKeyRecord> {
  assertDataContextDb(scopedDb);

  const existing = await sql<PushSigningKeyRow>`
    SELECT id, public_key, private_key_ciphertext, subject, created_at
    FROM app.push_signing_key
    WHERE id = 'default'
  `.execute(scopedDb.db);

  const existingRow = existing.rows[0];
  if (existingRow) {
    return toRecord(existingRow, cipher);
  }

  const keys = webpush.generateVAPIDKeys();
  const ciphertext = cipher.encryptJson({ privateKey: keys.privateKey });

  await sql`
    INSERT INTO app.push_signing_key (id, public_key, private_key_ciphertext, subject)
    VALUES ('default', ${keys.publicKey}, ${JSON.stringify(ciphertext)}::jsonb, ${subject})
    ON CONFLICT (id) DO NOTHING
  `.execute(scopedDb.db);

  const stored = await sql<PushSigningKeyRow>`
    SELECT id, public_key, private_key_ciphertext, subject, created_at
    FROM app.push_signing_key
    WHERE id = 'default'
  `.execute(scopedDb.db);

  const row = stored.rows[0];
  if (!row) throw new Error("push signing key was not created");
  return toRecord(row, cipher);
}

function toRecord(row: PushSigningKeyRow, cipher: PushSigningCipher): PushSigningKeyRecord {
  const envelope = cipher.parseEnvelope(row.private_key_ciphertext);
  const decrypted = cipher.decryptJson(envelope);
  const privateKey = decrypted.privateKey;
  if (typeof privateKey !== "string") {
    throw new Error("push signing key envelope is missing its private key");
  }

  return {
    id: row.id,
    publicKey: row.public_key,
    privateKey,
    subject: row.subject,
    createdAt: row.created_at
  };
}
