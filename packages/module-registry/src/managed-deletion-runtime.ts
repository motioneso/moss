import type { AccessContext, DataContextRunner } from "@moss/db";
import { readScopedActorUserId } from "@moss/db";
import { scopedJobDatabase, sendJob, type PgBoss } from "@moss/jobs";
import { MeetingRecordsRepository, type MeetingDeletionPort } from "@moss/meetings";
import {
  MemoryRepository,
  RecordingMemoryCleanupService,
  VAULT_INGEST_NUDGE_QUEUE
} from "@moss/memory";
import {
  ManagedSourceLifecycle,
  ManagedSourceUnavailableError,
  ManagedSourceFencedError,
  NoteContributionUnavailableError,
  RecordingContributionCleanupService,
  NOTES_SYNC_QUEUE,
  type ManagedDeletionOperation,
  type RecordingContributionIndexPort
} from "@moss/notes";
import type { VaultContextRunner } from "@moss/vault";
import type { PrepareManagedDeletion } from "../../../scripts/delete-user-data.js";

type Prepared =
  | { readonly status: "complete"; readonly operation: ManagedDeletionOperation }
  | { readonly status: "pending" | "conflict" };

function isRetryable(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    ["55P03", "40P01", "40001"].includes(String(error.code))
  );
}

interface Dependencies {
  readonly dataContext: DataContextRunner;
  readonly privateVault: VaultContextRunner;
}

function services(deps: Dependencies, index: RecordingContributionIndexPort) {
  const records = new MeetingRecordsRepository();
  const lifecycle = new ManagedSourceLifecycle(deps.dataContext, {
    async assertExists(db, source) {
      if (source.sourceModuleId !== "meetings" || !(await records.get(db, source.sourceId)))
        throw new ManagedSourceUnavailableError();
    }
  });
  const notes = new RecordingContributionCleanupService({
    lifecycle,
    privateVault: deps.privateVault,
    index
  });
  const memory = new RecordingMemoryCleanupService({
    withCleanup: (access, operation, work) => lifecycle.withCleanup(access, operation, work),
    assertSealedScoped: (db, operation) => lifecycle.assertSealedScoped(db, operation)
  });
  async function prepare(
    access: AccessContext,
    operation: ManagedDeletionOperation
  ): Promise<Prepared> {
    if (operation.state === "sealed") return { status: "complete" as const, operation };
    const noteState = await notes.cleanup(access, operation);
    if (noteState !== "complete") return { status: noteState };
    const memoryState = await memory.cleanup(access, operation);
    if (memoryState !== "complete") return { status: memoryState };
    const sealed = await lifecycle.sealDeletion(access, operation, async (db) => {
      await notes.assertCompleteScoped(db, operation);
      await memory.assertCompleteScoped(db, operation);
    });
    return { status: "complete" as const, operation: sealed };
  }
  return { lifecycle, notes, memory, prepare, records };
}

function invalidationPort(): RecordingContributionIndexPort {
  const repository = new MemoryRepository();
  return {
    async invalidateScoped(db, ids) {
      const owner = await readScopedActorUserId(db);
      if (!owner) throw new ManagedSourceUnavailableError();
      await repository.invalidateManagedDestinations(db, owner, ids);
    },
    // Account cleanup is followed by owner cascade, never a new indexing publication.
    async enqueueScoped() {
      throw new Error("Account cleanup cannot enqueue derivatives");
    }
  };
}

/** Self, administrator and CLI call the same bounded preparation before the account cascade. */
export function createManagedDeletionPreparation(deps: Dependencies): PrepareManagedDeletion {
  const runtime = services(deps, invalidationPort());
  return async ({ userId, requestId }) => {
    const access = { actorUserId: userId, requestId };
    try {
      const result = await runtime.prepare(access, await runtime.lifecycle.fenceActor(access));
      if (result.status !== "complete") return { status: result.status };
      return {
        status: "complete",
        operationId: result.operation.operationId,
        generation: result.operation.generation
      };
    } catch (error) {
      if (
        error instanceof ManagedSourceFencedError ||
        error instanceof NoteContributionUnavailableError ||
        isRetryable(error)
      )
        return { status: "pending" };
      throw error;
    }
  };
}

export function createMeetingDeletionPort(
  deps: Dependencies & { readonly boss: PgBoss }
): MeetingDeletionPort {
  const invalidation = invalidationPort();
  const runtime = services(deps, {
    invalidateScoped: invalidation.invalidateScoped,
    async enqueueScoped(db, destinations) {
      const actorUserId = await readScopedActorUserId(db);
      if (!actorUserId) throw new ManagedSourceUnavailableError();
      for (const destination of destinations) {
        await sendJob(
          deps.boss,
          destination.kind === "private" ? VAULT_INGEST_NUDGE_QUEUE : NOTES_SYNC_QUEUE,
          destination.kind === "private"
            ? { actorUserId, sourcePath: destination.path, op: "upsert" }
            : { actorUserId },
          { db: scopedJobDatabase(db) }
        );
      }
    }
  });
  return {
    async withCleanSource(access, meetingId, remove) {
      try {
        const source = {
          ownerUserId: access.actorUserId,
          sourceModuleId: "meetings",
          sourceId: meetingId
        };
        const result = await runtime.prepare(
          access,
          await runtime.lifecycle.fenceSource(access, source)
        );
        if (result.status !== "complete") return result.status;
        const operation = result.operation;
        await runtime.lifecycle.withSealedDeletion(access, operation, async (db) => {
          await runtime.notes.retireSourceScoped(db, operation);
          await runtime.memory.retireSourceScoped(db, operation);
          await remove(db);
        });
        return "complete";
      } catch (error) {
        if (
          error instanceof ManagedSourceFencedError ||
          error instanceof NoteContributionUnavailableError ||
          isRetryable(error)
        )
          return "pending";
        if (error instanceof ManagedSourceUnavailableError) {
          const exists = await deps.dataContext.withDataContext(access, (db) =>
            runtime.records.get(db, meetingId)
          );
          if (!exists) return "complete";
        }
        throw error;
      }
    }
  };
}
