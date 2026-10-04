import { createHash } from "node:crypto";
import type { PgBoss } from "pg-boss";
import type { ActiveModulesResolver } from "@moss/ai";
import { assertUuid, type AccessContext } from "@moss/db";
import { enqueueVaultIngestNudge } from "@moss/memory";
import { MeetingOutputError, type MeetingExportService } from "@moss/meetings";
import { isPrivateNoteExportReference, type PrivateNoteIndexPort } from "@moss/notes";

/** Only canonical opaque references enter queue metadata; never summary text or titles. */
export function createMeetingNoteIndexPort(boss: PgBoss): PrivateNoteIndexPort {
  return {
    async enqueue(access, noteReference) {
      assertUuid(access.actorUserId, "Meeting note owner");
      if (!isPrivateNoteExportReference(noteReference)) {
        throw new MeetingOutputError("meeting_export_invalid_input", 400);
      }
      const key = createHash("sha256")
        .update(`${access.actorUserId}\0${noteReference}`, "utf8")
        .digest("hex");
      return enqueueVaultIngestNudge(
        boss,
        { actorUserId: access.actorUserId, sourcePath: noteReference, op: "upsert" },
        { deduplicationKey: key }
      );
    }
  };
}

/** Preflight happens before receipt transactions, avoiding nested app-pool acquisition. */
export function withMeetingExportAvailability(
  service: Pick<MeetingExportService, "save" | "list">,
  resolveActiveModules: ActiveModulesResolver
): Pick<MeetingExportService, "save" | "list"> {
  const check = async (access: AccessContext, requireNotes: boolean) => {
    const modules = await resolveActiveModules(access.actorUserId);
    if (
      !modules.some((module) => module.id === "meetings") ||
      (requireNotes && !modules.some((module) => module.id === "notes"))
    ) {
      throw new MeetingOutputError("meeting_export_unavailable", 409);
    }
  };
  return {
    async save(access, meetingId, input) {
      await check(access, true);
      return service.save(access, meetingId, input);
    },
    async list(access, meetingId) {
      await check(access, false);
      return service.list(access, meetingId);
    }
  };
}
