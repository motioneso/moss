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

// #2881, #2984 R2.4: the classifier gate setting has ONE write door, its typed runtime-config route,
// which enforces the off/shadow/on enum and the shadow-review check. These tests run the real API
// server against a real database to prove the generic settings route refuses the key, and that the
// typed route refuses `on` until a shadow review exists for the exact current classifier selection.

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

  it("defaults to off, and refuses on until the current classifier has a shadow review", async () => {
    // Missing value resolves to the off default.
    const initial = await server.inject({
      method: "GET",
      url: `/api/admin/runtime-config/${GATE_KEY}`,
      headers: { authorization: `Bearer ${ids.sessionA}` }
    });
    expect(initial.json()).toEqual({ config: { value: "off", source: "default" } });

    // off and shadow are always accepted.
    expect((await putGate("shadow")).statusCode).toBe(200);

    // No classifier is selected, so there is nothing a review could match.
    expect((await putGate("on")).statusCode).toBe(409);

    // A retired per-tool release row no longer unlocks on.
    await bootstrapQuery(
      `INSERT INTO app.chat_classifier_release_eligibility
         (module_id, tool_name, classifier_config_version, approved_by_user_id)
       VALUES ('calendar', 'calendar.listVisibleEvents', 'cfg-v1', $1)`,
      [ids.userA]
    );
    expect((await putGate("on")).statusCode).toBe(409);

    // Select a classifier. Still no review for it.
    const modelId = await selectClassifier();
    const unreviewed = await putGate("on");
    expect(unreviewed.statusCode).toBe(409);
    expect(unreviewed.json().error).toBe(
      "The classifier gate cannot be turned on: no shadow review is recorded for the current classifier."
    );

    // A review for a different selection does not count.
    await insertReview(modelId, "some-other-provider-model");
    expect((await putGate("on")).statusCode).toBe(409);

    // A review for the exact current selection unlocks on.
    await insertReview(modelId, CLASSIFIER_PROVIDER_MODEL_ID);
    const onAccepted = await putGate("on");
    expect(onAccepted.statusCode).toBe(200);
    expect(onAccepted.json()).toEqual({ config: { value: "on", source: "instance" } });
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

async function insertReview(modelId: string, providerModelId: string): Promise<void> {
  await bootstrapQuery(
    `INSERT INTO app.chat_classifier_shadow_reviews
       (classifier_model_id, classifier_provider_model_id, reviewed_by_user_id)
     VALUES ($1, $2, $3)`,
    [modelId, providerModelId, ids.userA]
  );
}

async function bootstrapQuery(text: string, values: unknown[]): Promise<void> {
  const client = new Client({ connectionString: connectionStrings.bootstrap });
  await client.connect();
  try {
    await client.query(text, values);
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
