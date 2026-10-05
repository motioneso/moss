import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { PgBoss } from "pg-boss";
import { VAULT_INGEST_NUDGE_QUEUE } from "@moss/memory";
import { meetingsModuleManifest, MeetingOutputError } from "@moss/meetings";
import { notesModuleManifest } from "@moss/notes";
import type { ActiveModulesResolver } from "@moss/ai";
import type { MeetingExportReceipt } from "@moss/shared";
import {
  createMeetingNoteIndexPort,
  withMeetingExportAvailability
} from "../../packages/module-registry/src/meeting-export-runtime.js";

const actor = { actorUserId: "11223344-1122-4122-8122-112233445566" };
const meetingId = "22334455-1122-4122-8122-112233445566";
const reference = `notes/generated/${meetingId}/v1.md`;
const input = { requestKey: "33445566-1122-4122-8122-112233445566", artifactVersion: 1 };

describe("meeting private-export composition", () => {
  it("queues only validated opaque metadata with a stable duplicate-suppression key", async () => {
    const send = vi.fn().mockResolvedValue("job-id");
    const port = createMeetingNoteIndexPort({ send } as unknown as PgBoss);
    expect(await port.enqueue(actor, reference)).toEqual({ status: "queued", jobId: "job-id" });
    expect(send).toHaveBeenCalledWith(
      VAULT_INGEST_NUDGE_QUEUE,
      { actorUserId: actor.actorUserId, sourcePath: reference, op: "upsert" },
      {
        singletonKey: createHash("sha256")
          .update(`${actor.actorUserId}\0${reference}`)
          .digest("hex"),
        singletonSeconds: 300
      }
    );
    send.mockResolvedValue(null);
    expect(await port.enqueue(actor, reference)).toEqual({ status: "delayed" });
  });

  it.each([
    "private transcript content",
    `notes/generated/${meetingId}/v01.md`,
    `${reference}\n`,
    `notes/generated/${meetingId}/../../secret.md`,
    `notes/generated/${meetingId}/v2147483648.md`
  ])("rejects a noncanonical queue reference: %s", async (value) => {
    const send = vi.fn();
    const port = createMeetingNoteIndexPort({ send } as unknown as PgBoss);
    await expect(port.enqueue(actor, value)).rejects.toBeInstanceOf(MeetingOutputError);
    expect(send).not.toHaveBeenCalled();
  });

  it("checks active modules before any receipt transaction or private write", async () => {
    const receipt = { meetingId } as MeetingExportReceipt;
    const service = {
      save: vi.fn().mockResolvedValue(receipt),
      list: vi.fn().mockResolvedValue([receipt])
    };
    const resolve = vi.fn<ActiveModulesResolver>().mockResolvedValue([meetingsModuleManifest]);
    const port = withMeetingExportAvailability(service, resolve);
    await expect(port.save(actor, meetingId, input)).rejects.toMatchObject({
      code: "meeting_export_unavailable"
    });
    expect(service.save).not.toHaveBeenCalled();
    expect(await port.list(actor, meetingId)).toEqual([receipt]);
    resolve.mockResolvedValue([meetingsModuleManifest, notesModuleManifest]);
    expect(await port.save(actor, meetingId, input)).toBe(receipt);
    expect(service.save).toHaveBeenCalledWith(actor, meetingId, input);
    resolve.mockResolvedValue([]);
    await expect(port.list(actor, meetingId)).rejects.toMatchObject({
      code: "meeting_export_unavailable"
    });
    expect(service.list).toHaveBeenCalledTimes(1);
  });
});
