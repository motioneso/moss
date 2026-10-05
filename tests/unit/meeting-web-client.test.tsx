import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@moss/module-web-sdk";
import {
  createMeeting,
  listMeetings,
  saveMeetingNotes
} from "../../packages/meetings/src/web/client.js";

afterEach(() => vi.unstubAllGlobals());
describe("meeting browser transport", () => {
  it("uses the canonical credentialed JSON client and preserves request keys", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ created: true, meeting: {} }), { status: 201 })
      );
    vi.stubGlobal("fetch", fetch);
    await createMeeting({ requestKey: "same-key", title: "Review" });
    const [path, options] = fetch.mock.calls[0]!;
    expect(path).toBe("/api/meetings/records");
    expect(options.credentials).toBe("include");
    expect(JSON.parse(options.body)).toEqual({ requestKey: "same-key", title: "Review" });
  });
  it("passes the stable pagination cursor without ambient date conversion", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{"meetings":[]}'));
    vi.stubGlobal("fetch", fetch);
    await listMeetings({ id: "record-id", createdAt: "2026-10-03T12:00:00.000Z" });
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "/api/meetings/records?limit=30&beforeId=record-id&beforeCreatedAt=2026-10-03T12%3A00%3A00.000Z"
    );
  });
  it("retains conflict status and safe server code for the review path", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response('{"code":"meeting_notes_conflict"}', { status: 409 }))
    );
    const result = saveMeetingNotes({
      meetingId: "record-id",
      requestKey: "key",
      expectedRevision: 1,
      personalNotes: "My notes"
    });
    await expect(result).rejects.toBeInstanceOf(ApiError);
    await expect(result).rejects.toMatchObject({ status: 409, code: "meeting_notes_conflict" });
  });
});
