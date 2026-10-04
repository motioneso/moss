import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DataContextRunner } from "@moss/db";
import {
  MeetingOutputError,
  MeetingOutputsRepository,
  registerMeetingOutputRoutes
} from "@moss/meetings";
const meetingId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const candidateId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const requestKey = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
afterEach(() => vi.restoreAllMocks());
describe("Meeting output exact versions", () => {
  it("loads a candidate source outside the history page through its exact version", async () => {
    const server = Fastify();
    const inputs = { meetingId, notesRevision: 1, personalNotes: "Source", transcript: null };
    vi.spyOn(MeetingOutputsRepository.prototype, "inputs").mockResolvedValue({
      ...inputs,
      notesRevision: 2
    });
    const getArtifact = vi
      .spyOn(MeetingOutputsRepository.prototype, "getArtifact")
      .mockResolvedValue({
        id: candidateId,
        meetingId,
        version: 1,
        inputs,
        templateId: "general",
        templateVersion: 1,
        modelRoute: "test",
        content: {
          overview: "Overview",
          decisions: [],
          openQuestions: [],
          actions: [],
          warnings: []
        },
        origin: "generated",
        stale: false,
        createdAt: "2026-10-04T00:00:00.000Z"
      });
    const transaction = vi.fn(async (_actor: unknown, fn: (db: unknown) => Promise<unknown>) =>
      fn({})
    );
    const preflight = vi.fn();
    registerMeetingOutputRoutes(server, {
      resolveAccessContext: async () => ({ actorUserId: meetingId }),
      dataContext: { withDataContext: transaction } as unknown as Pick<
        DataContextRunner,
        "withDataContext"
      >,
      generator: vi.fn(),
      createTask: vi.fn(),
      assertTaskAvailable: preflight
    });
    const result = await server.inject({
      method: "GET",
      url: `/api/meetings/records/${meetingId}/outputs/1`
    });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({
      artifact: { version: 1, stale: true, inputs: { notesRevision: 1, personalNotes: "Source" } }
    });
    expect(getArtifact).toHaveBeenCalledWith({}, meetingId, 1);
    expect(preflight).not.toHaveBeenCalled();
    getArtifact.mockResolvedValue(null);
    expect(
      (
        await server.inject({
          method: "GET",
          url: `/api/meetings/records/${meetingId}/outputs/999`
        })
      ).statusCode
    ).toBe(404);
    const calls = transaction.mock.calls.length;
    expect(
      (
        await server.inject({
          method: "GET",
          url: `/api/meetings/records/${meetingId}/outputs/1001`
        })
      ).statusCode
    ).toBe(400);
    expect(transaction).toHaveBeenCalledTimes(calls);
    await server.close();
  });
});
describe("Meeting output action preflight", () => {
  it("checks Task availability before opening the acceptance transaction", async () => {
    const server = Fastify();
    const order: string[] = [];
    const transaction = vi.fn(async () => {
      order.push("transaction");
      return { reviewState: "accepted" };
    });
    const dataContext = { withDataContext: transaction } as unknown as Pick<
      DataContextRunner,
      "withDataContext"
    >;
    registerMeetingOutputRoutes(server, {
      resolveAccessContext: async () => ({ actorUserId: meetingId }),
      dataContext,
      generator: vi.fn(),
      createTask: vi.fn(),
      assertTaskAvailable: async () => {
        order.push("preflight");
      }
    });
    const result = await server.inject({
      method: "POST",
      url: `/api/meetings/records/${meetingId}/actions/${candidateId}/review`,
      payload: { requestKey, decision: "accept", title: "Reviewed action" }
    });
    expect(result.statusCode).toBe(200);
    expect(order).toEqual(["preflight", "transaction"]);
    await server.close();
  });
  it("does not start acceptance when module availability fails", async () => {
    const server = Fastify();
    const transaction = vi.fn();
    registerMeetingOutputRoutes(server, {
      resolveAccessContext: async () => ({ actorUserId: meetingId }),
      dataContext: { withDataContext: transaction },
      generator: vi.fn(),
      createTask: vi.fn(),
      assertTaskAvailable: async () => {
        throw new MeetingOutputError("meeting_action_tasks_unavailable", 403);
      }
    });
    const result = await server.inject({
      method: "POST",
      url: `/api/meetings/records/${meetingId}/actions/${candidateId}/review`,
      payload: { requestKey, decision: "accept", title: "Reviewed action" }
    });
    expect(result.statusCode).toBe(403);
    expect(result.json()).toMatchObject({ code: "meeting_action_tasks_unavailable" });
    expect(transaction).not.toHaveBeenCalled();
    await server.close();
  });
  it("allows dismissals without requiring Tasks availability", async () => {
    const server = Fastify();
    const preflight = vi.fn();
    const review = vi.spyOn(MeetingOutputsRepository.prototype, "review").mockResolvedValue({
      id: candidateId,
      meetingId,
      artifactVersion: 1,
      reviewState: "dismissed",
      acceptedTaskId: null,
      possibleMatchIds: [],
      proposal: { text: "Task", evidence: [], ownerPhrase: null, duePhrase: null }
    });
    const transaction = vi.fn(async (_actor: unknown, fn: (db: unknown) => Promise<unknown>) =>
      fn({})
    );
    registerMeetingOutputRoutes(server, {
      resolveAccessContext: async () => ({ actorUserId: meetingId }),
      dataContext: { withDataContext: transaction } as unknown as Pick<
        DataContextRunner,
        "withDataContext"
      >,
      generator: vi.fn(),
      createTask: vi.fn(),
      assertTaskAvailable: preflight
    });
    const result = await server.inject({
      method: "POST",
      url: `/api/meetings/records/${meetingId}/actions/${candidateId}/review`,
      payload: { requestKey, decision: "dismiss" }
    });
    expect(result.statusCode).toBe(200);
    expect(preflight).not.toHaveBeenCalled();
    expect(review).toHaveBeenCalledOnce();
    await server.close();
  });
});
