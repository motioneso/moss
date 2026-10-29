import type { PgBoss } from "@moss/jobs";
import type { AccessContext, DataContextRunner } from "@moss/db";
import {
  ModuleNoticeService,
  ModuleNoticeUnavailableError,
  type ModuleNoticeDefinition
} from "@moss/chat";
import {
  MeetingRecordsRepository,
  RecordingMetadataRepository,
  createRecordingNoticeEnqueue,
  type RecordingNoticeEnqueue,
  recordingSideReviewVersion
} from "@moss/meetings";
import {
  ManagedSourceLifecycle,
  ManagedSourceFencedError,
  ManagedSourceUnavailableError
} from "@moss/notes";

const NOTICE_KIND = "side_uncertainty";

function unavailable(error: unknown): boolean {
  return (
    error instanceof ManagedSourceUnavailableError || error instanceof ManagedSourceFencedError
  );
}

/** Host composition only. Neither owning module reads the other's tables. */
export function createRecordingNoticeRuntime(deps: {
  readonly dataContext: DataContextRunner;
  readonly isMeetingsAvailable: (access: AccessContext) => Promise<boolean>;
}) {
  const records = new MeetingRecordsRepository();
  const metadata = new RecordingMetadataRepository();
  const lifecycle = new ManagedSourceLifecycle(deps.dataContext, {
    async assertExists(db, source) {
      if (source.sourceModuleId !== "meetings" || !(await records.get(db, source.sourceId)))
        throw new ManagedSourceUnavailableError();
    }
  });
  const definition: ModuleNoticeDefinition = {
    moduleId: "meetings",
    noticeKind: NOTICE_KIND,
    actionNames: [],
    async withCurrentSource(access, source, work) {
      if (!(await deps.isMeetingsAvailable(access))) throw new ModuleNoticeUnavailableError();
      try {
        await lifecycle.registerSource(access, {
          ownerUserId: access.actorUserId,
          sourceModuleId: "meetings",
          sourceId: source.sourceId
        });
        return await deps.dataContext.withDataContext(access, async (db) => {
          const snapshot = await lifecycle.captureSourcesScoped(db, [
            {
              ownerUserId: access.actorUserId,
              sourceModuleId: "meetings",
              sourceId: source.sourceId
            }
          ]);
          return lifecycle.withPublicationScoped(db, snapshot, async (scoped) => {
            // Metadata writers hold this same owning record lock. Keep the current version
            // admitted through Chat's short receipt/message transaction.
            const record = await records.get(scoped, source.sourceId, { forUpdate: true });
            if (!record) return undefined;
            const current = await metadata.get(scoped, source.sourceId);
            if (!current || recordingSideReviewVersion(current) !== source.sourceVersion)
              return undefined;
            return work(scoped, {
              text: `I marked “${record.title}” as ${current.side}. ${current.reason ?? "I am not certain which side fits."} Review the [recording](/meetings?id=${source.sourceId}) in Meetings.`,
              actions: []
            });
          });
        });
      } catch (error) {
        if (unavailable(error)) return undefined;
        throw error;
      }
    }
  };
  const notices = new ModuleNoticeService(deps.dataContext, [definition]);
  return {
    notices,
    enqueue(boss: Pick<PgBoss, "send">): RecordingNoticeEnqueue {
      const enqueue = createRecordingNoticeEnqueue(boss);
      return async (db, payload) => {
        await notices.reservePendingScoped({ actorUserId: payload.actorUserId }, db, {
          moduleId: "meetings",
          sourceId: payload.resourceId,
          sourceVersion: payload.sourceVersion,
          noticeKind: NOTICE_KIND
        });
        await enqueue(db, payload);
      };
    },
    /** No text, destination, message ID or action grant is accepted from the caller. */
    async publishSideReview(
      access: AccessContext,
      meetingId: string,
      expectedSourceVersion?: string
    ) {
      if (!(await deps.isMeetingsAvailable(access))) return { state: "stale" as const };
      try {
        const current = await deps.dataContext.withDataContext(access, (db) =>
          metadata.get(db, meetingId)
        );
        if (!current) return { state: "stale" as const };
        const sourceVersion = recordingSideReviewVersion(current);
        if (!sourceVersion) return { state: "not_applicable" as const };
        if (expectedSourceVersion !== undefined && sourceVersion !== expectedSourceVersion)
          return { state: "stale" as const };
        return notices.publish(access, {
          moduleId: "meetings",
          sourceId: meetingId,
          sourceVersion,
          noticeKind: NOTICE_KIND
        });
      } catch (error) {
        if (unavailable(error)) return { state: "stale" as const };
        throw error;
      }
    }
  };
}
