import type { AccessContext, DataContextDb, DataContextRunner } from "@moss/db";
import type { ActiveModulesResolver } from "@moss/ai";
import { MeetingRecordsRepository, MeetingTranscriptRepository } from "@moss/meetings";
import { MeetingContextUnavailableError, type MeetingChatData } from "@moss/chat";

/** Composition only: Chat sees a public port, never Meetings tables or internals. */
export function createMeetingChatData(deps: {
  readonly dataContext: Pick<DataContextRunner, "withDataContext">;
  readonly resolveActiveModules: ActiveModulesResolver;
}): MeetingChatData {
  const records = new MeetingRecordsRepository();
  const transcripts = new MeetingTranscriptRepository();
  const enabled = async (access: AccessContext) =>
    (await deps.resolveActiveModules(access.actorUserId)).some(
      (module) => module.id === "meetings"
    );
  return {
    source: {
      async isAvailable(access, meetingId) {
        return (
          (await enabled(access)) &&
          deps.dataContext.withDataContext(access, async (db) =>
            Boolean(await records.get(db, meetingId))
          )
        );
      },
      async snapshot(access, meetingId, query) {
        if (!(await enabled(access))) return null;
        return deps.dataContext.withDataContext(access, (db) =>
          transcripts.retrieve(db, meetingId, { query, maxSegments: 8, maxCharacters: 12_000 })
        );
      },
      async evidence(access, evidence) {
        if (!(await enabled(access))) return null;
        return deps.dataContext.withDataContext(access, (db) => transcripts.evidence(db, evidence));
      }
    },
    async withMeeting<T>(
      access: AccessContext,
      meetingId: string,
      work: (db: DataContextDb) => Promise<T>
    ): Promise<T> {
      if (!(await enabled(access))) throw new MeetingContextUnavailableError();
      return deps.dataContext.withDataContext(access, async (db) => {
        // Public transcript read holds the meeting FOR SHARE through this transaction.
        if (!(await transcripts.snapshot(db, meetingId, { maxSegments: 1, maxCharacters: 1 })))
          throw new MeetingContextUnavailableError();
        return work(db);
      });
    }
  };
}
