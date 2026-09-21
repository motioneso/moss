import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { ConnectorsRepository, createConnectorSecretCipher } from "@moss/connectors";
import { CalendarRepository } from "@moss/calendar";
import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import { sha256Base64url } from "@moss/auth";
import type { generateStructured } from "@moss/ai";
import type { Kysely } from "kysely";

import { createApiServer } from "../../apps/api/src/server.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

// Needs a database: run through the verify-gate skill, scoped to this file (#2570).
//
// The Trail Marker focus routes over the real API server, with a fake judgment model injected so
// no test reaches a provider. What matters most is not the happy path but the boundaries: nothing
// is processed until an admin binds a model (and then not even a default model is used), a Mac can
// only act for its own person, and window text is never kept.

const { Client } = pg;
const VERIFIER = "v".repeat(43);
const TRUSTED_ORIGIN = "http://localhost:3000";
const SERVICE = "module.trail-marker.judge";
const WINDOW_MARKER = "focus-route-marker-window-91d4e0";

let server: ReturnType<typeof createApiServer>;
let boss: PgBoss;
let appDb: Kysely<MossDatabase>;
let dataContext: DataContextRunner;
let bootstrap: pg.Client;
let originalFetch: typeof globalThis.fetch;
let originalSecretKey: string | undefined;
let originalConnectorKey: string | undefined;

/** Every call the fake model received, and the answer it will give next. */
const modelCalls: { prompt: string; service: string; requireExplicitBinding: boolean }[] = [];
let nextAnswer: { label: string; reason: string } = {
  label: "distracted",
  reason: "Sports site, unrelated to studying."
};

const fakeGenerate = (async (_scopedDb: unknown, input: Record<string, unknown>) => {
  modelCalls.push({
    prompt: String(input.prompt),
    service: String(input.service),
    requireExplicitBinding: input.requireExplicitBinding === true
  });
  return { ok: true, object: nextAnswer, usage: { inputTokens: 1, outputTokens: 1 } };
}) as unknown as typeof generateStructured;

function asUser(session: string, extra: Record<string, string> = {}) {
  return { authorization: `Bearer ${session}`, ...extra };
}

