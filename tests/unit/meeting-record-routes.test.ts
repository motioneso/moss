import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccessContext, DataContextDb } from "@moss/db";
import { HttpError } from "@moss/module-sdk";
import type { MeetingRecord } from "@moss/shared";
import {
  MeetingRecordConflictError,
  MeetingRecordInputError,
  registerMeetingRecordRoutes,
  type MeetingRecordsRepository
} from "@moss/meetings";

const id = "11111111-1111-4111-8111-111111111111";
const requestKey = "22222222-2222-4222-8222-222222222222";
const record: MeetingRecord = {
  id,
  title: "Meeting draft",
  personalNotes: "A note",
  notesRevision: 1,
  createdAt: "2026-10-03T12:00:00.000Z",
  updatedAt: "2026-10-03T12:01:00.000Z"
};
const servers: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function setup(authError?: Error) {
  const server = Fastify();
  servers.push(server);
  const scopedDb = {} as DataContextDb;
  const contexts: AccessContext[] = [];
  const repository = {
    remove: vi.fn<MeetingRecordsRepository["remove"]>().mockResolvedValue(undefined),
    create: vi
      .fn<MeetingRecordsRepository["create"]>()
      .mockResolvedValue({ created: true, meeting: record }),
    get: vi.fn<MeetingRecordsRepository["get"]>().mockResolvedValue(record),
    list: vi.fn<MeetingRecordsRepository["list"]>().mockResolvedValue([record]),
    putNotes: vi
      .fn<MeetingRecordsRepository["putNotes"]>()
      .mockResolvedValue({ status: "saved", replayed: false, meeting: record })
  };
  registerMeetingRecordRoutes(server, {
    resolveAccessContext: async () => {
      if (authError) throw authError;
      return { actorUserId: id, requestId: "test-request" };
    },
    dataContext: {
      withDataContext: async <T>(actor: AccessContext, work: (db: DataContextDb) => Promise<T>) => {
        contexts.push(actor);
        return work(scopedDb);
      }
    },
    repository
  });
  return { server, repository, contexts, scopedDb };
}

describe("meeting draft record routes", () => {
  it("deletes through the actor context and returns no content on retries", async () => {
    const { server, repository, scopedDb, contexts } = setup();
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await server.inject({
        method: "DELETE",
        url: `/api/meetings/records/${id}`
      });
      expect(response.statusCode).toBe(204);
      expect(response.body).toBe("");
    }
    expect(repository.remove).toHaveBeenCalledTimes(2);
    expect(repository.remove).toHaveBeenCalledWith(scopedDb, id);
    expect(contexts.every((context) => context.actorUserId === id)).toBe(true);
  });

  it("creates a draft under the resolved actor and strips body ownership claims", async () => {
    const { server, repository, contexts, scopedDb } = setup();
    const response = await server.inject({
      method: "POST",
      url: "/api/meetings/records",
      payload: { requestKey, title: record.title, ownerUserId: "other-person" }
    });
    expect(response.statusCode).toBe(201);
    expect(repository.create).toHaveBeenCalledExactlyOnceWith(scopedDb, {
      requestKey,
      title: record.title
    });
    expect(contexts).toEqual([{ actorUserId: id, requestId: "test-request" }]);
  });
  it("returns 200 for an exact create replay", async () => {
    const { server, repository } = setup();
    repository.create.mockResolvedValue({ created: false, meeting: record });
    const response = await server.inject({
      method: "POST",
      url: "/api/meetings/records",
      payload: { requestKey, title: record.title }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ created: false, meeting: record });
  });
  it.each(["GET", "POST", "PUT"] as const)("requires authentication for %s", async (method) => {
    const { server, repository, contexts } = setup(new HttpError(401, "Authentication required"));
    const url = method === "PUT" ? `/api/meetings/records/${id}/notes` : "/api/meetings/records";
    const payload =
      method === "POST"
        ? { requestKey, title: record.title }
        : method === "PUT"
          ? { requestKey, expectedRevision: 1, personalNotes: "New" }
          : undefined;
    const response = await server.inject({ method, url, payload });
    expect(response.statusCode).toBe(401);
    expect(contexts).toEqual([]);
    expect(repository.create).not.toHaveBeenCalled();
    expect(repository.list).not.toHaveBeenCalled();
    expect(repository.putNotes).not.toHaveBeenCalled();
  });
  it("requires both pagination cursor fields", async () => {
    const { server, repository } = setup();
    const response = await server.inject(`/api/meetings/records?beforeId=${id}`);
    expect(response.statusCode).toBe(400);
    expect(repository.list).not.toHaveBeenCalled();
  });
  it("forwards bounded pagination", async () => {
    const { server, repository, scopedDb } = setup();
    const response = await server.inject(
      `/api/meetings/records?limit=2&beforeId=${id}&beforeCreatedAt=2026-10-03T12%3A00%3A00.000Z`
    );
    expect(response.statusCode).toBe(200);
    expect(repository.list).toHaveBeenCalledExactlyOnceWith(scopedDb, {
      limit: 2,
      before: { id, createdAt: record.createdAt }
    });
  });
  it("returns the same unavailable result for an absent or inaccessible draft", async () => {
    const { server, repository } = setup();
    repository.get.mockResolvedValue(null);
    const response = await server.inject(`/api/meetings/records/${id}`);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ code: "meeting_not_found" });
  });
  it("saves notes against the URL identity and returns immutable replay results", async () => {
    const { server, repository, scopedDb } = setup();
    repository.putNotes.mockResolvedValue({ status: "saved", replayed: true, meeting: record });
    const response = await server.inject({
      method: "PUT",
      url: `/api/meetings/records/${id}/notes`,
      payload: {
        requestKey,
        expectedRevision: 1,
        personalNotes: "Edited",
        meetingId: "other-meeting"
      }
    });
    expect(response.statusCode).toBe(200);
    expect(repository.putNotes).toHaveBeenCalledExactlyOnceWith(scopedDb, {
      requestKey,
      expectedRevision: 1,
      personalNotes: "Edited",
      meetingId: id
    });
    expect(response.json()).toEqual({ status: "saved", replayed: true, meeting: record });
  });
  it("returns current notes on a version conflict", async () => {
    const { server, repository } = setup();
    repository.putNotes.mockResolvedValue({ status: "conflict", meeting: record });
    const response = await server.inject({
      method: "PUT",
      url: `/api/meetings/records/${id}/notes`,
      payload: { requestKey, expectedRevision: 0, personalNotes: "Old edit" }
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      code: "meeting_notes_conflict",
      status: "conflict",
      meeting: record
    });
  });
  it.each([
    [new MeetingRecordConflictError(), 409, "meeting_request_conflict"],
    [new MeetingRecordInputError("private input must not appear"), 400, "meeting_invalid_input"]
  ] as const)("uses content-free validation errors", async (error, status, code) => {
    const { server, repository } = setup();
    repository.create.mockRejectedValue(error);
    const response = await server.inject({
      method: "POST",
      url: "/api/meetings/records",
      payload: { requestKey, title: record.title }
    });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toEqual({ code });
  });
  it.each([-1, 101, 1.5])("rejects invalid list size %s", async (limit) => {
    const { server, repository } = setup();
    expect((await server.inject(`/api/meetings/records?limit=${limit}`)).statusCode).toBe(400);
    expect(repository.list).not.toHaveBeenCalled();
  });
});
