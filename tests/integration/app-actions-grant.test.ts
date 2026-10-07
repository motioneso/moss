import { Writable } from "node:stream";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";

import {
  ACT_AS_GRANT_HEADER,
  ACT_AS_GRANT_TTL_MS,
  createActAsGrantRegistry,
  type ActAsGrantRegistry
} from "@moss/auth";
import { createDatabase, type MossDatabase } from "@moss/db";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import { createRouteCatalogHolder } from "@moss/module-registry";
import type { RouteCatalog, ToolContext } from "@moss/module-sdk";

import { createApiServer } from "../../apps/api/src/server.js";
import {
  AppActionNotReadyError,
  createAppActionsService,
  type AppActionsService
} from "../../packages/chat/src/app-actions.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

// #3065 slice 2: chat calls the app's own routes in process with a single-use act-as grant.

const themeTokens = {
  paper: "#fbfaf6",
  surface: "#ffffff",
  surface2: "#f5f3ed",
  surface3: "#edeae1",
  ink: "#292621",
  ink2: "#5b564d",
  ink3: "#8b8678",
  ink4: "#9a958a",
  line: "rgb(38, 34, 28)",
  lineSubtle: "rgb(245, 243, 237)",
  lineStrong: "rgb(210, 205, 194)",
  accent: "#2f6a4c"
};

const emptyCatalog: RouteCatalog = { routes: [], resolve: () => null, search: () => [] };

function toolContext(actorUserId: string): ToolContext {
  return { actorUserId, requestId: `req:${actorUserId}`, chatSessionId: `${actorUserId}:chat` };
}

