import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance, type InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import type { Kysely } from "kysely";
import { getBuiltInModuleRegistrations } from "@moss/module-registry";
import { createWorkshopProject, registerWorkshopProjectRoutes } from "@moss/workshop";
import type { CreateWorkshopProjectResponse, ListWorkshopProjectsResponse } from "@moss/shared";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

let database: Kysely<MossDatabase>;
let bootstrap: Kysely<MossDatabase>;
let context: DataContextRunner;
let app: FastifyInstance;
const base = "/api/workshop/projects";
const input = () => ({
  requestKey: randomUUID(),
  title: "Saved project",
  initialRequest: "Keep my requirements",
  context: "Private context"
});
const send = (options: InjectOptions, actor: string = ids.adminUser) =>
  app.inject({ ...options, headers: { "x-test-actor": actor } });
const create = async () =>
  (
    await send({ method: "POST", url: base, payload: input() })
  ).json<CreateWorkshopProjectResponse>();

beforeAll(async () => {
  await resetFoundationDatabase();
  database = createDatabase({ connectionString: connectionStrings.app, maxConnections: 3 });
  bootstrap = createDatabase({ connectionString: connectionStrings.bootstrap });
  await bootstrap
    .updateTable("app.users")
    .set({ is_instance_admin: true })
    .where("id", "=", ids.userB)
    .execute();
  context = new DataContextRunner(database);
  app = Fastify();
  registerWorkshopProjectRoutes(app, {
    dataContext: context,
    resolveAccessContext: async (request) => ({
      actorUserId: String(request.headers["x-test-actor"])
    })
  });
  await app.ready();
});
afterAll(async () => {
  await app?.close();
  await Promise.all([database?.destroy(), bootstrap?.destroy()]);
});