async function startAttempt(deviceName: string) {
  const res = await server.inject({
    method: "POST",
    url: "/api/companion/pair",
    payload: {
      deviceName,
      platform: "macos",
      appVersion: "1.0.0",
      osVersion: "14.5",
      verifierHash: sha256Base64url(VERIFIER)
    }
  });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { attemptId: string; approvalPath: string };
  const hash = new URL(body.approvalPath, "http://x").hash.replace(/^#/, "");
  const code = new URLSearchParams(hash).get("code");
  if (!code) throw new Error("approval path carried no code");
  return { attemptId: body.attemptId, code };
}

/** Pair, approve as the given person's session, redeem: the credential that Mac would hold. */
async function linkMac(session: string, deviceName: string): Promise<string> {
  const { attemptId, code } = await startAttempt(deviceName);
  const decided = await server.inject({
    method: "POST",
    url: "/api/companion/pair/decide",
    headers: asUser(session, { origin: TRUSTED_ORIGIN }),
    payload: { code, decision: "approve" }
  });
  expect(decided.statusCode).toBe(200);
  const redeemed = await server.inject({
    method: "POST",
    url: "/api/companion/pair/redeem",
    payload: { attemptId, verifier: VERIFIER }
  });
  expect(redeemed.statusCode).toBe(200);
  return (redeemed.json() as { credential: string }).credential;
}

function post(url: string, credential: string, payload: unknown) {
  return server.inject({
    method: "POST",
    url,
    headers: { authorization: `Bearer ${credential}` },
    payload: payload as never
  });
}

/** A Moss-created block covering now for the person, inserted the way the create path mirrors it. */
async function seedBlock(userId: string, externalId: string, title: string): Promise<string> {
  const cipher = createConnectorSecretCipher();
  const scopes = ["https://www.googleapis.com/auth/calendar"];
  const account = await dataContext.withDataContext(
    { actorUserId: userId, requestId: "seed-account" },
    (scopedDb) =>
      new ConnectorsRepository().upsertGoogleAccount(scopedDb, {
        scopes,
        encryptedSecret: cipher.encryptJson({
          kind: "google-oauth",
          clientId: "cid",
          clientSecret: "csecret",
          accessToken: "atoken",
          refreshToken: "rtoken",
          tokenExpiry: new Date(Date.now() + 3_600_000).toISOString(),
          grantedScopes: scopes
        })
      })
  );
  const row = await dataContext.withDataContext(
    { actorUserId: userId, requestId: "seed-event" },
    (scopedDb) =>
      new CalendarRepository().upsertCachedEvent(scopedDb, {
        connectorAccountId: account.id,
        externalId,
        title,
        startsAt: new Date(Date.now() - 3_600_000),
        endsAt: new Date(Date.now() + 3_600_000),
        externalMetadata: { jarvisCreated: true, source: "createEvent" }
      })
  );
  return row.id;
}

async function judgmentCount(): Promise<number> {
  const result = await bootstrap.query<{ count: string }>(
    "SELECT count(*) FROM app.focus_judgments"
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function adminSeedProviderAndModel(): Promise<string> {
  const provider = await server.inject({
    method: "POST",
    url: "/api/ai/providers",
    headers: asUser(ids.sessionAdmin),
    payload: {
      providerKind: "anthropic",
      displayName: "Focus routes provider",
      credentialPayload: { apiKey: "focus-routes-secret" }
    }
  });
  expect(provider.statusCode).toBe(201);
  const providerId = provider.json<{ provider: { id: string } }>().provider.id;
  const setDefault = await server.inject({
    method: "PUT",
    url: `/api/ai/providers/${providerId}/default`,
    headers: asUser(ids.sessionAdmin)
  });
  expect(setDefault.statusCode).toBe(200);
  const model = await server.inject({
    method: "POST",
    url: "/api/ai/models",
    headers: asUser(ids.sessionAdmin),
    payload: {
      providerConfigId: providerId,
      providerModelId: "judge-model",
      displayName: "judge-model",
      capabilities: ["json"],
      tier: "economy"
    }
  });
  expect(model.statusCode).toBe(201);
  return model.json<{ model: { id: string } }>().model.id;
}

let credentialA: string;
let credentialA2: string;
let credentialB: string;
let blockA: string;
let blockB: string;
let modelId: string;

beforeAll(async () => {
  originalSecretKey = process.env.JARVIS_AI_SECRET_KEY;
  originalConnectorKey = process.env.JARVIS_CONNECTOR_SECRET_KEY;
  process.env.JARVIS_AI_SECRET_KEY = "test-focus-routes-ai-secret";
  process.env.JARVIS_CONNECTOR_SECRET_KEY = "test-connector-secret-key";
  // Provider creation runs live model discovery; reject so the suite never touches the network.
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("network disabled in companion-focus-routes.test");
  }) as typeof globalThis.fetch;

  await resetFoundationDatabase();
  appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
  dataContext = new DataContextRunner(appDb);
  bootstrap = new Client({ connectionString: connectionStrings.bootstrap });
  await bootstrap.connect();

  boss = createPgBossClient(connectionStrings.app, { connectionTimeoutMillis: 25_000 });
  server = createApiServer({ appDb, boss, logger: false, focusGenerate: fakeGenerate });
  await server.ready();

  credentialA = await linkMac(ids.sessionA, "Person A Mac");
  credentialA2 = await linkMac(ids.sessionA, "Person A second Mac");
  credentialB = await linkMac(ids.sessionB, "Person B Mac");
  blockA = await seedBlock(ids.userA, "focus-route-block-a", "Study AI");
  blockB = await seedBlock(ids.userB, "focus-route-block-b", "Write report");
  // A default provider with a json model exists from the start: exactly where a fallback to the
  // default would wrongly serve the judgment. It is not bound to the focus key yet.
  modelId = await adminSeedProviderAndModel();
});

afterAll(async () => {
  await Promise.allSettled([
    server?.close(),
    appDb?.destroy(),
    boss?.stop({ graceful: false }),
    bootstrap?.end()
  ]);
  globalThis.fetch = originalFetch;
  if (originalSecretKey === undefined) delete process.env.JARVIS_AI_SECRET_KEY;
  else process.env.JARVIS_AI_SECRET_KEY = originalSecretKey;
  if (originalConnectorKey === undefined) delete process.env.JARVIS_CONNECTOR_SECRET_KEY;
  else process.env.JARVIS_CONNECTOR_SECRET_KEY = originalConnectorKey;
});

describe("nothing is processed until an admin binds a model", () => {
  it("answers 'not ready' with no block, and refuses to judge with zero model calls, even with a default json model present", async () => {
    const context = await post("/api/companion/focus/context", credentialA, {});
    expect(context.statusCode).toBe(200);
    expect(context.json()).toEqual({ block: null, judgmentReady: false });

    const judged = await post("/api/companion/focus/judge", credentialA, {
      blockId: blockA,
      appName: "Safari",
      windowTitle: "Football scores",
      observedAt: new Date().toISOString()
    });
    expect(judged.statusCode).toBe(409);
    expect(judged.json()).toMatchObject({ code: "focus_not_ready" });
    // Fails if any fallback reads the default or another binding.
    expect(modelCalls).toHaveLength(0);
    expect(await judgmentCount()).toBe(0);
  });
});

describe("once an admin binds the judgment model", () => {
  beforeAll(async () => {
    const bound = await server.inject({
      method: "PUT",
      url: `/api/ai/services/${SERVICE}/binding`,
      headers: asUser(ids.sessionAdmin),
      payload: { binding: { kind: "model", modelId } }
    });
    expect(bound.statusCode).toBe(200);
  });

  it("reports the person's block and readiness", async () => {
    const context = await post("/api/companion/focus/context", credentialA, {});
    expect(context.statusCode).toBe(200);
    const body = context.json() as {
      block: { id: string; title: string } | null;
      judgmentReady: boolean;
    };
    expect(body.judgmentReady).toBe(true);
    expect(body.block?.id).toBe(blockA);
    expect(body.block?.title).toBe("Study AI");
  });

  it("nudges on the second distracted observation and not on a third inside the cap", async () => {
    modelCalls.length = 0;
    nextAnswer = { label: "distracted", reason: "Sports site, unrelated to studying." };
    const observation = {
      blockId: blockA,
      appName: "Safari",
      windowTitle: "Football scores",
      observedAt: new Date().toISOString()
    };

    const first = (await post("/api/companion/focus/judge", credentialA, observation)).json();
    const second = (await post("/api/companion/focus/judge", credentialA, observation)).json();
    const third = (await post("/api/companion/focus/judge", credentialA, observation)).json();
    expect(first).toMatchObject({ label: "distracted", nudge: false });
    expect(second).toMatchObject({ label: "distracted", nudge: true });
    expect(third).toMatchObject({ label: "distracted", nudge: false });

    expect(modelCalls).toHaveLength(3);
    expect(modelCalls.every((call) => call.requireExplicitBinding)).toBe(true);
    expect(modelCalls.every((call) => call.service === SERVICE)).toBe(true);
  });

  it("counts a nudge from another Mac of the same person toward the same cap", async () => {
    const other = await post("/api/companion/focus/judge", credentialA2, {
      blockId: blockA,
      appName: "Safari",
      windowTitle: "Football scores",
      observedAt: new Date().toISOString()
    });
    expect(other.statusCode).toBe(200);
    expect(other.json()).toMatchObject({ nudge: false });
  });

  it("keeps the window title out of every stored column", async () => {
    await post("/api/companion/focus/judge", credentialA, {
      blockId: blockA,
      appName: "Safari",
      windowTitle: WINDOW_MARKER,
      observedAt: new Date().toISOString()
    });
    const rows = await bootstrap.query("SELECT * FROM app.focus_judgments");
    expect(JSON.stringify(rows.rows)).not.toContain(WINDOW_MARKER);
    expect(modelCalls.at(-1)?.prompt).toContain(WINDOW_MARKER);
  });

  it("refuses a block that is someone else's, and writes no row for either person", async () => {
    const before = await judgmentCount();
    const stolen = await post("/api/companion/focus/judge", credentialA, {
      blockId: blockB,
      appName: "Safari",
      windowTitle: "Football scores",
      observedAt: new Date().toISOString()
    });
    expect(stolen.statusCode).toBe(409);
    expect(stolen.json()).toMatchObject({ code: "focus_no_block" });
    expect(await judgmentCount()).toBe(before);
  });

  it("takes the person from the credential and ignores an owner named in the body", async () => {
    // An unknown body key is dropped, never trusted (or rejected outright): either way it must
    // not change who the judgment belongs to.
    const res = await post("/api/companion/focus/judge", credentialA, {
      blockId: blockA,
      appName: "Safari",
      windowTitle: "Football scores",
      observedAt: new Date().toISOString(),
      ownerUserId: ids.userB
    });
    expect([200, 400]).toContain(res.statusCode);
    const owners = await bootstrap.query<{ owner_user_id: string }>(
      "SELECT DISTINCT owner_user_id FROM app.focus_judgments"
    );
    expect(owners.rows.map((row) => row.owner_user_id)).toEqual([ids.userA]);
  });

  it("lets a person correct their own judgment and hides everyone else's", async () => {
    const judged = await post("/api/companion/focus/judge", credentialB, {
      blockId: blockB,
      appName: "Pages",
      windowTitle: "Report draft",
      observedAt: new Date().toISOString()
    });
    const { judgmentId } = judged.json() as { judgmentId: string };

    const own = await post("/api/companion/focus/correct", credentialB, {
      judgmentId,
      verdict: "wrong"
    });
    expect(own.statusCode).toBe(204);

    // Person A's Mac cannot see or change person B's row: it looks exactly like an absent one.
    const notTheirs = await post("/api/companion/focus/correct", credentialA, {
      judgmentId,
      verdict: "right"
    });
    expect(notTheirs.statusCode).toBe(404);
  });
});

describe("who may call these routes", () => {
  const routes = ["context", "judge", "correct"] as const;

  it("turns away a browser cookie session on every focus route (fails if the resolver falls back)", async () => {
    for (const route of routes) {
      const res = await server.inject({
        method: "POST",
        url: `/api/companion/focus/${route}`,
        headers: asUser(ids.sessionA),
        payload: {} as never
      });
      expect([400, 401], `${route} let a cookie session through`).toContain(res.statusCode);
      if (res.statusCode === 401) {
        expect(res.json()).toMatchObject({ code: "companion_credential_invalid" });
      }
    }
  });

  it("turns away a request with no credential at all", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/companion/focus/context",
      payload: {}
    });
    expect(res.statusCode).toBe(401);
  });

  it("stops answering a Mac once it has logged out", async () => {
    const before = await post("/api/companion/focus/context", credentialB, {});
    expect(before.statusCode).toBe(200);
    const out = await server.inject({
      method: "POST",
      url: "/api/companion/logout",
      headers: { authorization: `Bearer ${credentialB}` }
    });
    expect(out.statusCode).toBe(204);
    const after = await post("/api/companion/focus/context", credentialB, {});
    expect(after.statusCode).toBe(401);
  });

  it("does not let the companion credential open other parts of the product", async () => {
    for (const url of ["/api/me", "/api/me/sessions", "/api/modules"]) {
      const res = await server.inject({
        method: "GET",
        url,
        headers: { authorization: `Bearer ${credentialA}` }
      });
      expect(res.statusCode, `${url} accepted a companion credential`).toBe(401);
    }
  });
});