describe("app actions through an act-as grant", () => {
  let appDb: Kysely<MossDatabase>;
  let boss: PgBoss;
  let server: ReturnType<typeof createApiServer>;
  let grants: ActAsGrantRegistry;
  let actions: AppActionsService;
  let now = Date.now();
  const mintedValues: string[] = [];
  const logLines: string[] = [];

  const asA = toolContext(ids.userA);
  const asB = toolContext(ids.userB);

  // Mints straight from the server's registry, for the tests that replay or forge a request.
  function mintFor(actorUserId: string): string {
    return grants.mint({ actorUserId, chatSessionId: `${actorUserId}:chat`, turnId: null });
  }

  beforeAll(async () => {
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    boss = createPgBossClient(connectionStrings.app, { connectionTimeoutMillis: 25_000 });

    const registry = createActAsGrantRegistry(() => now);
    grants = {
      mint(binding) {
        const value = registry.mint(binding);
        mintedValues.push(value);
        return value;
      },
      consume: (value) => registry.consume(value),
      peekActor: (value) => registry.peekActor(value)
    };

    server = createApiServer({
      appDb,
      boss,
      actAsGrants: grants,
      logger: {
        level: "trace",
        stream: new Writable({
          write(chunk, _encoding, done) {
            logLines.push(String(chunk));
            done();
          }
        })
      }
    });
    await server.ready();

    const catalog = createRouteCatalogHolder();
    catalog.set(emptyCatalog);
    actions = createAppActionsService({ server, catalog, grants, readTurnId: () => null });
  });

  afterAll(async () => {
    await Promise.allSettled([server?.close(), appDb?.destroy(), boss?.stop({ graceful: false })]);
  });

  it("refuses a call before the route catalog is ready", async () => {
    const early = createAppActionsService({
      server,
      catalog: createRouteCatalogHolder(),
      grants,
      readTurnId: () => null
    });

    await expect(early.call({ method: "GET", path: "/api/me/themes" }, asA)).rejects.toBeInstanceOf(
      AppActionNotReadyError
    );
  });

  it("runs a guarded route whose guard and handler both resolve auth", async () => {
    const result = await actions.call(
      {
        method: "PUT",
        path: "/api/me/themes/grant-a",
        body: { name: "Grant A", tokens: themeTokens }
      },
      asA
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ theme: { id: "grant-a", name: "Grant A" } });
  });

  it("refuses a replayed grant on a second request", async () => {
    await actions.call({ method: "GET", path: "/api/me/themes" }, asA);
    const used = mintedValues.at(-1)!;

    const replay = await server.inject({
      method: "GET",
      url: "/api/me/themes",
      headers: { [ACT_AS_GRANT_HEADER]: used }
    });
    expect(replay.statusCode).toBe(401);
  });

  it("refuses an expired grant", async () => {
    const value = mintFor(ids.userA);
    now += ACT_AS_GRANT_TTL_MS;

    const res = await server.inject({
      method: "GET",
      url: "/api/me/themes",
      headers: { [ACT_AS_GRANT_HEADER]: value }
    });
    expect(res.statusCode).toBe(401);
  });

  it("refuses a made-up grant value", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/me/themes",
      headers: { [ACT_AS_GRANT_HEADER]: "bWFkZS11cC1ncmFudC12YWx1ZS1ub3QtbWludGVkLWhlcmU" }
    });
    expect(res.statusCode).toBe(401);
  });

  it("refuses a grant sent with a cookie or a bearer token", async () => {
    const withCookie = await server.inject({
      method: "GET",
      url: "/api/me/themes",
      headers: {
        [ACT_AS_GRANT_HEADER]: mintFor(ids.userA),
        cookie: "better-auth.session_token=anything"
      }
    });
    const withBearer = await server.inject({
      method: "GET",
      url: "/api/me/themes",
      headers: {
        [ACT_AS_GRANT_HEADER]: mintFor(ids.userA),
        authorization: `Bearer ${ids.sessionA}`
      }
    });

    expect(withCookie.statusCode).toBe(401);
    expect(withBearer.statusCode).toBe(401);
  });

  it("passes a POST that carries no Origin header", async () => {
    const created = await actions.call(
      { method: "POST", path: "/api/tasks", body: { title: "Origin-free task" } },
      asA
    );
    expect(created.status).toBe(201);
  });

  it("keeps row-level security: user A cannot read or change user B's task", async () => {
    const created = await actions.call(
      { method: "POST", path: "/api/tasks", body: { title: "B's private task" } },
      asB
    );
    expect(created.status).toBe(201);
    const taskId = (created.body as { task: { id: string } }).task.id;

    const read = await actions.call({ method: "GET", path: `/api/tasks/${taskId}` }, asA);
    const change = await actions.call(
      { method: "PATCH", path: `/api/tasks/${taskId}`, body: { title: "changed by A" } },
      asA
    );
    expect(read.status).toBe(404);
    expect(change.status).toBe(404);

    const own = await server.inject({
      method: "GET",
      url: `/api/tasks/${taskId}`,
      headers: { authorization: `Bearer ${ids.sessionB}` }
    });
    expect(own.json<{ task: { title: string } }>().task.title).toBe("B's private task");
  });

  // Remaining requests in the caller's bucket after one injected grant call.
  async function remainingAfter(
    actorUserId: string,
    request: { method: "GET" | "POST"; url: string; payload?: Record<string, unknown> },
    expectedStatus: number
  ): Promise<number> {
    const res = await server.inject({
      ...request,
      headers: {
        [ACT_AS_GRANT_HEADER]: mintFor(actorUserId),
        ...(request.payload === undefined ? {} : { "content-type": "application/json" })
      }
    });
    expect(res.statusCode).toBe(expectedStatus);
    return Number(res.headers["x-ratelimit-remaining"]);
  }

  it("gives each user's calls their own bucket on the global limiter", async () => {
    const themes = { method: "GET", url: "/api/me/themes" } as const;

    const a1 = await remainingAfter(ids.userA, themes, 200);
    await remainingAfter(ids.userB, themes, 200);
    const a2 = await remainingAfter(ids.userA, themes, 200);
    expect(a2).toBe(a1 - 1);
  });

  it("gives each user's calls their own bucket on a shared per-route limiter", async () => {
    const invoke = {
      method: "POST",
      url: "/api/ai/assistant-tools/no.such.tool/invoke",
      payload: {}
    } as const;

    const a1 = await remainingAfter(ids.userA, invoke, 404);
    await remainingAfter(ids.userB, invoke, 404);
    const a2 = await remainingAfter(ids.userA, invoke, 404);
    expect(a2).toBe(a1 - 1);
  });

  it("accepts a grant on a route that captured the resolver early (module preferences)", async () => {
    const res = await actions.call({ method: "GET", path: "/api/modules/tasks/preferences" }, asA);

    // 404 is "no installed external module by that id", reached only after auth succeeds.
    expect(res.status).toBe(404);
  });

  it("never writes a grant value to the server log", () => {
    expect(mintedValues.length).toBeGreaterThan(10);
    expect(logLines.length).toBeGreaterThan(0);
    const log = logLines.join("");
    for (const value of mintedValues) {
      expect(log).not.toContain(value);
    }
  });
});
