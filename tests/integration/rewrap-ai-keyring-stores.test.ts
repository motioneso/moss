// Issue 3200: retiring the old AI key must not strand the stores that reuse the AI keyring
// (family keys, Brave key, push signing key, push subscriptions). Requires an isolated gate
// database; run via the verify-gate skill.
import { createAiSecretCipher } from "@moss/ai";
import { createDatabase } from "@moss/db";
import { createPushSigningCipher, createPushSubscriptionCipher } from "@moss/notifications";
import { createMasterKeyStoreCipher, createWebSearchSecretCipher } from "@moss/settings";
import { sql } from "kysely";
import { beforeEach, describe, expect, it } from "vitest";

import {
  rewrapAiKeyringStores,
  verifyCurrentKeyOnly
} from "../../scripts/rewrap-ai-keyring-stores.js";
import { connectionStrings, ids, resetEmptyFoundationDatabase } from "./test-database.js";

const OLD_SECRET = "old-ai-secret-for-rotation-test-0123456789";
const NEW_SECRET = "new-ai-secret-for-rotation-test-0123456789";

const oldEnv: NodeJS.ProcessEnv = {
  JARVIS_AI_SECRET_KEY: OLD_SECRET,
  JARVIS_AI_SECRET_KEY_ID: "v1"
};
const currentOnlyEnv: NodeJS.ProcessEnv = {
  JARVIS_AI_SECRET_KEY: NEW_SECRET,
  JARVIS_AI_SECRET_KEY_ID: "v2"
};
const rotatedEnv: NodeJS.ProcessEnv = {
  JARVIS_AI_SECRET_KEY: NEW_SECRET,
  JARVIS_AI_SECRET_KEY_ID: "v2",
  JARVIS_AI_SECRET_KEYS: JSON.stringify({ v1: OLD_SECRET })
};

describe("AI key retirement covers every AI-keyring store", () => {
  beforeEach(resetEmptyFoundationDatabase);

  async function seedStoresSealedWithOldKey(db: ReturnType<typeof createDatabase>) {
    // Each record is sealed by the same cipher the owning feature uses at runtime.
    const masterCipher = createMasterKeyStoreCipher(oldEnv);
    const webSearchCipher = createWebSearchSecretCipher(oldEnv);
    const pushSigningCipher = createPushSigningCipher(oldEnv);
    const pushSubscriptionCipher = createPushSubscriptionCipher(oldEnv);
    const seal = (
      cipher: { encryptJson(value: Record<string, unknown>): unknown },
      value: Record<string, unknown>
    ) => JSON.stringify(cipher.encryptJson(value));

    await db
      .insertInto("app.users")
      .values({
        id: ids.userA,
        email: "owner-3200@example.com",
        name: "Owner",
        email_verified: true,
        image: null,
        is_instance_admin: true,
        is_bootstrap_owner: true,
        status: "active",
        created_at: new Date(0),
        updated_at: new Date(0)
      })
      .execute();

    for (const [key, cipher] of [
      ["keys.integrations", masterCipher],
      ["keys.module_credential", masterCipher],
      ["keys.news_credential", masterCipher],
      ["web.brave_search_api_key", webSearchCipher]
    ] as const) {
      await sql`
        INSERT INTO app.instance_settings (key, value)
        VALUES (${key}, ${JSON.stringify({ value: JSON.parse(seal(cipher, { secret: key })) })}::jsonb)
      `.execute(db);
    }
    await sql`
      INSERT INTO app.push_signing_key (id, public_key, private_key_ciphertext)
      VALUES ('default', 'pub', ${seal(pushSigningCipher, { privateKey: "priv" })}::jsonb)
    `.execute(db);
    await sql`
      INSERT INTO app.push_subscriptions (owner_user_id, endpoint_hash, credentials_ciphertext)
      VALUES (${ids.userA}, 'hash-1', ${seal(pushSubscriptionCipher, { endpoint: "https://push.example/1" })}::jsonb)
    `.execute(db);
  }

  it("flags every row still sealed with the old key, then passes after the rewrap", async () => {
    const db = createDatabase({ connectionString: connectionStrings.bootstrap });
    try {
      await seedStoresSealedWithOldKey(db);

      const before = await verifyCurrentKeyOnly(db, rotatedEnv);
      expect(before.checked).toBe(6);
      expect(before.failures).toHaveLength(6);

      const results = await rewrapAiKeyringStores(db, createAiSecretCipher(rotatedEnv));
      expect(results.flatMap((result) => result.failures)).toEqual([]);

      const after = await verifyCurrentKeyOnly(db, rotatedEnv);
      expect(after.failures).toEqual([]);
      expect(after.checked).toBe(6);

      const stored = await sql<{ private_key_ciphertext: { keyId?: string } }>`
        SELECT private_key_ciphertext FROM app.push_signing_key
      `.execute(db);
      expect(stored.rows[0]?.private_key_ciphertext.keyId).toBe("v2");
    } finally {
      await db.destroy();
    }
  });

  it("reads every record through its own feature cipher with the new key alone", async () => {
    const db = createDatabase({ connectionString: connectionStrings.bootstrap });
    try {
      await seedStoresSealedWithOldKey(db);
      await rewrapAiKeyringStores(db, createAiSecretCipher(rotatedEnv));

      const masterCipher = createMasterKeyStoreCipher(currentOnlyEnv);
      const webSearchCipher = createWebSearchSecretCipher(currentOnlyEnv);
      const settings = await sql<{ key: string; value: { value?: unknown } }>`
        SELECT key, value FROM app.instance_settings
      `.execute(db);
      const byKey = new Map(settings.rows.map((row) => [row.key, row.value.value]));

      for (const key of ["keys.integrations", "keys.module_credential", "keys.news_credential"]) {
        expect(masterCipher.decryptJson(masterCipher.parseEnvelope(byKey.get(key)))).toEqual({
          secret: key
        });
      }
      const braveKey = "web.brave_search_api_key";
      expect(
        webSearchCipher.decryptJson(webSearchCipher.parseEnvelope(byKey.get(braveKey)))
      ).toEqual({ secret: braveKey });

      const signing = await sql<{ private_key_ciphertext: unknown }>`
        SELECT private_key_ciphertext FROM app.push_signing_key
      `.execute(db);
      const signingCipher = createPushSigningCipher(currentOnlyEnv);
      expect(
        signingCipher.decryptJson(
          signingCipher.parseEnvelope(signing.rows[0]?.private_key_ciphertext)
        )
      ).toEqual({ privateKey: "priv" });

      const subscription = await sql<{ credentials_ciphertext: unknown }>`
        SELECT credentials_ciphertext FROM app.push_subscriptions
      `.execute(db);
      const subscriptionCipher = createPushSubscriptionCipher(currentOnlyEnv);
      expect(
        subscriptionCipher.decryptJson(
          subscriptionCipher.parseEnvelope(subscription.rows[0]?.credentials_ciphertext)
        )
      ).toEqual({ endpoint: "https://push.example/1" });
    } finally {
      await db.destroy();
    }
  });
});
