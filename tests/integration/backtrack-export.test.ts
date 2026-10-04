import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import type { Kysely } from "kysely";
import { fastify, type FastifyInstance } from "fastify";
import { getBuiltInModuleManifests, getModuleDeletionTables } from "@moss/module-registry";
import { HttpError } from "@moss/module-sdk";
import pg from "pg";

import { registerSettingsRoutes } from "../../packages/settings/src/routes.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const { Client } = pg;

// Split out of data-export.test.ts to keep that file under the source-size limit.
describe("Data export (Backtrack)", () => {
  let appDb: Kysely<MossDatabase>;
  let server: FastifyInstance;

  beforeAll(async () => {
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    server = fastify();
    registerSettingsRoutes(server, {
      rootDb: appDb,
      dataContext: new DataContextRunner(appDb),
      resolveAccessContext: async (request) => {
        const auth = request.headers.authorization;
        if (!auth || !auth.startsWith("Bearer ") || auth.substring(7) !== ids.sessionA) {
          throw new HttpError(401, "Unauthorized");
        }
        return { actorUserId: ids.userA, requestId: "req:test" };
      },
      listModuleManifests: () => getBuiltInModuleManifests(),
      moduleDeletionTables: getModuleDeletionTables()
    });
    await server.ready();
  });

  afterAll(async () => {
    await server?.close();
    await appDb?.destroy();
  });

  describe("Backtrack segments export (#2638 plan §4.2)", () => {
    const segmentId = "99999999-0000-4000-8000-000000000301";
    const otherOwnerSegmentId = "99999999-0000-4000-8000-000000000302";
    const deviceId = "99999999-0000-4000-8000-000000000303";
    const bodyHashHex = "aa".repeat(32);

    beforeAll(async () => {
      const client = new Client({ connectionString: connectionStrings.bootstrap });
      await client.connect();
      try {
        await client.query(
          `INSERT INTO app.backtrack_segments
           (id, owner_user_id, device_id, started_at, ended_at, app_name, bundle_id,
            window_title, address, body, body_hash, client_started_at)
         VALUES
           ($1, $2, $3, '2026-02-05T08:00:00.000Z', '2026-02-05T08:00:05.000Z',
            'Safari', 'com.apple.Safari', 'Example — Safari', 'https://example.test',
            'export body text', decode($4, 'hex'), '2026-02-05T08:00:00.000Z'),
           ($5, $6, $3, '2026-02-05T09:00:00.000Z', '2026-02-05T09:00:05.000Z',
            'Safari', 'com.apple.Safari', 'Other owner', null,
            'other owner body', decode($4, 'hex'), '2026-02-05T09:00:00.000Z')`,
          [segmentId, ids.userA, deviceId, bodyHashHex, otherOwnerSegmentId, ids.userB]
        );
      } finally {
        await client.end();
      }
    });

    it("includes the actor's own segments, hex body_hash, no `search` column, not another owner's", async () => {
      const res = await server.inject({
        method: "GET",
        url: "/api/settings/me/data-export",
        headers: { authorization: `Bearer ${ids.sessionA}` }
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        tables: { backtrackSegments: Array<Record<string, unknown>> };
      };
      expect(Array.isArray(body.tables.backtrackSegments)).toBe(true);

      const own = body.tables.backtrackSegments.find((row) => row.id === segmentId);
      expect(own).toMatchObject({
        id: segmentId,
        ownerUserId: ids.userA,
        deviceId,
        appName: "Safari",
        bundleId: "com.apple.Safari",
        windowTitle: "Example — Safari",
        address: "https://example.test",
        body: "export body text",
        bodyHash: bodyHashHex
      });
      expect(own).not.toHaveProperty("search");
      expect(body.tables.backtrackSegments.some((row) => row.id === otherOwnerSegmentId)).toBe(
        false
      );
    });
  });
});
