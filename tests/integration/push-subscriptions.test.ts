// Web push device registration (#743, PR 2234 security review 1). Covers the findings that
// need a real database: secrets at rest (finding 2), owner scoping across users and the admin
// role (finding 3), and the per-user device cap under concurrent registration (finding 6).
// Seed users, sessions and actor contexts are shared with the notifications suite.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import pg from "pg";

import { createApiServer } from "../../apps/api/src/server.js";
import {
  AuthSessionResolver,
  DataContextRunner,
  createDatabase,
  type DataContextDb,
  type MossDatabase
} from "@moss/db";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import { PushSubscriptionLimitError, PushSubscriptionsRepository } from "@moss/notifications";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";
import { userAContext, userBContext } from "./notifications-harness.js";

const { Client } = pg;

// Shapes a browser hands back from PushManager.subscribe(): a 65-byte P-256 point and a
// 16-byte auth secret, both base64url without padding.
const P256DH =
  "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM";
const AUTH = "tBHItJI5svbpez7KI4CCXg";

function endpointFor(tag: string): string {
  return `https://push.example.test/send/${tag}-${randomUUID()}`;
}

describe("Push subscriptions (#743)", () => {
  let appDb: Kysely<MossDatabase>;
  let auth: AuthSessionResolver;
  let dataContext: DataContextRunner;
  let repository: PushSubscriptionsRepository;
  let boss: PgBoss;
  let server: ReturnType<typeof createApiServer>;

  beforeAll(async () => {
    await resetFoundationDatabase();

    appDb = createDatabase({
      connectionString: connectionStrings.app,
      maxConnections: 1
    });
    auth = new AuthSessionResolver(appDb);
    dataContext = new DataContextRunner(appDb);
    repository = new PushSubscriptionsRepository();
    boss = createPgBossClient(connectionStrings.app, { connectionTimeoutMillis: 25_000 });
    server = createApiServer({
      appDb,
      boss,
      logger: false
    });
    await server.ready();
  });

  afterAll(async () => {
    await Promise.allSettled([server?.close(), appDb?.destroy(), boss?.stop({ graceful: false })]);
  });

  async function registerAs(session: string, endpoint: string) {
    return server.inject({
      method: "POST",
      url: "/api/notifications/push/subscriptions",
      headers: { authorization: `Bearer ${session}` },
      payload: { endpoint, keys: { p256dh: P256DH, auth: AUTH } }
    });
  }

  it("finding 2: stores the endpoint and keys only inside an encrypted envelope", async () => {
    const endpoint = endpointFor("secrets");
    const response = await registerAs(ids.sessionA, endpoint);
    expect(response.statusCode).toBe(200);
    const registered = response.json<{ device: { id: string } }>().device;

    // The response DTO never carries the endpoint or keys.
    expect(response.body).not.toContain(endpoint);
    expect(response.body).not.toContain(P256DH);
    expect(response.body).not.toContain(AUTH);

    // The table has no plaintext column for any of the three values (migration 0223).
    const catalog = new Client({ connectionString: connectionStrings.migration });
    await catalog.connect();
    try {
      const columns = await catalog.query<{ column_name: string }>(
        `
          SELECT column_name
          FROM information_schema.columns
          WHERE table_schema = 'app' AND table_name = 'push_subscriptions'
        `
      );
      const names = columns.rows.map((row) => row.column_name);
      expect(names).toEqual(expect.arrayContaining(["endpoint_hash", "credentials_ciphertext"]));
      expect(names).not.toContain("endpoint");
      expect(names).not.toContain("p256dh");
      expect(names).not.toContain("auth");
    } finally {
      await catalog.end();
    }

    // The raw row, read with every column, holds a hash and a sealed envelope only.
    const raw = await dataContext.withDataContext(
      userAContext(),
      async (scopedDb: DataContextDb) => {
        const result = await sql<Record<string, unknown>>`
        SELECT * FROM app.push_subscriptions WHERE id = ${registered.id}
      `.execute(scopedDb.db);
        return result.rows[0];
      }
    );
    expect(raw).toBeDefined();
    const serialized = JSON.stringify(raw);
    expect(serialized).not.toContain(endpoint);
    expect(serialized).not.toContain(P256DH);
    expect(serialized).not.toContain(AUTH);
    expect(raw?.endpoint_hash).toBe(createHash("sha256").update(endpoint).digest("hex"));
    expect((raw?.credentials_ciphertext as { algorithm?: string }).algorithm).toBe("aes-256-gcm");

    // The settings listing stays secret-free; only the delivery path opens the envelope.
    const { devices, targets } = await dataContext.withDataContext(
      userAContext(),
      async (scopedDb) => ({
        devices: await repository.listForActor(scopedDb),
        targets: await repository.listActiveForDelivery(scopedDb)
      })
    );
    const device = devices.find((row) => row.id === registered.id);
    expect(device).toBeDefined();
    expect(JSON.stringify(device)).not.toContain(endpoint);
    expect(Object.keys(device ?? {})).not.toContain("credentials_ciphertext");
    expect(targets.find((target) => target.id === registered.id)).toEqual({
      id: registered.id,
      endpoint,
      p256dh: P256DH,
      auth: AUTH
    });

    // Re-registering the same endpoint hits the hash-based uniqueness key, not a new row.
    const again = await registerAs(ids.sessionA, endpoint);
    expect(again.statusCode).toBe(200);
    expect(again.json<{ device: { id: string } }>().device.id).toBe(registered.id);
  });
  it("finding 3: another user and the admin role can neither see nor delete a device", async () => {
    const endpoint = endpointFor("owner");
    const registered = (await registerAs(ids.sessionA, endpoint)).json<{ device: { id: string } }>()
      .device;
    const adminContext = await auth.resolveAccessContext(ids.sessionAdmin, "request:admin-push");

    const asB = await dataContext.withDataContext(userBContext(), async (scopedDb) => ({
      devices: await repository.listForActor(scopedDb),
      targets: await repository.listActiveForDelivery(scopedDb),
      deleted: await repository.delete(scopedDb, registered.id)
    }));
    const asAdmin = await dataContext.withDataContext(adminContext, async (scopedDb) => ({
      devices: await repository.listForActor(scopedDb),
      targets: await repository.listActiveForDelivery(scopedDb),
      deleted: await repository.delete(scopedDb, registered.id)
    }));

    expect(asB.devices.map((row) => row.id)).not.toContain(registered.id);
    expect(asB.targets.map((row) => row.id)).not.toContain(registered.id);
    expect(asB.deleted).toBe(false);
    expect(asAdmin.devices.map((row) => row.id)).not.toContain(registered.id);
    expect(asAdmin.targets.map((row) => row.id)).not.toContain(registered.id);
    expect(asAdmin.deleted).toBe(false);

    // Bookkeeping writes from another actor's context touch nothing either.
    await dataContext.withDataContext(userBContext(), async (scopedDb) => {
      await repository.recordDeliveryFailure(scopedDb, registered.id);
      await repository.recordDeliverySuccess(scopedDb, registered.id);
    });
    const stillOwned = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.listForActor(scopedDb)
    );
    const row = stillOwned.find((device) => device.id === registered.id);
    expect(row).toBeDefined();
    expect(row?.failure_count).toBe(0);
    expect(row?.last_used_at).toBeNull();
  });

  it("finding 3: DELETE answers 404 for a device the caller does not own, and after removal", async () => {
    const endpoint = endpointFor("delete");
    const registered = (await registerAs(ids.sessionA, endpoint)).json<{ device: { id: string } }>()
      .device;
    const url = `/api/notifications/push/subscriptions/${registered.id}`;

    const byOtherUser = await server.inject({
      method: "DELETE",
      url,
      headers: { authorization: `Bearer ${ids.sessionB}` }
    });
    const byAdmin = await server.inject({
      method: "DELETE",
      url,
      headers: { authorization: `Bearer ${ids.sessionAdmin}` }
    });
    const byOwner = await server.inject({
      method: "DELETE",
      url,
      headers: { authorization: `Bearer ${ids.sessionA}` }
    });
    const byOwnerAgain = await server.inject({
      method: "DELETE",
      url,
      headers: { authorization: `Bearer ${ids.sessionA}` }
    });

    expect(byOtherUser.statusCode).toBe(404);
    expect(byAdmin.statusCode).toBe(404);
    expect(byOwner.statusCode).toBe(200);
    expect(byOwner.json<{ success: boolean }>().success).toBe(true);
    expect(byOwnerAgain.statusCode).toBe(404);
  });
  it("finding 6: two registrations racing at nine devices admit exactly one", async () => {
    // A second pool with two connections so the two upserts really run side by side; the
    // shared pool above has one connection and would serialize them by accident.
    const racingDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
    const racingContext = new DataContextRunner(racingDb);
    try {
      // User B starts with no devices (only user A registered above).
      for (let index = 0; index < 9; index += 1) {
        await racingContext.withDataContext(userBContext(), (scopedDb) =>
          repository.upsert(scopedDb, {
            endpoint: endpointFor(`race-seed-${index}`),
            p256dh: P256DH,
            auth: AUTH,
            userAgentLabel: null
          })
        );
      }

      const outcomes = await Promise.allSettled(
        ["race-left", "race-right"].map((tag) =>
          racingContext.withDataContext(userBContext(), (scopedDb) =>
            repository.upsert(scopedDb, {
              endpoint: endpointFor(tag),
              p256dh: P256DH,
              auth: AUTH,
              userAgentLabel: null
            })
          )
        )
      );

      const rejected = outcomes.filter(
        (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected"
      );
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason).toBeInstanceOf(PushSubscriptionLimitError);

      const devices = await racingContext.withDataContext(userBContext(), (scopedDb) =>
        repository.listForActor(scopedDb)
      );
      expect(devices).toHaveLength(10);
    } finally {
      await racingDb.destroy();
    }
  });
});
