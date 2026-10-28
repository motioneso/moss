import type { DataContextRunner } from "@moss/db";
import { MeetingRecordsRepository, RecordingMetadataRepository } from "@moss/meetings";
import type { RecordingFactAuthority } from "@moss/memory";
import { RecordingFactConflictError } from "@moss/memory";
import {
  ManagedSourceLifecycle,
  ManagedSourceUnavailableError,
  ManagedSourceFencedError
} from "@moss/notes";

/** The host resolves owning source authority; Memory never reads Notes or Meetings tables. */
export function createRecordingFactAuthority(runner: DataContextRunner): RecordingFactAuthority {
  const records = new MeetingRecordsRepository();
  const metadata = new RecordingMetadataRepository();
  const lifecycle = new ManagedSourceLifecycle(runner, {
    async assertExists(db, source) {
      if (source.sourceModuleId !== "meetings" || !(await records.get(db, source.sourceId))) {
        throw new ManagedSourceUnavailableError();
      }
    }
  });
  return {
    registerSource: (access, source) =>
      memoryAuthority(() => lifecycle.registerSource(access, source)),
    captureSourcesScoped: (db, sources) =>
      memoryAuthority(() => lifecycle.captureSourcesScoped(db, sources)),
    withReservation: (access, expected, work) =>
      memoryAuthority(() => lifecycle.withReservation(access, expected, work)),
    withPublicationScoped: (db, expected, work) =>
      memoryAuthority(() => lifecycle.withPublicationScoped(db, expected, work)),
    async readCurrent(db, source) {
      if (!(await records.get(db, source.sourceId))) throw new RecordingFactConflictError();
      const current = await metadata.get(db, source.sourceId);
      if (!current?.side || current.outputVersion === null) throw new RecordingFactConflictError();
      return { sourceVersion: current.outputVersion, side: current.side };
    }
  };
}

async function memoryAuthority<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (
      error instanceof ManagedSourceUnavailableError ||
      error instanceof ManagedSourceFencedError
    ) {
      throw new RecordingFactConflictError();
    }
    throw error;
  }
}
