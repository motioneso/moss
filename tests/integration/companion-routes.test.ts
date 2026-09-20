import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase } from "@moss/db";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import { sha256Base64url } from "@moss/auth";

import { createApiServer } from "../../apps/api/src/server.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

/**
 * The Trail Marker companion routes over the real API server (#2560).
 *
 * Two boundaries matter more than the happy path and are asserted directly. A browser
 * cookie cannot reach a companion route, and a companion credential cannot reach
 * anything outside `/api/companion/*`.
 */

const VERIFIER = "v".repeat(43);
const TRUSTED_ORIGIN = "http://localhost:3000";

let server: ReturnType<typeof createApiServer>;
let boss: PgBoss;

function asOwner(extra: Record<string, string> = {}) {
  return { authorization: `Bearer ${ids.sessionA}`, ...extra };
}

/** Starts a pairing attempt the way the Mac app would, with no credential of any kind. */
async function startAttempt(deviceName = "Studio Mac") {
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
  const code = new URL(body.approvalPath, "http://x").searchParams.get("code");
  if (!code) throw new Error("approval path carried no code");
  return { attemptId: body.attemptId, code };
}

/** Runs pair, approve and redeem end to end and returns the credential the Mac would hold. */
async function linkMac(deviceName = "Studio Mac"): Promise<string> {
  const { attemptId, code } = await startAttempt(deviceName);

  const decided = await server.inject({
    method: "POST",
    url: "/api/companion/pair/decide",
    headers: asOwner({ origin: TRUSTED_ORIGIN }),
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

beforeAll(async () => {
  await resetFoundationDatabase();
  // #1124: the default pg-boss connect timeout is too short for a loaded CI runner.
  boss = createPgBossClient(connectionStrings.app, { connectionTimeoutMillis: 25_000 });
  server = createApiServer({
    appDb: createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 }),
    boss,
    logger: false
  });
  await server.ready();
});

afterAll(async () => {
  await server?.close();
  await boss?.stop({ graceful: false });
});

describe("companion route surface", () => {
  it("lets every companion route past the module-enablement guard", async () => {
    // The guard turns away a route it does not recognise with its own "Not found" body.
    // Each route here answers for itself instead, which is what being on the platform
    // allowlist buys: linking a Mac never depends on a module being switched on.
    const routes = [
      { method: "POST" as const, url: "/api/companion/protocol" },
      { method: "POST" as const, url: "/api/companion/pair" },
      { method: "GET" as const, url: "/api/companion/pair/attempt?code=nope-nope-nope-nope" },
      { method: "POST" as const, url: "/api/companion/pair/decide" },
      { method: "POST" as const, url: "/api/companion/pair/redeem" },
      { method: "POST" as const, url: "/api/companion/pair/cancel" },
      { method: "POST" as const, url: "/api/companion/heartbeat" },
      { method: "PATCH" as const, url: "/api/companion/device" },
      { method: "POST" as const, url: "/api/companion/logout" }
    ];

    for (const route of routes) {
      const res = await server.inject({ ...route, payload: {} });
      expect(res.body, `${route.url} was turned away by the route guard`).not.toContain(
        "Not found"
      );
    }
  });

  it("answers the protocol probe without any credential", async () => {
    const res = await server.inject({ method: "POST", url: "/api/companion/protocol" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ product: "moss", companionProtocol: 1 });
  });
});

describe("linking a Mac", () => {
  it("runs pair, approve, redeem, heartbeat, rename and sign out", async () => {
    const credential = await linkMac("Desk Mac");
    const bearer = { authorization: `Bearer ${credential}` };

    const beat = await server.inject({
      method: "POST",
      url: "/api/companion/heartbeat",
      headers: bearer,
      payload: { appVersion: "1.0.1", osVersion: "14.5" }
    });
    expect(beat.statusCode).toBe(200);
    const beatBody = beat.json() as { device: { displayName: string }; account: { email: string } };
    expect(beatBody.device.displayName).toBe("Desk Mac");
    expect(beatBody.account.email).toBeTruthy();

    const renamed = await server.inject({
      method: "PATCH",
      url: "/api/companion/device",
      headers: bearer,
      payload: { displayName: "  Ben's Mac  " }
    });
    expect(renamed.statusCode).toBe(200);
    expect((renamed.json() as { device: { displayName: string } }).device.displayName).toBe(
      "Ben's Mac"
    );

    const out = await server.inject({
      method: "POST",
      url: "/api/companion/logout",
      headers: bearer
    });
    expect(out.statusCode).toBe(204);

    const afterOut = await server.inject({
      method: "POST",
      url: "/api/companion/heartbeat",
      headers: bearer,
      payload: { appVersion: "1.0.1", osVersion: "14.5" }
    });
    expect(afterOut.statusCode).toBe(401);
  });

  it("tells a polling app to keep waiting while nobody has decided", async () => {
    const { attemptId } = await startAttempt("Waiting Mac");
    const res = await server.inject({
      method: "POST",
      url: "/api/companion/pair/redeem",
      payload: { attemptId, verifier: VERIFIER }
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: "pending" });
  });

  it("shows the browser what it is being asked to approve", async () => {
    const { code } = await startAttempt("Named Mac");
    const res = await server.inject({
      method: "GET",
      url: `/api/companion/pair/attempt?code=${encodeURIComponent(code)}`,
      headers: asOwner({ origin: TRUSTED_ORIGIN })
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deviceName: "Named Mac", status: "pending" });
  });

  it("lets the app abandon its own attempt", async () => {
    const { attemptId, code } = await startAttempt("Abandoned Mac");
    const cancelled = await server.inject({
      method: "POST",
      url: "/api/companion/pair/cancel",
      payload: { attemptId, verifier: VERIFIER }
    });
    expect(cancelled.statusCode).toBe(204);

    // A browser approving after the cancel has nothing left to approve.
    const late = await server.inject({
      method: "POST",
      url: "/api/companion/pair/decide",
      headers: asOwner({ origin: TRUSTED_ORIGIN }),
      payload: { code, decision: "approve" }
    });
    expect(late.statusCode).toBe(404);
  });
});

describe("approving is a same-origin, signed-in action", () => {
  it("refuses a decide with no Origin header", async () => {
    const { code } = await startAttempt("No Origin Mac");
    const res = await server.inject({
      method: "POST",
      url: "/api/companion/pair/decide",
      headers: asOwner(),
      payload: { code, decision: "approve" }
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { code?: string }).code).toBe("invalid_origin");
  });

  it("refuses a decide from a foreign origin", async () => {
    const { code } = await startAttempt("Foreign Origin Mac");
    const res = await server.inject({
      method: "POST",
      url: "/api/companion/pair/decide",
      headers: asOwner({ origin: "https://evil.example" }),
      payload: { code, decision: "approve" }
    });
    expect(res.statusCode).toBe(403);
  });

  it("refuses a decide from a caller who is not signed in", async () => {
    const { code } = await startAttempt("Anonymous Mac");
    const res = await server.inject({
      method: "POST",
      url: "/api/companion/pair/decide",
      headers: { origin: TRUSTED_ORIGIN },
      payload: { code, decision: "approve" }
    });
    expect(res.statusCode).toBe(401);
  });

  it("refuses the same attempt being decided twice", async () => {
    const { code } = await startAttempt("Twice Mac");
    const first = await server.inject({
      method: "POST",
      url: "/api/companion/pair/decide",
      headers: asOwner({ origin: TRUSTED_ORIGIN }),
      payload: { code, decision: "approve" }
    });
    expect(first.statusCode).toBe(200);

    const second = await server.inject({
      method: "POST",
      url: "/api/companion/pair/decide",
      headers: asOwner({ origin: TRUSTED_ORIGIN }),
      payload: { code, decision: "deny" }
    });
    expect(second.statusCode).toBe(409);
  });
});

describe("the two credentials never cross", () => {
  it("refuses a browser session on a companion route", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/companion/heartbeat",
      headers: asOwner({ origin: TRUSTED_ORIGIN }),
      payload: { appVersion: "1.0.0", osVersion: "14.5" }
    });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { code?: string }).code).toBe("companion_credential_invalid");
  });

  it("refuses a companion credential everywhere outside the companion routes", async () => {
    const credential = await linkMac("Boundary Mac");
    const headers = { authorization: `Bearer ${credential}` };

    for (const url of ["/api/me", "/api/me/sessions", "/api/modules", "/api/me/modules"]) {
      const res = await server.inject({ method: "GET", url, headers });
      expect(res.statusCode, `${url} accepted a companion credential`).toBe(401);
    }
  });

  it("refuses a redeem from a caller holding the attempt id but not the verifier", async () => {
    const { attemptId, code } = await startAttempt("Stolen Id Mac");
    await server.inject({
      method: "POST",
      url: "/api/companion/pair/decide",
      headers: asOwner({ origin: TRUSTED_ORIGIN }),
      payload: { code, decision: "approve" }
    });

    const res = await server.inject({
      method: "POST",
      url: "/api/companion/pair/redeem",
      payload: { attemptId, verifier: "w".repeat(43) }
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain("tm1_");
  });
});
