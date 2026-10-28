import type { AccessContext, DataContextDb, DataContextRunner } from "@moss/db";
import { MeetingRecordsRepository } from "./repository.js";

export type MeetingCleanupStatus = "complete" | "pending" | "conflict";

/** Host composes owning cleanup; Meetings retains its own record deletion. */
export interface MeetingDeletionPort {
  withCleanSource(
    access: AccessContext,
    meetingId: string,
    remove: (db: DataContextDb) => Promise<void>
  ): Promise<MeetingCleanupStatus>;
}

export class MeetingCleanupError extends Error {
  readonly code: "meeting_cleanup_pending" | "meeting_cleanup_conflict";
  constructor(status: "pending" | "conflict") {
    super(
      status === "pending"
        ? "Recording cleanup is pending; retry deletion to continue"
        : "A recording contribution changed; review its current note before retrying deletion"
    );
    this.name = "MeetingCleanupError";
    this.code = status === "pending" ? "meeting_cleanup_pending" : "meeting_cleanup_conflict";
  }
}

/** Owner proof and fencing occur before any record row lock or import/chat cleanup. */
export class MeetingDeletionService {
  private readonly records = new MeetingRecordsRepository();
  constructor(
    private readonly dependencies: {
      readonly dataContext: DataContextRunner;
      readonly cleanup: MeetingDeletionPort;
      readonly beforeRemove: (
        db: DataContextDb,
        meetingId: string,
        access: AccessContext
      ) => Promise<void>;
    }
  ) {}

  async remove(access: AccessContext, meetingId: string): Promise<void> {
    const exists = await this.dependencies.dataContext.withDataContext(access, (db) =>
      this.records.get(db, meetingId)
    );
    if (!exists) return;
    const status = await this.dependencies.cleanup.withCleanSource(
      access,
      meetingId,
      async (db) => {
        if (!(await this.records.get(db, meetingId, { forUpdate: true }))) return;
        await this.dependencies.beforeRemove(db, meetingId, access);
        await this.records.remove(db, meetingId);
      }
    );
    if (status !== "complete") throw new MeetingCleanupError(status);
  }
}
