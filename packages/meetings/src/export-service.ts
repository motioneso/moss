import { createHash } from "node:crypto";
import { assertUuid, type AccessContext, type DataContextRunner } from "@moss/db";
import type { MeetingPrivateExportPort } from "./export-port.js";
import type { ExportMeetingOutputInput, MeetingExportReceipt } from "@moss/shared";
import { MeetingExportsRepository } from "./export-repository.js";
import { MeetingOutputError } from "./output-repository.js";

type ExportStore = Pick<
  MeetingExportsRepository,
  "lock" | "list" | "content" | "request" | "reserve" | "receipt" | "intend" | "finish"
>;

/** Only the explicit authenticated save endpoint invokes this service. No automatic export. */
export class MeetingExportService {
  constructor(
    private readonly dataContext: Pick<DataContextRunner, "withDataContext">,
    private readonly notes: MeetingPrivateExportPort,
    private readonly repository: ExportStore = new MeetingExportsRepository()
  ) {}

  async list(access: AccessContext, meetingId: string): Promise<MeetingExportReceipt[]> {
    assertUuid(meetingId, "Meeting id");
    return this.dataContext.withDataContext(access, async (db) => {
      await this.repository.lock(db, meetingId);
      return this.repository.list(db, meetingId);
    });
  }

  async save(
    access: AccessContext,
    meetingId: string,
    input: ExportMeetingOutputInput
  ): Promise<MeetingExportReceipt> {
    assertUuid(meetingId, "Meeting id");
    assertUuid(input.requestKey, "Meeting export request key");
    if (
      !Number.isSafeInteger(input.artifactVersion) ||
      input.artifactVersion < 1 ||
      input.artifactVersion > 1000
    )
      throw new MeetingOutputError("meeting_export_invalid_input", 400);
    // Commit expected hash before the filesystem side effect. A rolled-back final receipt
    // is recoverable by inspecting exact target bytes on the next explicit attempt.
    const replay = await this.dataContext.withDataContext(access, async (db) => {
      await this.repository.lock(db, meetingId);
      const previous = await this.repository.request(
        db,
        meetingId,
        input.requestKey,
        input.artifactVersion
      );
      if (previous) return previous;
      const content = await this.repository.content(db, meetingId, input.artifactVersion);
      await this.repository.intend(db, meetingId, input.artifactVersion, content);
      await this.repository.reserve(db, meetingId, input.requestKey, input.artifactVersion);
      return null;
    });
    if (replay) return replay;
    return this.dataContext.withDataContext(access, async (db) => {
      await this.repository.lock(db, meetingId);
      const previous = await this.repository.request(
        db,
        meetingId,
        input.requestKey,
        input.artifactVersion
      );
      if (previous) return previous;
      const receipt = await this.repository.receipt(db, meetingId, input.artifactVersion);
      if (!receipt) throw new MeetingOutputError("meeting_export_unavailable", 404);
      const content = await this.repository.content(db, meetingId, input.artifactVersion);
      if (createHash("sha256").update(content, "utf8").digest("hex") !== receipt.contentHash)
        throw new MeetingOutputError("meeting_export_content_conflict");
      const result = await this.runStages(access, receipt, content);
      await this.repository.finish(db, input.requestKey, result);
      return result;
    });
  }

  private async runStages(
    access: AccessContext,
    receipt: MeetingExportReceipt,
    content: string
  ): Promise<MeetingExportReceipt> {
    const identity = { sourceId: receipt.meetingId, version: receipt.artifactVersion };
    let result = { ...receipt, updatedAt: new Date().toISOString() };
    const conflict = (): MeetingExportReceipt => ({
      ...result,
      writeStatus: result.writeStatus === "saved" ? "saved" : "conflict",
      indexStatus: result.indexStatus === "queued" ? "queued" : "conflict",
      errorCode: "meeting_vault_conflict"
    });
    try {
      let observed = await this.notes.inspect(access, identity, content);
      // A previously confirmed copy that disappeared is not recreated behind an editor's back.
      if (
        observed.status === "conflict" ||
        (observed.status === "missing" && result.writeStatus === "saved")
      )
        return conflict();
      if (observed.status === "missing") {
        try {
          const written = await this.notes.createOrInspect(access, identity, content);
          if (written.status === "conflict") return conflict();
          observed = { ...written, status: "unchanged" };
        } catch {
          // Creation may have succeeded before an acknowledgement failed. Never blindly rewrite.
          observed = await this.notes.inspect(access, identity, content);
          if (observed.status === "conflict") return conflict();
          if (observed.status === "missing") throw new Error("write unconfirmed");
        }
      }
      result = {
        ...result,
        writeStatus: "saved",
        noteReference: observed.noteReference,
        errorCode: null
      };
    } catch {
      return {
        ...result,
        writeStatus: result.writeStatus === "saved" ? "saved" : "failed",
        errorCode: "meeting_vault_write_failed"
      };
    }
    if (result.indexStatus === "queued") return result;
    try {
      const index = await this.notes.queueIndex(access, identity, content);
      if (index.status === "conflict") return conflict();
      return {
        ...result,
        indexStatus: index.status,
        indexJobId: index.status === "queued" ? index.jobId : null,
        errorCode: index.status === "delayed" ? "meeting_index_delayed" : null
      };
    } catch {
      return { ...result, indexStatus: "delayed", errorCode: "meeting_index_delayed" };
    }
  }
}
