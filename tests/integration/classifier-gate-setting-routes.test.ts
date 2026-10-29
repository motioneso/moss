import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import pg from "pg";

import { createApiServer } from "../../apps/api/src/server.js";
import { createDatabase, type MossDatabase } from "@moss/db";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const { Client } = pg;

const GATE_KEY = "chat.classifier_gate_mode";
const CLASSIFIER_PROVIDER_MODEL_ID = "gate-classifier-json";

// #2881: the classifier gate setting has ONE write door, its typed runtime-config route, which
// enforces the off/shadow/on enum and admin-only writes. These tests run the real API server
// against a real database. They prove the generic settings route refuses the key, that an admin
// can turn the gate on with no shadow review recorded, and that a non-admin cannot.

describe("classifier gate setting route guards", () => {
  let appDb: Kysely<MossDatabase>;
  let boss: PgBoss;
  let server: ReturnType<typeof createApiServer>;
  let previousSecretKey: string | undefined;

  beforeAll(async () => {
    previousSecretKey = process.env.JARVIS_AI_SECRET_KEY;
    process.env.JARVIS_AI_SECRET_KEY = "test-classifier-gate-setting-secret";
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
    if (previousSecretKey === undefined) delete process.env.JARVIS_AI_SECRET_KEY;
    else process.env.JARVIS_AI_SECRET_KEY = previousSecretKey;
  });

  const putGate = (value: string) =>
    server.inject({
      method: "PUT",
      url: `/api/admin/runtime-config/${GATE_KEY}`,
      headers: { authorization: `Bearer ${ids.sessionA}` },
      payload: { value }
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

  it("defaults to off, and turns on with no shadow review recorded", async () => {
    // Missing value resolves to the off default.
    const initial = await server.inject({
      method: "GET",
      url: `/api/admin/runtime-config/${GATE_KEY}`,
      headers: { authorization: `Bearer ${ids.sessionA}` }
    });
    expect(initial.json()).toEqual({ config: { value: "off", source: "default" } });

    // Off to On, with no classifier chosen and no review.
    const onFromOff = await putGate("on");
    expect(onFromOff.statusCode).toBe(200);
    expect(onFromOff.json()).toEqual({ config: { value: "on", source: "instance" } });

    // Shadow to On after a classifier is chosen, still with no review.
    expect((await putGate("shadow")).statusCode).toBe(200);
    await selectClassifier();
    const onFromShadow = await putGate("on");
    expect(onFromShadow.statusCode).toBe(200);
    expect(onFromShadow.json()).toEqual({ config: { value: "on", source: "instance" } });

    // On is not one-way.
    const off = await putGate("off");
    expect(off.statusCode).toBe(200);
    expect(off.json()).toEqual({ config: { value: "off", source: "instance" } });

    expect(
      await bootstrapCount("SELECT count(*)::int AS n FROM app.chat_classifier_shadow_reviews")
    ).toBe(0);
  });

  async function selectClassifier(): Promise<string> {
    const auth = { authorization: `Bearer ${ids.sessionA}` };
    const provider = await server.inject({
      method: "POST",
      url: "/api/ai/providers",
      headers: auth,
      payload: {
        providerKind: "anthropic",
        displayName: "Gate classifier provider",
        credentialPayload: { apiKey: "classifier-gate-setting-test-secret" }
      }
    });
    expect(provider.statusCode, provider.body).toBe(201);
    const model = await server.inject({
      method: "POST",
      url: "/api/ai/models",
      headers: auth,
      payload: {
        providerConfigId: provider.json().provider.id,
        providerModelId: CLASSIFIER_PROVIDER_MODEL_ID,
        displayName: "Gate classifier",
        capabilities: ["json"],
        tier: "economy"
      }
    });
    expect(model.statusCode, model.body).toBe(201);
    const modelId = model.json().model.id as string;
    const binding = await server.inject({
      method: "PUT",
      url: "/api/ai/services/sorting/binding",
      headers: auth,
      payload: { binding: { kind: "model", modelId } }
    });
    expect(binding.statusCode, binding.body).toBe(200);
    return modelId;
  }

  it("refuses a non-admin turning the gate on on its typed route", async () => {
    const res = await server.inject({
      method: "PUT",
      url: `/api/admin/runtime-config/${GATE_KEY}`,
      headers: { authorization: `Bearer ${ids.sessionB}` },
      payload: { value: "on" }
    });
    expect(res.statusCode).toBe(403);

    const stored = await server.inject({
      method: "GET",
      url: `/api/admin/runtime-config/${GATE_KEY}`,
      headers: { authorization: `Bearer ${ids.sessionA}` }
    });
    expect(stored.json().config.value).toBe("off");
  });
});

async function bootstrapCount(text: string): Promise<number> {
  const client = new Client({ connectionString: connectionStrings.bootstrap });
  await client.connect();
  try {
    const result = await client.query<{ n: number }>(text);
    return result.rows[0]?.n ?? -1;
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
