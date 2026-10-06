import { readFileSync } from "node:fs";
import { Writable } from "node:stream";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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

// Needs a database: run through the verify-gate skill, scoped to this file (#3067).
//
// Trail Marker sends the judge one screenshot when the bound decision model reads pictures. This
// drives the whole chain over the real API server: the judge route, the judgment service, the
// composition root and generateChoices, with only Cloudflare faked over fetch. What matters most
// is where the picture must NOT end up: any log line (the server logs at trace here), the
// activity log, the judgment row, the error log, or a response body.

const { Client } = pg;
const VERIFIER = "v".repeat(43);
const TRUSTED_ORIGIN = "http://localhost:3000";
const SORTING = "sorting";
const CLOUDFLARE_BASE_URL = `https://api.cloudflare.com/client/v4/accounts/${"0123456789abcdef0123456789abcdef"}/ai`;
// A distinctive run inside the picture. Its absence from every sink is the no-retention proof.
const MARKER = "TUFSS0VSLWZvY3VzLWltYWdlLTMwNjc";
const IMAGE = `data:image/jpeg;base64,${MARKER}${"A".repeat(200_000)}`;
const CLOUDFLARE_TOKEN = "cf-image-routes-token";

let server: ReturnType<typeof createApiServer>;
let boss: PgBoss;
let appDb: Kysely<MossDatabase>;
let dataContext: DataContextRunner;
let bootstrap: pg.Client;
let originalFetch: typeof globalThis.fetch;
let originalSecretKey: string | undefined;
let originalConnectorKey: string | undefined;

const logLines: string[] = [];
function logStream(): Writable {
  return new Writable({
    write(chunk, _encoding, done) {
      logLines.push(String(chunk));
      done();
    }
  });
}

/** Every request the fake Cloudflare received, and how it answers. */
const cloudflareCalls: { url: string; body: Record<string, unknown> }[] = [];
let cloudflareStatus = 200;

const ALIGNMENT = ["focused", "necessary_detour", "distracted", "insufficient_evidence"];
const ACTIVITY = [
  "research_reading",
  "writing_editing",
  "coding",
  "communication",
  "planning_admin",
  "shopping",
  "entertainment",
  "other",
  "unknown"
];

function choiceAnswer(criteria: readonly string[], choice: string, probability: number) {
  const rest = (1 - probability) / (criteria.length - 1);
  return {
    type: "choice",
    choice,
    confidence: probability,
    probabilities: Object.fromEntries(
      criteria.map((criterion) => [criterion, criterion === choice ? probability : rest])
    )
  };
}

