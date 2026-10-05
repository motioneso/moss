import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccessContext, DataContextDb } from "@moss/db";
import type { GenerateMeetingOutputInput, MeetingOutputResult } from "@moss/shared";
import { ApiError } from "@moss/module-web-sdk";
import {
  MeetingOutputError,
  MeetingOutputsRepository,
  registerMeetingOutputRoutes
} from "@moss/meetings";
import { generateMeetingOutput } from "../../packages/meetings/src/web/output-client.js";

const meetingId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const input: GenerateMeetingOutputInput = {
  requestKey: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  expectedOutputVersion: 0,
  expectedTranscriptRevision: 0,
  expectedNotesRevision: 1,
  templateId: "general",
  templateVersion: 1
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("meeting summary failure transport", () => {
  it.each([
    "meeting_output_route_unavailable",
    "meeting_output_route_changed",
    "meeting_output_generation_failed"
  ])("preserves only the safe %s code through service, route and browser client", async (code) => {
    // Every database port is stubbed; the real service and HTTP serializers run without I/O.
    vi.spyOn(MeetingOutputsRepository.prototype, "lock").mockResolvedValue({
      id: meetingId,
      title: "Synthetic meeting",
      personalNotes: "Synthetic notes",
      notesRevision: 1,
      createdAt: "2026-10-04T00:00:00Z",
      updatedAt: "2026-10-04T00:00:00Z"
    });
    vi.spyOn(MeetingOutputsRepository.prototype, "request").mockResolvedValue(undefined);
    vi.spyOn(MeetingOutputsRepository.prototype, "pendingGeneration").mockResolvedValue(null);
    vi.spyOn(MeetingOutputsRepository.prototype, "head").mockResolvedValue(null);
    vi.spyOn(MeetingOutputsRepository.prototype, "inputs").mockResolvedValue({
      meetingId,
      personalNotes: "Synthetic notes",
      notesRevision: 1,
      transcript: null
    });
    vi.spyOn(MeetingOutputsRepository.prototype, "reserve").mockResolvedValue(undefined);
    const finish = vi
      .spyOn(MeetingOutputsRepository.prototype, "finish")
      .mockResolvedValue(undefined);
    const save = vi.spyOn(MeetingOutputsRepository.prototype, "save");
    const failure =
      code === "meeting_output_generation_failed"
        ? new Error("Private provider credential error")
        : new MeetingOutputError(code);
    failure.message = "Private provider credential error";
    const generator = vi.fn().mockRejectedValue(failure);
    const server = Fastify();
    registerMeetingOutputRoutes(server, {
      resolveAccessContext: async () => ({ actorUserId: "owner" }),
      dataContext: {
        withDataContext: async <T>(_actor: AccessContext, run: (db: DataContextDb) => Promise<T>) =>
          run({} as DataContextDb)
      },
      generationAvailability: async () => "available",
      generator,
      createTask: vi.fn(),
      assertTaskAvailable: vi.fn()
    });
    try {
      const response = await server.inject({
        method: "POST",
        url: `/api/meetings/records/${meetingId}/outputs`,
        payload: input
      });
      const expected: MeetingOutputResult = {
        status: "failed",
        requestKey: input.requestKey,
        code
      };
      expect(response.statusCode).toBe(422);
      expect(response.json()).toEqual(expected);
      expect(finish).toHaveBeenCalledWith({}, meetingId, input.requestKey, expected);
      expect(generator).toHaveBeenCalledOnce();
      expect(save).not.toHaveBeenCalled();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response(response.body, { status: response.statusCode }))
      );
      const result = generateMeetingOutput(meetingId, input);
      await expect(result).rejects.toBeInstanceOf(ApiError);
      await expect(result).rejects.toMatchObject({ status: 422, code });
      await expect(result).rejects.not.toThrow("Private provider credential error");
    } finally {
      await server.close();
    }
  });
});
