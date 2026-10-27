import type { DataContextRunner } from "@moss/db";
import { MeetingRecordsRepository } from "@moss/meetings";
import type { VaultIndexPublicationPort } from "@moss/memory";
import {
  ManagedNoteSnapshotService,
  ManagedSourceLifecycle,
  ManagedSourceUnavailableError
} from "@moss/notes";

/** Composition alone resolves Meetings source authority; Memory never reads Notes tables. */
export function createManagedNoteSnapshotPort(
  dataContext: DataContextRunner
): VaultIndexPublicationPort {
  const records = new MeetingRecordsRepository();
  const lifecycle = new ManagedSourceLifecycle(dataContext, {
    async assertExists(db, source) {
      if (source.sourceModuleId !== "meetings" || !(await records.get(db, source.sourceId)))
        throw new ManagedSourceUnavailableError();
    }
  });
  return new ManagedNoteSnapshotService(lifecycle);
}
