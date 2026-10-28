import { sql } from "kysely";
import type { AccessContext, DataContextDb } from "@moss/db";
import { HttpError } from "@moss/module-sdk";
import {
  mutateVaultFiles,
  VaultContextError,
  VaultMutationConflictError,
  type VaultContextRunner
} from "@moss/vault";
import { ContributionDestinations, noteDestinationId } from "./contribution-destinations.js";
import { RecordingContributionRepository } from "./contribution-repository.js";
import {
  NoteContributionConflictError,
  NoteContributionUnavailableError,
  type RecordingContributionIndexPort,
  type StoredNoteDestination
} from "./contribution-state.js";
import {
  assertManagedCleanupAdmission,
  type ManagedCleanupAdmission,
  type ManagedDeletionOperation,
  type ManagedSourceLifecycle
} from "./managed-source-lifecycle.js";
import { NoteBlockConflictError, type RecordingNoteBlock } from "./recording-note-blocks.js";
import { removeRecordingContributionBlocks } from "./recording-note-cleanup-blocks.js";

export type RecordingCleanupStatus = "complete" | "pending" | "conflict";

function filesystemUnavailable(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    ["EACCES", "EPERM", "EROFS", "ENOSPC", "EIO", "EMFILE", "ENFILE", "ENOTDIR", "ENOENT"].includes(
      String(error.code)
    )
  );
}

/** Only persisted deletion admission permits this removal-only path; normal undo stays fenced. */
export class RecordingContributionCleanupService {
  private readonly repository = new RecordingContributionRepository();
  private readonly destinations: ContributionDestinations;

  constructor(
    private readonly dependencies: {
      readonly lifecycle: ManagedSourceLifecycle;
      readonly privateVault: VaultContextRunner;
      readonly index: RecordingContributionIndexPort;
    }
  ) {
    this.destinations = new ContributionDestinations(dependencies.privateVault, this.repository);
  }

  async cleanup(
    access: AccessContext,
    operation: ManagedDeletionOperation
  ): Promise<RecordingCleanupStatus> {
    const ids = await this.dependencies.lifecycle.withCleanup(
      access,
      operation,
      async (db, admission) => {
        assertManagedCleanupAdmission(db, admission);
        return (
          await sql<{ id: string }>`select receipt_id as id from app.notes_recording_contributions
        where cleanup_operation_id is distinct from ${operation.operationId}::uuid and ${this.sourcePredicate(operation)} order by receipt_id limit 20`.execute(
            db.db
          )
        ).rows;
      }
    );
    for (const { id } of ids) {
      try {
        await this.remove(access, operation, id);
      } catch (error) {
        if (
          error instanceof NoteContributionUnavailableError ||
          error instanceof VaultContextError ||
          filesystemUnavailable(error) ||
          (error instanceof HttpError && error.statusCode === 400)
        )
          return "pending";
        if (
          !(
            error instanceof NoteContributionConflictError ||
            error instanceof NoteBlockConflictError ||
            error instanceof VaultMutationConflictError ||
            (error instanceof HttpError && error.statusCode === 409)
          )
        )
          throw error;
        await this.dependencies.lifecycle.withCleanup(access, operation, async (db, admission) => {
          assertManagedCleanupAdmission(db, admission);
          const receipt = await this.repository.receipt(db, id);
          if (receipt && receipt.state !== "conflict") {
            await this.repository.updateReceipt(db, receipt.revision, {
              ...receipt,
              state: "conflict",
              revision: receipt.revision + 1
            });
          }
        });
        return "conflict";
      }
    }
    return this.dependencies.lifecycle.withCleanup(access, operation, async (db, admission) => {
      assertManagedCleanupAdmission(db, admission);
      return (await this.remainingScoped(db, operation)) ? "pending" : "complete";
    });
  }

  async assertCompleteScoped(
    db: DataContextDb,
    operation: ManagedDeletionOperation
  ): Promise<void> {
    if (await this.remainingScoped(db, operation)) throw new NoteContributionConflictError();
  }

  /** Retire source receipts only in the transaction which removes their sealed source. */
  async retireSourceScoped(db: DataContextDb, operation: ManagedDeletionOperation): Promise<void> {
    if (!operation.source) throw new NoteContributionUnavailableError();
    await this.dependencies.lifecycle.assertSealedScoped(db, operation);
    await this.assertCompleteScoped(db, operation);
    await sql`delete from app.notes_contribution_proposals where ${this.sourcePredicate(operation)}`.execute(
      db.db
    );
    await sql`delete from app.notes_recording_contributions where ${this.sourcePredicate(operation)}`.execute(
      db.db
    );
  }

