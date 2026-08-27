import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import type { Kysely } from "kysely";

import { createMossAuthRuntime, type MossAuthRuntime } from "@moss/auth";
import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import type { ModuleLifecycleContext } from "@moss/module-sdk";

import { createApiServer } from "../../apps/api/src/server.js";
import { NewsCredentialRepository } from "../../packages/news/src/credential-repository.js";
import { collectNewsExportSection } from "../../packages/news/src/data-lifecycle.js";
import { createNewsCredentialCipherPort } from "../../packages/module-registry/src/news-credential-cipher.js";
import {
  connectionStrings,
  resetEmptyFoundationDatabase,
  resetFoundationDatabase,
  setInstanceSetting
} from "./test-database.js";

const { Client } = pg;

/**
 * #2005 — publisher access keys against a real database.
 *
 * This is the proof that stands in for a live click-through, because this slice adds no
 * screen: the migration runs, row security is on and forced, a second user and an
 * administrator can neither read nor change somebody else's stored key, the key is stored
 * only as an encrypted envelope, deleting the account or the source takes the row with it,
 * and the account export carries nothing about credentials.
 */

const CREDENTIAL_TABLE = "news_source_credentials";
const PLAINTEXT_KEY = "plaintext-key-marker-must-never-be-stored";

describe("news credential schema posture (#2005)", () => {
  let client: pg.Client;

  beforeAll(async () => {
    await resetFoundationDatabase();
    client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  it("row security is enabled and forced", async () => {
    const result = await client.query<{
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'app' AND c.relname = $1`,
      [CREDENTIAL_TABLE]
    );
    // Enabled but not forced would quietly exempt the table owner from every policy.
    expect(result.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it("has owner-scoped read, insert and update policies for the app only, and no delete policy", async () => {
    const result = await client.query<{
      policyname: string;
      roles: string[];
      cmd: string;
      qual: string | null;
      with_check: string | null;
    }>(
      `SELECT policyname, roles::text[] AS roles, cmd, qual, with_check
         FROM pg_policies
        WHERE schemaname = 'app' AND tablename = $1
        ORDER BY cmd`,
      [CREDENTIAL_TABLE]
    );

    // Revoking a key is an update that wipes it out, so there is deliberately no delete.
    expect(result.rows.map((row) => row.cmd).sort()).toEqual(["INSERT", "SELECT", "UPDATE"]);
    for (const policy of result.rows) {
      expect(policy.roles, policy.policyname).toEqual(["jarvis_app_runtime"]);
      const predicates = [policy.qual, policy.with_check].filter(
        (predicate): predicate is string => predicate !== null
      );
      expect(predicates.length, policy.policyname).toBeGreaterThan(0);
      for (const predicate of predicates) {
        // No administrator branch anywhere: admin power here is nil, not read-only.
        expect(predicate, policy.policyname).toContain("owner_user_id");
        expect(predicate, policy.policyname).toContain("current_actor_user_id()");
        expect(predicate, policy.policyname).not.toContain("is_admin");
      }
    }
  });

  it("the background worker has no access to the table at all", async () => {
    const result = await client.query<{ privileges: boolean[] }>(
      `SELECT ARRAY[
         has_table_privilege('jarvis_worker_runtime', $1, 'select'),
         has_table_privilege('jarvis_worker_runtime', $1, 'insert'),
         has_table_privilege('jarvis_worker_runtime', $1, 'update'),
         has_table_privilege('jarvis_worker_runtime', $1, 'delete')
       ] AS privileges`,
      [`app.${CREDENTIAL_TABLE}`]
    );
    expect(result.rows[0]?.privileges).toEqual([false, false, false, false]);
  });

  it("the app holds read, insert and update only, and never owns the table", async () => {
    const grants = await client.query<{ privilege_type: string }>(
      `SELECT privilege_type
         FROM information_schema.role_table_grants
        WHERE table_schema = 'app' AND table_name = $1 AND grantee = 'jarvis_app_runtime'
        ORDER BY privilege_type`,
      [CREDENTIAL_TABLE]
    );
    expect(grants.rows.map((row) => row.privilege_type)).toEqual(["INSERT", "SELECT", "UPDATE"]);

    const owner = await client.query<{ tableowner: string }>(
      `SELECT tableowner FROM pg_tables WHERE schemaname = 'app' AND tablename = $1`,
      [CREDENTIAL_TABLE]
    );
    expect(owner.rows[0]?.tableowner).toBe("jarvis_migration_owner");
  });
});

describe("news credential storage behaviour (#2005)", () => {
  let appDb: Kysely<MossDatabase>;
  let authRuntime: MossAuthRuntime;
  let boss: PgBoss;
  let server: ReturnType<typeof createApiServer>;
  let dataCtx: DataContextRunner;
  let bootstrap: pg.Client;
  const repo = new NewsCredentialRepository();
  const cipher = createNewsCredentialCipherPort();

  async function signUp(name: string, email: string): Promise<string> {
    const res = await server.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      headers: { "content-type": "application/json" },
      payload: { name, email, password: "password12345" }
    });
    return res.json<{ user: { id: string } }>().user.id;
  }

  /** The first sign-up is the instance administrator; row security must isolate them too. */
  async function signUpAdminAliceBob(prefix: string): Promise<[string, string, string]> {
    const admin = await signUp("Admin", `${prefix}-admin@example.com`);
    await setInstanceSetting("registration.requires_approval", { value: false });
    const alice = await signUp("Alice", `${prefix}-alice@example.com`);
    const bob = await signUp("Bob", `${prefix}-bob@example.com`);
    return [admin, alice, bob];
  }

  function asActor<T>(
    actorUserId: string,
    requestId: string,
    fn: (scopedDb: Parameters<Parameters<DataContextRunner["withDataContext"]>[1]>[0]) => Promise<T>
  ): Promise<T> {
    return dataCtx.withDataContext({ actorUserId, requestId }, fn);
  }

  /** Slice #2008 owns source creation through the interface, so seed the row directly. */
  async function seedSource(ownerUserId: string, domain: string): Promise<string> {
    const inserted = await bootstrap.query<{ id: string }>(
      `INSERT INTO app.news_custom_sources
         (owner_user_id, label, canonical_domain, homepage_url, feed_url, retrieval_method,
          validation_status, health_status, validation_fingerprint, validated_at)
       VALUES ($1, 'Example Wire', $2, 'https://' || $2, NULL, 'scrape', 'approved',
               'available', 'connection:example-wire:v1', now())
       RETURNING id`,
      [ownerUserId, domain]
    );
    const id = inserted.rows[0]?.id;
    if (!id) throw new Error("seeding the news source returned no row");
    return id;
  }

  async function storeKey(
    ownerUserId: string,
    sourceId: string,
    apiKey = PLAINTEXT_KEY
  ): Promise<void> {
    await asActor(ownerUserId, `cred-store-${sourceId}`, (scopedDb) =>
      repo.insertCredential(scopedDb, {
        sourceId,
        connectionId: "example-wire",
        envelope: cipher.encrypt({ apiKey })
      })
    );
  }

  beforeEach(async () => {
    await resetEmptyFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    authRuntime = createMossAuthRuntime({ appDb, runner: new DataContextRunner(appDb) });
    // Same explicit timeout as the other News integration tests: pg-boss's own 10 second
    // default is too short for a loaded runner establishing its first connection (#1124).
    boss = createPgBossClient(connectionStrings.app, { connectionTimeoutMillis: 25_000 });
    server = createApiServer({ appDb, authRuntime, boss, logger: false });
    await server.ready();
    dataCtx = new DataContextRunner(appDb);
    bootstrap = new Client({ connectionString: connectionStrings.bootstrap });
    await bootstrap.connect();
  });

  afterEach(async () => {
    await Promise.allSettled([
      server?.close(),
      authRuntime?.close(),
      appDb?.destroy(),
      bootstrap?.end(),
      boss?.stop({ graceful: false })
    ]);
  });

  it("the stored row holds an encrypted envelope and never the key itself", async () => {
    const [, alice] = await signUpAdminAliceBob("nc-store");
    const sourceId = await seedSource(alice, "wire.example.com");
    await storeKey(alice, sourceId);

    const stored = await bootstrap.query<Record<string, unknown>>(
      `SELECT * FROM app.news_source_credentials WHERE source_id = $1`,
      [sourceId]
    );
    expect(stored.rows).toHaveLength(1);
    const row = stored.rows[0] ?? {};
    // The whole row, every column, must not contain the submitted key anywhere.
    expect(JSON.stringify(row)).not.toContain(PLAINTEXT_KEY);
    const envelope = row.encrypted_secret as { algorithm?: string; ciphertext?: string };
    expect(envelope.algorithm).toBe("aes-256-gcm");
    expect(typeof envelope.ciphertext).toBe("string");
    expect(row.status).toBe("configured");
    expect(row.generation).toBe("1");

    // Round trip through the real encryption, to prove the envelope is genuinely the key.
    const readBack = await asActor(alice, "nc-store-read", (scopedDb) =>
      repo.readEnvelope(scopedDb, sourceId)
    );
    expect(readBack).not.toBeNull();
    expect(cipher.decrypt(readBack!).apiKey).toBe(PLAINTEXT_KEY);
  });

  it("another user and the administrator can neither see nor change the stored key", async () => {
    const [admin, alice, bob] = await signUpAdminAliceBob("nc-isolation");
    const sourceId = await seedSource(alice, "wire.example.com");
    await storeKey(alice, sourceId);

    for (const [actor, tag] of [
      [bob, "nc-bob"],
      [admin, "nc-admin"]
    ] as const) {
      const statuses = await asActor(actor, `${tag}-list`, (scopedDb) =>
        repo.readStatuses(scopedDb)
      );
      expect(statuses, tag).toEqual([]);

      const envelope = await asActor(actor, `${tag}-read`, (scopedDb) =>
        repo.readEnvelope(scopedDb, sourceId)
      );
      expect(envelope, tag).toBeNull();

      const rotated = await asActor(actor, `${tag}-rotate`, (scopedDb) =>
        repo.rotateCredential(scopedDb, sourceId, cipher.encrypt({ apiKey: "attacker-key" }))
      );
      expect(rotated, tag).toBeNull();

      const revoked = await asActor(actor, `${tag}-revoke`, (scopedDb) =>
        repo.revokeCredential(scopedDb, sourceId)
      );
      expect(revoked, tag).toBeNull();
    }

    // Alice's key survived every attempt, unchanged and still hers.
    const survivor = await asActor(alice, "nc-alice-check", (scopedDb) =>
      repo.readEnvelope(scopedDb, sourceId)
    );
    expect(cipher.decrypt(survivor!).apiKey).toBe(PLAINTEXT_KEY);
    const generation = await bootstrap.query<{ generation: string }>(
      `SELECT generation::text AS generation FROM app.news_source_credentials WHERE source_id = $1`,
      [sourceId]
    );
    expect(generation.rows[0]?.generation).toBe("1");
  });

  it("replacing a key advances the counter and stores the new key in place of the old one", async () => {
    const [, alice] = await signUpAdminAliceBob("nc-rotate");
    const sourceId = await seedSource(alice, "wire.example.com");
    await storeKey(alice, sourceId);

    const rotated = await asActor(alice, "nc-rotate-1", (scopedDb) =>
      repo.rotateCredential(scopedDb, sourceId, cipher.encrypt({ apiKey: "second-key-marker" }))
    );
    expect(rotated?.generation).toBe("2");

    const envelope = await asActor(alice, "nc-rotate-2", (scopedDb) =>
      repo.readEnvelope(scopedDb, sourceId)
    );
    expect(cipher.decrypt(envelope!).apiKey).toBe("second-key-marker");
    const raw = await bootstrap.query<{ row: string }>(
      `SELECT to_jsonb(c)::text AS row FROM app.news_source_credentials c WHERE source_id = $1`,
      [sourceId]
    );
    // The replaced key is gone from the row, not kept alongside the new one.
    expect(raw.rows[0]?.row).not.toContain(PLAINTEXT_KEY);
  });

  it("revoking wipes the key out, and revoking again reports the same thing", async () => {
    const [, alice] = await signUpAdminAliceBob("nc-revoke");
    const sourceId = await seedSource(alice, "wire.example.com");
    await storeKey(alice, sourceId);

    const first = await asActor(alice, "nc-revoke-1", (scopedDb) =>
      repo.revokeCredential(scopedDb, sourceId)
    );
    const second = await asActor(alice, "nc-revoke-2", (scopedDb) =>
      repo.revokeCredential(scopedDb, sourceId)
    );

    expect(first?.status).toBe("revoked");
    // A build that read the row and then wrote it would raise on this second call.
    expect(second).toEqual(first);

    const stored = await bootstrap.query<{ encrypted_secret: unknown; status: string }>(
      `SELECT encrypted_secret, status FROM app.news_source_credentials WHERE source_id = $1`,
      [sourceId]
    );
    expect(stored.rows[0]?.encrypted_secret).toBeNull();
    expect(stored.rows[0]?.status).toBe("revoked");

    // A revoked row is invisible to the read path, so nothing can use the source again
    // until a new key is added.
    const envelope = await asActor(alice, "nc-revoke-3", (scopedDb) =>
      repo.readEnvelope(scopedDb, sourceId)
    );
    expect(envelope).toBeNull();
  });

  it("deleting the source, or the whole account, takes the stored key with it", async () => {
    const [, alice, bob] = await signUpAdminAliceBob("nc-cascade");

    const aliceSource = await seedSource(alice, "wire.example.com");
    await storeKey(alice, aliceSource);
    const bobSource = await seedSource(bob, "other.example.com");
    await storeKey(bob, bobSource, "bob-key-marker");

    await bootstrap.query(`DELETE FROM app.news_custom_sources WHERE id = $1`, [aliceSource]);
    const afterSourceDelete = await bootstrap.query(
      `SELECT 1 FROM app.news_source_credentials WHERE source_id = $1`,
      [aliceSource]
    );
    expect(afterSourceDelete.rows).toHaveLength(0);

    await bootstrap.query(`DELETE FROM app.users WHERE id = $1`, [bob]);
    const afterUserDelete = await bootstrap.query(
      `SELECT 1 FROM app.news_source_credentials WHERE owner_user_id = $1`,
      [bob]
    );
    // Leaving ciphertext behind after an account is deleted would outlive its owner.
    expect(afterUserDelete.rows).toHaveLength(0);
  });

  it("the database refuses a row whose state and stored key disagree", async () => {
    const [, alice] = await signUpAdminAliceBob("nc-constraint");
    const sourceId = await seedSource(alice, "wire.example.com");
    await storeKey(alice, sourceId);

    // Marked revoked while still holding a key: the table itself must reject this, so no
    // future code path can leave a "revoked" row that still has a usable key in it.
    await expect(
      bootstrap.query(
        `UPDATE app.news_source_credentials
            SET status = 'revoked', revoked_at = now()
          WHERE source_id = $1`,
        [sourceId]
      )
    ).rejects.toThrow(/news_source_credentials_state_ck/);
  });

  it("the account export carries nothing at all about stored keys", async () => {
    const [, alice] = await signUpAdminAliceBob("nc-export");
    const sourceId = await seedSource(alice, "wire.example.com");
    await storeKey(alice, sourceId);

    const section = await asActor(alice, "nc-export-1", (scopedDb) =>
      collectNewsExportSection(scopedDb, {
        actorUserId: alice
      } as unknown as ModuleLifecycleContext)
    );

    const serialized = JSON.stringify(section);
    expect(serialized).not.toContain(PLAINTEXT_KEY);
    expect(serialized).not.toContain("credential");
    expect(serialized).not.toContain("encrypted");
    expect(serialized).not.toContain("aes-256-gcm");
    // The source itself is still exported; it is only the key that is left out.
    expect(section.custom_sources).toHaveLength(1);
  });
});
