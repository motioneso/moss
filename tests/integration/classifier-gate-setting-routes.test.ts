import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import pg from "pg";

import { createApiServer } from "../../apps/api/src/server.js";
import { createDatabase, type MossDatabase } from "@moss/db";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const { Client } = pg;

const GATE_KEY = "chat.classifier_gate_mode";
const RELEASE_TOOL = "calendar.listVisibleEvents";

// #2881: the classifier gate setting has ONE write door — its typed runtime-config route, which
// enforces the off/shadow/on enum and the approved-tool-release check. These tests run the real
// API server against a real database to prove the generic settings route refuses the key, and that
// the typed route refuses `on` until an approved release record exists.

describe("classifier gate setting route guards", () => {
  let appDb: Kysely<MossDatabase>;
  let boss: PgBoss;
  let server: ReturnType<typeof createApiServer>;

  beforeAll(async () => {
    await resetFoundationDatabase();
    await setUserAInstanceAdmin();

    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    // #1124: same longer-but-under-hookTimeout boss override the other API integration tests use.
    boss = createPgBossClient(connectionStrings.app, { connectionTimeoutMillis: 25_000 });
    server = createApiServer({ appDb, boss, logger: false });
    await server.ready();
  });

  afterAll(async () => {
    await Promise.allSettled([server?.close(), appDb?.destroy(), boss?.stop({ graceful: false })]);
  });

  it("refuses the gate key on the generic settings route", async () => {
    const res = await server.inject({
      method: "PATCH",
      url: `/api/admin/settings/${GATE_KEY}`,
      headers: { authorization: `Bearer ${ids.sessionA}` },
      payload: { value: { value: "on" } }
    });
    expect(res.statusCode).toBe(400);
  });

  it("defaults to off, rejects on with no release, then accepts on once a release exists", async () => {
    // Missing value resolves to the off default.
    const initial = await server.inject({
      method: "GET",
      url: `/api/admin/runtime-config/${GATE_KEY}`,
      headers: { authorization: `Bearer ${ids.sessionA}` }
    });
    expect(initial.json()).toEqual({ config: { value: "off", source: "default" } });

    // off and shadow are always accepted.
    const shadow = await server.inject({
      method: "PUT",
      url: `/api/admin/runtime-config/${GATE_KEY}`,
      headers: { authorization: `Bearer ${ids.sessionA}` },
      payload: { value: "shadow" }
    });
    expect(shadow.statusCode).toBe(200);

    // on is refused while no release record exists.
    const onRefused = await server.inject({
      method: "PUT",
      url: `/api/admin/runtime-config/${GATE_KEY}`,
      headers: { authorization: `Bearer ${ids.sessionA}` },
      payload: { value: "on" }
    });
    expect(onRefused.statusCode).toBe(409);

    // An approved release record is the gate for turning it on for real.
    await insertReleaseRecord();

    const onAccepted = await server.inject({
      method: "PUT",
      url: `/api/admin/runtime-config/${GATE_KEY}`,
      headers: { authorization: `Bearer ${ids.sessionA}` },
      payload: { value: "on" }
    });
    expect(onAccepted.statusCode).toBe(200);
    expect(onAccepted.json()).toEqual({ config: { value: "on", source: "instance" } });
  });

  it("refuses a non-admin writing the gate on its typed route", async () => {
    const res = await server.inject({
      method: "PUT",
      url: `/api/admin/runtime-config/${GATE_KEY}`,
      headers: { authorization: `Bearer ${ids.sessionB}` },
      payload: { value: "shadow" }
    });
    expect(res.statusCode).toBe(403);
  });
});

async function insertReleaseRecord(): Promise<void> {
  const client = new Client({ connectionString: connectionStrings.bootstrap });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO app.chat_classifier_release_eligibility
         (module_id, tool_name, classifier_config_version, approved_by_user_id)
       VALUES ('calendar', $1, 'cfg-v1', $2)`,
      [RELEASE_TOOL, ids.userA]
    );
  } finally {
    await client.end();
  }
}

async function setUserAInstanceAdmin(): Promise<void> {
  const client = new Client({ connectionString: connectionStrings.bootstrap });
  await client.connect();
  try {
    await client.query(`UPDATE app.users SET is_instance_admin = true WHERE id = $1`, [ids.userA]);
  } finally {
    await client.end();
  }
}