  private sourcePredicate(operation: ManagedDeletionOperation) {
    return operation.source
      ? sql`owner_user_id = ${operation.ownerUserId}::uuid and source_module_id = ${operation.source.sourceModuleId}
          and source_id = ${operation.source.sourceId}::uuid`
      : sql`owner_user_id = ${operation.ownerUserId}::uuid`;
  }

  private async remainingScoped(
    db: DataContextDb,
    operation: ManagedDeletionOperation
  ): Promise<boolean> {
    return (
      await sql<{ pending: boolean }>`select exists(select 1 from app.notes_recording_contributions
      where cleanup_operation_id is distinct from ${operation.operationId}::uuid and ${this.sourcePredicate(operation)}) as pending`.execute(
        db.db
      )
    ).rows[0]!.pending;
  }

  private async targetsScoped(db: DataContextDb, admission: ManagedCleanupAdmission, id: string) {
    assertManagedCleanupAdmission(db, admission);
    const receipt = await this.repository.receipt(db, id);
    if (!receipt) return [];
    const source = admission.operation.source;
    if (
      source &&
      (receipt.source.sourceModuleId !== source.sourceModuleId ||
        receipt.source.sourceId !== source.sourceId)
    )
      throw new NoteContributionUnavailableError();
    const operation = receipt.operationId
      ? await this.repository.operation(db, receipt.operationId)
      : null;
    const targets = new Map<
      string,
      { destination: StoredNoteDestination; variants: RecordingNoteBlock[] }
    >();
    const add = (destination: StoredNoteDestination, block: RecordingNoteBlock | null) => {
      if (!block) return;
      const target = targets.get(destination.id) ?? { destination, variants: [] };
      target.variants.push(block);
      targets.set(destination.id, target);
    };
    add(receipt.destination, receipt.block);
    // A reserved move can have removed the old block or published the new one before a crash.
    for (const leg of operation && (operation.state === "pending" || operation.state === "conflict")
      ? operation.legs
      : []) {
      add(leg.destination, leg.operation.before);
      add(leg.destination, leg.operation.after);
    }
    return [...targets.values()];
  }

  private async remove(
    access: AccessContext,
    operation: ManagedDeletionOperation,
    id: string
  ): Promise<void> {
    const targets = await this.dependencies.lifecycle.withCleanup(
      access,
      operation,
      (db, admission) => this.targetsScoped(db, admission, id)
    );
    // Removal legs deliberately commit separately. A later conflict never rolls an earlier file back.
    for (const { destination, variants } of targets) {
      await this.dependencies.lifecycle.withCleanup(access, operation, async (db, admission) => {
        assertManagedCleanupAdmission(db, admission);
        await this.destinations.withDestination(db, access, destination, (ctx) =>
          mutateVaultFiles(db, ctx, [destination.path], async ([file]) => {
            if (!file || noteDestinationId(file.canonicalPath) !== destination.id)
              throw new NoteContributionConflictError();
            const content = removeRecordingContributionBlocks(file.content ?? "", variants);
            await this.repository.invalidateBinding(db, destination.id);
            await this.dependencies.index.invalidateScoped(db, [destination.id]);
            return {
              changes:
                content !== (file.content ?? "") ? [{ path: destination.path, content }] : [],
              result: undefined
            };
          })
        );
      });
    }
    await this.dependencies.lifecycle.withCleanup(access, operation, async (db, admission) => {
      assertManagedCleanupAdmission(db, admission);
      const receipt = await this.repository.receipt(db, id);
      if (!receipt) return;
      await this.repository.updateReceipt(db, receipt.revision, {
        ...receipt,
        state: "undone",
        revision: receipt.revision + 1
      });
      await sql`update app.notes_recording_contributions set cleanup_operation_id = ${operation.operationId}::uuid
        where receipt_id = ${receipt.id}`.execute(db.db);
      const active = receipt.operationId
        ? await this.repository.operation(db, receipt.operationId)
        : null;
      if (active)
        await this.repository.saveOperation(db, {
          ...active,
          state: "cancelled"
        });
      if (operation.source)
        await this.dependencies.index.enqueueScoped(
          db,
          targets.map((t) => t.destination)
        );
    });
  }
}
