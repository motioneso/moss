import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import Fastify from "fastify";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import { registerIntegrationsRoutes } from "@moss/integrations";

import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const API_KEY = "s3cr3t-fixture-token-xyz";

const SPEC_V1 = {
  openapi: "3.0.0",
  paths: {
    "/widgets": { get: { operationId: "listWidgets", summary: "List widgets", tags: ["Widgets"] } }
  }
};

const SPEC_V2 = {
  openapi: "3.0.0",
  paths: {
    "/widgets": { get: { operationId: "listWidgets", summary: "List widgets", tags: ["Widgets"] } },
    "/widgets/{id}": {
      get: {
        operationId: "getWidget",
        summary: "Get widget",
        tags: ["Widgets"],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }]
      }
    }
  }
};

interface Fixture {
  readonly url: string;
  readonly setSpec: (spec: unknown) => void;
  readonly close: () => Promise<void>;
}

function startFixtureServer(): Promise<Fixture> {
  let spec: unknown = SPEC_V1;
  const server: Server = createServer((req, res) => {
    if (req.headers["x-api-key"] !== API_KEY) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(spec));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/openapi.json`,
        setSpec: (next) => {
          spec = next;
        },
        close: () => new Promise((r) => server.close(() => r()))
      });
    });
  });
}

let appDb: Kysely<MossDatabase>;
let dataContext: DataContextRunner;

beforeAll(async () => {
  await resetFoundationDatabase();
  appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
  dataContext = new DataContextRunner(appDb);
});

afterAll(async () => {
  await appDb.destroy();
});

function buildApp(actorUserId: string) {
  const app = Fastify();
  registerIntegrationsRoutes(app, {
    resolveAccessContext: async () => ({ actorUserId, requestId: "req:integrations-route-test" }),
    dataContext
  });
  return app;
}

async function createFixtureConnection(
  app: ReturnType<typeof buildApp>,
  fixture: Fixture,
  name: string
) {
  const res = await app.inject({
    method: "POST",
    url: "/api/integrations",
    payload: {
      name,
      kind: "openapi",
      url: fixture.url,
      credential: API_KEY,
      credentialPlacement: { kind: "header", name: "x-api-key" }
    }
  });
  return res;
}

describe("integrations REST routes", () => {
  it("creates an OpenAPI integration, discovers tools, hides the credential, and enforces owner-only access", async () => {
    const fixture = await startFixtureServer();
    const app = buildApp(ids.userA);
    const otherApp = buildApp(ids.userB);
    try {
      const createRes = await createFixtureConnection(app, fixture, "Widgets API");
      expect(createRes.statusCode).toBe(201);
      const created = createRes.json();
      expect(created.hasCredential).toBe(true);
      expect(created.toolCount).toBe(1);
      expect(created.tools).toHaveLength(1);
      expect(createRes.body).not.toContain(API_KEY);

      const getAsB = await otherApp.inject({ method: "GET", url: `/api/integrations/${created.id}` });
      expect(getAsB.statusCode).toBe(404);

      const getAsA = await app.inject({ method: "GET", url: `/api/integrations/${created.id}` });
      expect(getAsA.statusCode).toBe(200);
      expect(getAsA.body).not.toContain(API_KEY);
    } finally {
      await app.close();
      await otherApp.close();
      await fixture.close();
    }
  });

  it("rejects a dead URL with a 422 and saves nothing", async () => {
    const app = buildApp(ids.userA);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/integrations",
        payload: { name: "Dead Service", kind: "openapi", url: "http://127.0.0.1:1/openapi.json" }
      });
      expect(res.statusCode).toBe(422);

      const list = await app.inject({ method: "GET", url: "/api/integrations" });
      const names = (list.json().integrations as { name: string }[]).map((i) => i.name);
      expect(names).not.toContain("Dead Service");
    } finally {
      await app.close();
    }
  });

  it("surfaces a wrong API key as a 422 without leaking either key", async () => {
    const fixture = await startFixtureServer();
    const app = buildApp(ids.userA);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/integrations",
        payload: {
          name: "Wrong Key Service",
          kind: "openapi",
          url: fixture.url,
          credential: "totally-wrong-token",
          credentialPlacement: { kind: "header", name: "x-api-key" }
        }
      });
      expect(res.statusCode).toBe(422);
      expect(res.body).not.toContain("totally-wrong-token");
      expect(res.body).not.toContain(API_KEY);
    } finally {
      await app.close();
      await fixture.close();
    }
  });

  it("round-trips curation arrays through PATCH", async () => {
    const fixture = await startFixtureServer();
    const app = buildApp(ids.userA);
    try {
      const created = (await createFixtureConnection(app, fixture, "Curation Service")).json();

      const patched = await app.inject({
        method: "PATCH",
        url: `/api/integrations/${created.id}`,
        payload: { enabledGroups: ["Widgets"], enabledTools: ["listWidgets"], mutedTools: [] }
      });
      expect(patched.statusCode).toBe(200);
      const patchedBody = patched.json();
      expect(patchedBody.enabledGroups).toEqual(["Widgets"]);
      expect(patchedBody.enabledTools).toEqual(["listWidgets"]);
      expect(patchedBody.mutedTools).toEqual([]);
    } finally {
      await app.close();
      await fixture.close();
    }
  });

  it("updates the tool list on refresh when the remote spec changes", async () => {
    const fixture = await startFixtureServer();
    const app = buildApp(ids.userA);
    try {
      const created = (await createFixtureConnection(app, fixture, "Refreshable Service")).json();
      expect(created.toolCount).toBe(1);

      fixture.setSpec(SPEC_V2);
      const refreshed = await app.inject({ method: "POST", url: `/api/integrations/${created.id}/refresh` });
      expect(refreshed.statusCode).toBe(200);
      expect(refreshed.json().toolCount).toBe(2);
    } finally {
      await app.close();
      await fixture.close();
    }
  });

  it("leaves fields omitted from a PATCH untouched", async () => {
    const fixture = await startFixtureServer();
    const app = buildApp(ids.userA);
    try {
      const created = (await createFixtureConnection(app, fixture, "Partial Update Service")).json();

      const patched = await app.inject({
        method: "PATCH",
        url: `/api/integrations/${created.id}`,
        payload: { name: "Renamed Service" }
      });
      expect(patched.statusCode).toBe(200);
      const patchedBody = patched.json();
      expect(patchedBody.name).toBe("Renamed Service");
      expect(patchedBody.url).toBe(fixture.url);
      expect(patchedBody.hasCredential).toBe(true);
      expect(patchedBody.enabled).toBe(created.enabled);
    } finally {
      await app.close();
      await fixture.close();
    }
  });

  it("clears the credential via PATCH credential: null, flipping hasCredential to false", async () => {
    const fixture = await startFixtureServer();
    const app = buildApp(ids.userA);
    try {
      const created = (await createFixtureConnection(app, fixture, "Clear Credential Service")).json();
      expect(created.hasCredential).toBe(true);

      const patched = await app.inject({
        method: "PATCH",
        url: `/api/integrations/${created.id}`,
        payload: { credential: null }
      });
      expect(patched.statusCode).toBe(200);
      expect(patched.json().hasCredential).toBe(false);
    } finally {
      await app.close();
      await fixture.close();
    }
  });

  it("deletes an integration", async () => {
    const fixture = await startFixtureServer();
    const app = buildApp(ids.userA);
    try {
      const created = (await createFixtureConnection(app, fixture, "Deletable Service")).json();

      const del = await app.inject({ method: "DELETE", url: `/api/integrations/${created.id}` });
      expect(del.statusCode).toBe(204);

      const getAfter = await app.inject({ method: "GET", url: `/api/integrations/${created.id}` });
      expect(getAfter.statusCode).toBe(404);
    } finally {
      await app.close();
      await fixture.close();
    }
  });
});