describe("Workshop project HTTP entry", () => {
  it("registers in the host and creates/replays only a project with a strict public response", async () => {
    expect(
      getBuiltInModuleRegistrations().find(
        (registration) => registration.manifest.id === "workshop"
      )?.registerRoutes
    ).toBeTypeOf("function");
    const before = await bootstrap.selectFrom("app.module_builds").select("id").execute();
    const request = input();
    const response = await send({ method: "POST", url: base, payload: request });
    expect(response.statusCode).toBe(201);
    const result = response.json<CreateWorkshopProjectResponse>();
    expect(Object.keys(result).sort()).toEqual(["created", "destination", "project"]);
    expect(Object.keys(result.project).sort()).toEqual([
      "context",
      "createdAt",
      "id",
      "initialRequest",
      "title",
      "updatedAt"
    ]);
    expect(result.destination).toBe(`/workshop/${result.project.id}`);
    const replay = await send({ method: "POST", url: base, payload: request });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ ...result, created: false });
    const conflict = await send({
      method: "POST",
      url: base,
      payload: { ...request, context: "Changed" }
    });
    expect(conflict.statusCode).toBe(409);
    expect(Object.keys(conflict.json())).toEqual(["error"]);
    expect((await send({ method: "GET", url: `${base}/${result.project.id}` })).json()).toEqual({
      project: result.project
    });
    expect(await bootstrap.selectFrom("app.module_builds").select("id").execute()).toEqual(before);
  });

  it("denies non-admins on every endpoint and in the shared create operation", async () => {
    const { project } = await create();
    for (const options of [
      { method: "POST", url: base, payload: input() },
      { method: "GET", url: base },
      { method: "GET", url: `${base}/${project.id}` },
      { method: "GET", url: `${base}/${project.id}/messages` },
      {
        method: "POST",
        url: `${base}/${project.id}/messages`,
        payload: { messageId: randomUUID(), text: "No" }
      }
    ] satisfies InjectOptions[]) {
      expect((await send(options, ids.userA)).statusCode).toBe(403);
    }
    await expect(
      context.withDataContext({ actorUserId: ids.userA }, (db) =>
        createWorkshopProject(db, input())
      )
    ).rejects.toThrow("active instance admin");
  });

  it("hides foreign projects from another admin with identical missing responses", async () => {
    const request = input();
    const own = (
      await send({ method: "POST", url: base, payload: request })
    ).json<CreateWorkshopProjectResponse>();
    const theirs = await send({ method: "POST", url: base, payload: request }, ids.userB);
    expect(theirs.statusCode).toBe(201);
    expect(theirs.json<CreateWorkshopProjectResponse>().project.id).not.toBe(own.project.id);
    const list = (
      await send({ method: "GET", url: base }, ids.userB)
    ).json<ListWorkshopProjectsResponse>();
    expect(list.projects.map((project) => project.id)).not.toContain(own.project.id);
    for (const operation of [
      { method: "GET", suffix: "" },
      { method: "GET", suffix: "/messages" },
      { method: "POST", suffix: "/messages" }
    ] as const) {
      const payload =
        operation.method === "POST" ? { messageId: randomUUID(), text: "No" } : undefined;
      const foreign = await send(
        { method: operation.method, url: `${base}/${own.project.id}${operation.suffix}`, payload },
        ids.userB
      );
      const missing = await send(
        { method: operation.method, url: `${base}/${randomUUID()}${operation.suffix}`, payload },
        ids.userB
      );
      expect(foreign.statusCode).toBe(404);
      expect(missing.statusCode).toBe(404);
      expect(foreign.json()).toEqual(missing.json());
    }
  });

  it("saves pending messages, deduplicates retries, and resumes from string cursors", async () => {
    const { project } = await create();
    const url = `${base}/${project.id}/messages`;
    const payload = { messageId: randomUUID(), text: "Keep this after reconnect" };
    const first = await send({ method: "POST", url, payload });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({
      created: true,
      entry: {
        ...payload,
        projectId: project.id,
        sequence: "1",
        kind: "user_message",
        delivery: "pending"
      }
    });
    expect(Object.keys(first.json().entry).sort()).toEqual([
      "createdAt",
      "delivery",
      "kind",
      "messageId",
      "projectId",
      "sequence",
      "text"
    ]);
    const replay = await send({ method: "POST", url, payload });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ ...first.json(), created: false });
    expect(
      (await send({ method: "POST", url, payload: { ...payload, text: "Changed" } })).statusCode
    ).toBe(409);
    expect((await send({ method: "GET", url })).json()).toEqual({
      entries: [first.json().entry],
      nextCursor: "1"
    });
    expect((await send({ method: "GET", url: `${url}?after=1` })).json()).toEqual({
      entries: [],
      nextCursor: "1"
    });
  });

  it("paginates project timestamps and rejects malformed inputs with curated errors", async () => {
    const { project } = await create();
    const first = (
      await send({ method: "GET", url: `${base}?limit=1` })
    ).json<ListWorkshopProjectsResponse>();
    expect(first.nextCursor).not.toBeNull();
    const cursor = first.nextCursor!;
    const next = await send({
      method: "GET",
      url: `${base}?limit=1&beforeId=${cursor.id}&beforeCreatedAt=${encodeURIComponent(cursor.createdAt)}`
    });
    expect(next.statusCode).toBe(200);
    expect(next.json<ListWorkshopProjectsResponse>().projects.map((row) => row.id)).not.toContain(
      first.projects[0]!.id
    );
    for (const options of [
      { method: "POST", url: base, payload: { ...input(), title: "é".repeat(81) } },
      { method: "POST", url: base, payload: { ...input(), initialRequest: "é".repeat(8193) } },
      { method: "POST", url: base, payload: { ...input(), context: "\0" } },
      { method: "POST", url: base, payload: { ...input(), title: " " } },
      { method: "POST", url: base, payload: { ...input(), requestKey: "invalid" } },
      { method: "GET", url: `${base}/invalid` },
      { method: "GET", url: `${base}?limit=101` },
      { method: "GET", url: `${base}?beforeId=${randomUUID()}` },
      { method: "GET", url: `${base}?beforeId=${randomUUID()}&beforeCreatedAt=invalid` },
      { method: "GET", url: `${base}/${project.id}/messages?after=9223372036854775808` },
      { method: "GET", url: `${base}/${project.id}/messages?after=-1` },
      {
        method: "POST",
        url: `${base}/${project.id}/messages`,
        payload: { messageId: randomUUID(), text: "é".repeat(8193) }
      }
    ] satisfies InjectOptions[]) {
      const response = await send(options);
      expect(response.statusCode, JSON.stringify(options)).toBe(400);
      expect(response.json()).toEqual({
        error: "Check the project fields and page cursor, then try again."
      });
    }
  });
});