async function fakeFetch(input: unknown, init?: RequestInit): Promise<Response> {
  const url = String(input);
  if (!url.startsWith(CLOUDFLARE_BASE_URL)) {
    throw new Error("network disabled in companion-focus-image-routes.test");
  }
  cloudflareCalls.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
  if (cloudflareStatus !== 200) {
    return new Response(JSON.stringify({ success: false, errors: [{ code: 5006 }] }), {
      status: cloudflareStatus
    });
  }
  return new Response(
    JSON.stringify({
      success: true,
      result: {
        answers: {
          alignment: choiceAnswer(ALIGNMENT, "distracted", 0.89),
          activity: choiceAnswer(ACTIVITY, "shopping", 0.9)
        },
        usage: { input_tokens: 1840, output_tokens: 6 }
      }
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

/** The prompt path must never run for a picture; any call here is a silent fallback. */
const promptCalls: unknown[] = [];
const fakeGenerate = (async (_scopedDb: unknown, input: unknown) => {
  promptCalls.push(input);
  return {
    ok: true,
    object: { label: "focused", reason: "From the title alone" },
    usage: { inputTokens: 1, outputTokens: 1 }
  };
}) as unknown as typeof generateStructured;

function asAdmin(extra: Record<string, string> = {}) {
  return { authorization: `Bearer ${ids.sessionAdmin}`, ...extra };
}

async function linkMac(session: string, deviceName: string): Promise<string> {
  const started = await server.inject({
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
  expect(started.statusCode).toBe(200);
  const { attemptId, approvalPath } = started.json() as {
    attemptId: string;
    approvalPath: string;
  };
  const code = new URLSearchParams(new URL(approvalPath, "http://x").hash.replace(/^#/, "")).get(
    "code"
  );
  const decided = await server.inject({
    method: "POST",
    url: "/api/companion/pair/decide",
    headers: { authorization: `Bearer ${session}`, origin: TRUSTED_ORIGIN },
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

async function seedBlock(userId: string): Promise<string> {
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
        externalId: "focus-image-block",
        title: "Finish the Q4 budget spreadsheet",
        startsAt: new Date(Date.now() - 3_600_000),
        endsAt: new Date(Date.now() + 3_600_000),
        externalMetadata: { jarvisCreated: true, source: "createEvent" }
      })
  );
  return row.id;
}

async function bindSorting(modelId: string): Promise<void> {
  const bound = await server.inject({
    method: "PUT",
    url: `/api/ai/services/${SORTING}/binding`,
    headers: asAdmin(),
    payload: { binding: { kind: "model", modelId } }
  });
  expect(bound.statusCode).toBe(200);
}

async function modelIdFor(providerId: string, providerModelId: string): Promise<string> {
  const result = await bootstrap.query<{ id: string }>(
    "SELECT id FROM app.ai_configured_models WHERE provider_config_id = $1 AND provider_model_id = $2",
    [providerId, providerModelId]
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error(`no ${providerModelId} row`);
  return id;
}

function judge(credential: string, extra: Record<string, unknown>) {
  return server.inject({
    method: "POST",
    url: "/api/companion/focus/judge",
    headers: { authorization: `Bearer ${credential}` },
    payload: {
      blockId,
      appName: "Safari",
      windowTitle: "",
      observedAt: new Date().toISOString(),
      ...extra
    }
  });
}

function context(credential: string) {
  return server.inject({
    method: "POST",
    url: "/api/companion/focus/context",
    headers: { authorization: `Bearer ${credential}` },
    payload: {}
  });
}

/** The activity writer is fire-and-forget; wait for the line a judgment with a picture records. */
async function waitForImageActivity(): Promise<Record<string, unknown>[]> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const rows = await bootstrap.query<Record<string, unknown>>(
      "SELECT * FROM app.moss_model_activity_log WHERE fact_counts ? 'images'"
    );
    if (rows.rows.length > 0) return rows.rows;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return [];
}

let credential: string;
let blockId: string;
let clefProviderId: string;

beforeAll(async () => {
  originalSecretKey = process.env.JARVIS_AI_SECRET_KEY;
  originalConnectorKey = process.env.JARVIS_CONNECTOR_SECRET_KEY;
  process.env.JARVIS_AI_SECRET_KEY = "test-focus-image-routes-ai-secret";
  process.env.JARVIS_CONNECTOR_SECRET_KEY = "test-connector-secret-key";
  originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch as typeof globalThis.fetch;

  await resetFoundationDatabase();
  appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
  dataContext = new DataContextRunner(appDb);
  bootstrap = new Client({ connectionString: connectionStrings.bootstrap });
  await bootstrap.connect();

  boss = createPgBossClient(connectionStrings.app, { connectionTimeoutMillis: 25_000 });
  server = createApiServer({
    appDb,
    boss,
    // trace: the most the server will ever write, so a picture in any log line is caught.
    logger: { level: "trace", stream: logStream() },
    focusGenerate: fakeGenerate
  });
  await server.ready();

  credential = await linkMac(ids.sessionA, "Person A Mac");
  blockId = await seedBlock(ids.userA);

  const created = await server.inject({
    method: "POST",
    url: "/api/ai/providers",
    headers: asAdmin({ "content-type": "application/json" }),
    payload: {
      providerKind: "system-one",
      displayName: "Cloudflare",
      baseUrl: CLOUDFLARE_BASE_URL,
      authMethod: "api_key",
      credentialPayload: { apiKey: CLOUDFLARE_TOKEN }
    }
  });
  expect(created.statusCode).toBe(201);
  clefProviderId = created.json<{ provider: { id: string } }>().provider.id;
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

beforeEach(() => {
  cloudflareCalls.length = 0;
  promptCalls.length = 0;
  cloudflareStatus = 200;
});

describe("the focus context names the judge", () => {
  it("reports no judge, and no pictures, before one is bound", async () => {
    const res = await context(credential);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      block: null,
      judgmentReady: false,
      judgeTakesImages: false,
      judgeName: null
    });
  });

  it("reports Clef-flash by name, and that it takes pictures, once it is the judge", async () => {
    // Discovery gave the new Clef rows vision; a row without it never qualifies.
    const capabilities = await bootstrap.query<{ capabilities: string[] }>(
      "SELECT capabilities FROM app.ai_configured_models WHERE provider_config_id = $1",
      [clefProviderId]
    );
    expect(capabilities.rows.map((row) => row.capabilities)).toEqual([
      ["json", "vision"],
      ["json", "vision"]
    ]);
    await bindSorting(await modelIdFor(clefProviderId, "clef-flash"));

    const res = await context(credential);
    expect(res.json()).toMatchObject({
      judgmentReady: true,
      judgeTakesImages: true,
      judgeName: "clef-flash (Cloudflare)"
    });
    expect(res.body).not.toContain(CLOUDFLARE_TOKEN);
    expect(res.body).not.toContain("api.cloudflare.com");
  });
});

describe("judging a picture with a judge that reads pictures", () => {
  it("sends the picture to Clef beside the state and returns its judgment", async () => {
    const res = await judge(credential, { image: IMAGE });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ label: "distracted" });
    expect(cloudflareCalls).toHaveLength(1);
    expect(cloudflareCalls[0]!.url).toBe(`${CLOUDFLARE_BASE_URL}/run/@cf/cloudflare/clef-flash`);
    expect(cloudflareCalls[0]!.body["images"]).toEqual([IMAGE]);
    expect(cloudflareCalls[0]!.body["state"]).toMatchObject({ evidence: "screenshot" });
    expect(JSON.stringify(cloudflareCalls[0]!.body["state"])).not.toContain(MARKER);
    expect(promptCalls).toHaveLength(0);
  });

  it("keeps the picture out of every log line, the activity log, the judgment rows and error bodies", async () => {
    const bodies: string[] = [];
    // The happy path, then every refusal a Mac could hit with a picture in hand.
    bodies.push((await judge(credential, { image: IMAGE })).body);
    bodies.push((await judge(credential, { image: IMAGE, description: "A shop" })).body);
    bodies.push((await judge(credential, { image: `${IMAGE}!` })).body);
    cloudflareStatus = 500;
    bodies.push((await judge(credential, { image: IMAGE })).body);

    const activity = await waitForImageActivity();
    expect(activity.length).toBeGreaterThan(0);
    expect(activity.every((row) => (row["fact_counts"] as { images: number }).images === 1)).toBe(
      true
    );

    const judgments = await bootstrap.query("SELECT * FROM app.focus_judgments");
    const allActivity = await bootstrap.query("SELECT * FROM app.moss_model_activity_log");
    const errors = await bootstrap.query("SELECT * FROM app.jarvis_error_log");

    expect(logLines.length).toBeGreaterThan(0);
    for (const [sink, text] of [
      ["log lines", logLines.join("\n")],
      ["response bodies", bodies.join("\n")],
      ["judgment rows", JSON.stringify(judgments.rows)],
      ["activity rows", JSON.stringify(allActivity.rows)],
      ["error log rows", JSON.stringify(errors.rows)]
    ] as const) {
      expect(text, `the picture reached the ${sink}`).not.toContain(MARKER);
    }
  });

  it("refuses a picture together with a description", async () => {
    const res = await judge(credential, { image: IMAGE, description: "A shopping page" });
    expect(res.statusCode).toBe(400);
    expect(cloudflareCalls).toHaveLength(0);
  });

  it("accepts a picture at the cap and refuses a body over the route's limit", async () => {
    const prefix = "data:image/jpeg;base64,";
    const accepted = await judge(credential, {
      image: `${prefix}${"A".repeat(1_048_576 - prefix.length)}`
    });
    expect(accepted.statusCode).toBe(200);

    const tooBig = await judge(credential, { image: `${prefix}${"A".repeat(1_300_000)}` });
    expect(tooBig.statusCode).toBe(413);
  });

  it("refuses a PNG, a remote address or non-base64 text", async () => {
    for (const image of [
      "data:image/png;base64,AAAA",
      "https://example.com/shot.jpg",
      "data:image/jpeg;base64,not base64"
    ]) {
      const res = await judge(credential, { image });
      expect(res.statusCode, image).toBe(400);
    }
    expect(cloudflareCalls).toHaveLength(0);
  });
});

describe("a judge that cannot read pictures", () => {
  beforeAll(async () => {
    // Clef as #3057 left it: json only.
    const clef = await modelIdFor(clefProviderId, "clef");
    await bootstrap.query(
      "UPDATE app.ai_configured_models SET capabilities = ARRAY['json'] WHERE id = $1",
      [clef]
    );
    await bindSorting(clef);
  });

  it("is named, but not offered for pictures", async () => {
    const res = await context(credential);
    expect(res.json()).toMatchObject({
      judgmentReady: true,
      judgeTakesImages: false,
      judgeName: "clef (Cloudflare)"
    });
  });

  it("answers insufficient evidence for a picture, never judging the title alone", async () => {
    const res = await judge(credential, { image: IMAGE, windowTitle: "Amazon.com: headphones" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ label: "insufficient_evidence", reason: "" });
    expect(cloudflareCalls).toHaveLength(0);
    expect(promptCalls).toHaveLength(0);
  });

  it("still judges a title with no picture as before", async () => {
    const res = await judge(credential, { windowTitle: "Q4 budget.xlsx" });

    expect(res.statusCode).toBe(200);
    expect(cloudflareCalls).toHaveLength(1);
    expect(cloudflareCalls[0]!.body).not.toHaveProperty("images");
  });
});

describe("backfilling vision onto Clef rows made before this change (0286)", () => {
  it("adds vision to Cloudflare Clef rows only, once", async () => {
    // The Clef row is json only from the block above. A same-named model on another provider
    // must be left alone.
    const other = await server.inject({
      method: "POST",
      url: "/api/ai/providers",
      headers: asAdmin({ "content-type": "application/json" }),
      payload: {
        providerKind: "system-one",
        displayName: "Elsewhere",
        baseUrl: "https://decisions.example.com",
        authMethod: "api_key",
        credentialPayload: { apiKey: "elsewhere-token" }
      }
    });
    expect(other.statusCode).toBe(201);
    const otherProviderId = other.json<{ provider: { id: string } }>().provider.id;
    const manual = await server.inject({
      method: "POST",
      url: "/api/ai/models",
      headers: asAdmin(),
      payload: {
        providerConfigId: otherProviderId,
        providerModelId: "clef",
        displayName: "clef",
        capabilities: ["json"],
        tier: "economy"
      }
    });
    expect(manual.statusCode).toBe(201);

    const migration = readFileSync(
      new URL("../../packages/ai/sql/0286_clef_models_vision.sql", import.meta.url),
      "utf8"
    );
    await bootstrap.query("BEGIN");
    await bootstrap.query(migration);
    await bootstrap.query(migration);
    await bootstrap.query("COMMIT");

    const rows = await bootstrap.query<{ provider_config_id: string; capabilities: string[] }>(
      "SELECT provider_config_id, capabilities FROM app.ai_configured_models WHERE provider_model_id = 'clef'"
    );
    const byProvider = Object.fromEntries(
      rows.rows.map((row) => [row.provider_config_id, row.capabilities])
    );
    expect(byProvider[clefProviderId]).toEqual(["json", "vision"]);
    expect(byProvider[otherProviderId]).toEqual(["json"]);
  });
});
