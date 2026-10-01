import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import pg from "pg";

import { AiRepository, createAiSecretCipher } from "@moss/ai";
import { DataContextRunner, createDatabase, type AccessContext, type MossDatabase } from "@moss/db";
import { connectionStrings, resetFoundationDatabase } from "./test-database.js";

const { Client } = pg;

// #2844: providers and models created by an admin stay visible to every admin after the
// creating admin is demoted. A regular user's personal provider stays hidden from admins.
describe("AI provider visibility after the owning admin is demoted", () => {
  const adminOne = "00000000-0000-4000-8000-000000002844";
  const adminTwo = "00000000-0000-4000-8000-000000028441";
  const memberOne = "00000000-0000-4000-8000-000000028442";
  const memberTwo = "00000000-0000-4000-8000-000000028443";

  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  const repository = new AiRepository();

  const ctx = (actorUserId: string): AccessContext => ({
    actorUserId,
    requestId: `request:2844:${actorUserId}`
  });

  const withBootstrap = async (run: (client: pg.Client) => Promise<void>) => {
    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      await run(client);
    } finally {
      await client.end();
    }
  };

  const setAdmin = (userId: string, isAdmin: boolean) =>
    withBootstrap(async (client) => {
      await client.query(`UPDATE app.users SET is_instance_admin = $2 WHERE id = $1`, [
        userId,
        isAdmin
      ]);
    });

  // Demotes the admin for the duration of the callback and always restores them.
  const whileDemoted = async (userId: string, run: () => Promise<void>) => {
    await setAdmin(userId, false);
    try {
      await run();
    } finally {
      await setAdmin(userId, true);
    }
  };

  const createProviderAndModel = async (actorUserId: string, name: string) =>
    dataContext.withDataContext(ctx(actorUserId), async (scopedDb) => {
      const provider = await repository.createProvider(scopedDb, {
        providerKind: "openai-compatible",
        displayName: name,
        encryptedCredential: createAiSecretCipher().encryptJson({ apiKey: `secret-${name}` })
      });
      const model = await repository.createModel(scopedDb, {
        providerConfigId: provider.id,
        providerModelId: `${name}-model`,
        displayName: `${name} model`,
        capabilities: ["chat"]
      });
      return { providerId: provider.id, modelId: model.id };
    });

  const visibleIds = (actorUserId: string) =>
    dataContext.withDataContext(ctx(actorUserId), async (scopedDb) => ({
      providers: (await scopedDb.db.selectFrom("app.ai_provider_configs").select("id").execute())
        .map((row) => row.id)
        .sort(),
      models: (await scopedDb.db.selectFrom("app.ai_configured_models").select("id").execute())
        .map((row) => row.id)
        .sort()
    }));

  beforeAll(async () => {
    process.env.JARVIS_AI_SECRET_KEY ??= "test-ai-admin-provider-visibility-secret";
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    dataContext = new DataContextRunner(appDb);

    await withBootstrap(async (client) => {
      for (const [id, admin] of [
        [adminOne, true],
        [adminTwo, true],
        [memberOne, false],
        [memberTwo, false]
      ] as const) {
        await client.query(
          `INSERT INTO app.users (id, email, name, is_instance_admin, created_at, updated_at)
           VALUES ($1, $2, 'AI visibility test', $3, now(), now())`,
          [id, `ai-visibility-${id}@example.test`, admin]
        );
      }
    });
  });

  afterAll(async () => {
    await appDb?.destroy();
  });

  it("keeps admin-created providers and models visible to other admins after demotion", async () => {
    const adminCreated = await createProviderAndModel(adminOne, `admin-${randomUUID()}`);

    await whileDemoted(adminOne, async () => {
      const adminTwoSees = await visibleIds(adminTwo);
      expect(adminTwoSees.providers).toContain(adminCreated.providerId);
      expect(adminTwoSees.models).toContain(adminCreated.modelId);
    });
  });

  it("lets another admin update a demoted admin's provider row", async () => {
    const created = await createProviderAndModel(adminOne, `admin-edit-${randomUUID()}`);

    await whileDemoted(adminOne, async () => {
      const updated = await dataContext.withDataContext(ctx(adminTwo), (scopedDb) =>
        scopedDb.db
          .updateTable("app.ai_provider_configs")
          .set({ display_name: "Renamed by admin two" })
          .where("id", "=", created.providerId)
          .returning(["id", "owner_user_id", "display_name"])
          .execute()
      );
      expect(updated).toEqual([
        { id: created.providerId, owner_user_id: adminOne, display_name: "Renamed by admin two" }
      ]);
    });
  });

  it("does not show a regular user's own provider or models to an admin", async () => {
    // Regular users cannot create providers through the app role, so seed one as the owner of
    // the migration would: through the bootstrap connection.
    const providerId = randomUUID();
    const modelId = randomUUID();
    const credential = createAiSecretCipher().encryptJson({ apiKey: "member-secret" });
    await withBootstrap(async (client) => {
      await client.query(
        `INSERT INTO app.ai_provider_configs
           (id, owner_user_id, provider_kind, display_name, encrypted_credential)
         VALUES ($1, $2, 'openai-compatible', 'Member personal', $3::jsonb)`,
        [providerId, memberTwo, JSON.stringify(credential)]
      );
      await client.query(
        `INSERT INTO app.ai_configured_models
           (id, provider_config_id, owner_user_id, provider_model_id, display_name, capabilities)
         VALUES ($1, $2, $3, 'member-model', 'Member model', ARRAY['chat'])`,
        [modelId, providerId, memberTwo]
      );
    });

    const adminSees = await visibleIds(adminTwo);
    expect(adminSees.providers).not.toContain(providerId);
    expect(adminSees.models).not.toContain(modelId);

    const otherMemberSees = await visibleIds(memberOne);
    expect(otherMemberSees.providers).not.toContain(providerId);
    expect(otherMemberSees.models).not.toContain(modelId);

    const ownerSees = await visibleIds(memberTwo);
    expect(ownerSees.providers).toContain(providerId);
    expect(ownerSees.models).toContain(modelId);
  });

  it("does not let a non-admin see another demoted admin's rows", async () => {
    const created = await createProviderAndModel(adminOne, `admin-demote-${randomUUID()}`);

    await whileDemoted(adminOne, async () => {
      const memberSees = await visibleIds(memberOne);
      expect(memberSees.providers).not.toContain(created.providerId);
      expect(memberSees.models).not.toContain(created.modelId);
    });
  });

  it("marks admin inserts as admin-created and refuses later changes to the mark", async () => {
    const created = await createProviderAndModel(adminTwo, `admin-mark-${randomUUID()}`);

    await withBootstrap(async (client) => {
      const { rows } = await client.query(
        `SELECT created_by_admin FROM app.ai_provider_configs WHERE id = $1`,
        [created.providerId]
      );
      expect(rows[0].created_by_admin).toBe(true);
      const modelRows = await client.query(
        `SELECT created_by_admin FROM app.ai_configured_models WHERE id = $1`,
        [created.modelId]
      );
      expect(modelRows.rows[0].created_by_admin).toBe(true);

      await expect(
        client.query(`UPDATE app.ai_provider_configs SET created_by_admin = false WHERE id = $1`, [
          created.providerId
        ])
      ).rejects.toThrow(/cannot be changed/);
      await expect(
        client.query(`UPDATE app.ai_configured_models SET created_by_admin = false WHERE id = $1`, [
          created.modelId
        ])
      ).rejects.toThrow(/cannot be changed/);
    });
  });
});
