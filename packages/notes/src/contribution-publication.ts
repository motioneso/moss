import type { AccessContext } from "@moss/db";
import { HttpError } from "@moss/module-sdk";
import { mutateVaultFiles, VaultMutationConflictError } from "@moss/vault";
import { noteDestinationId, type ContributionDestinations } from "./contribution-destinations.js";
import type { RecordingContributionRepository } from "./contribution-repository.js";
import {
  NoteContributionConflictError,
  NoteContributionUnavailableError,
  type ContributionOperationRow,
  type RecordingContributionAuthority,
  type RecordingContributionIndexPort
} from "./contribution-state.js";
import type { ManagedSourceLifecycle } from "./managed-source-lifecycle.js";
import { NoteBlockConflictError } from "./recording-note-blocks.js";
import { reconcileRecordingNoteOperation } from "./recording-note-operation.js";

type PublicationDependencies = {
  readonly access: AccessContext;
  readonly operation: ContributionOperationRow;
  readonly lifecycle: ManagedSourceLifecycle;
  readonly authority: RecordingContributionAuthority;
  readonly index: RecordingContributionIndexPort;
  readonly repository: RecordingContributionRepository;
  readonly destinations: ContributionDestinations;
};

function isConflict(error: unknown): boolean {
  return (
    error instanceof NoteContributionConflictError ||
    error instanceof NoteBlockConflictError ||
    error instanceof VaultMutationConflictError ||
    (error instanceof HttpError && error.statusCode === 409)
  );
}

/** Every leg commits separately. Exact pending bytes distinguish recovery from ordinary replay. */
export async function executeContributionOperation(deps: PublicationDependencies): Promise<void> {
  const { access, operation, lifecycle, repository, destinations, authority, index } = deps;
  if (operation.state === "applied") return;
  for (let offset = 0; offset < operation.legs.length; offset++) {
    const leg = operation.legs[offset]!;
    try {
      await lifecycle.withPublication(access, operation.lifecycle, async (db) => {
        const receipt = await repository.receipt(db, operation.receiptId);
        if (!receipt) throw new NoteContributionUnavailableError();
        const current = await authority.readCurrent(db, operation.source);
        if (
          operation.kind !== "undo" &&
          (current.sourceVersion !== operation.source.sourceVersion ||
            current.side !== receipt.side)
        )
          throw new NoteContributionConflictError();
        // Validate the proposed target before the first remove leg of a cross-root move.
        for (const next of operation.legs) {
          if (next.operation.after) await destinations.assertCurrentTarget(db, next.destination);
        }
        return destinations.withDestination(db, access, leg.destination, (ctx) =>
          mutateVaultFiles(db, ctx, [leg.destination.path], async ([file]) => {
            if (!file || noteDestinationId(file.canonicalPath) !== leg.destination.id)
              throw new NoteContributionConflictError();
            const active = await repository.lockOperation(db, operation.id);
            if (active.state === "applied" || active.legs[offset]?.done)
              return { changes: [], result: undefined };
            const step = active.legs[offset];
            if (!step || step.destination.id !== leg.destination.id)
              throw new NoteContributionConflictError();
            const binding = await repository.binding(db, step.destination.id);
            if (!binding || binding.side !== step.side) throw new NoteContributionConflictError();
            const reconciled = reconcileRecordingNoteOperation(file.content ?? "", step.operation);
            // The reservation accepted the reviewed file and binding. From here the exact
            // before/after block is durable authority; retain later unrelated note edits.
            // Vault still compares the file read in THIS attempt before publication.
            const legs = active.legs.map((entry, at) =>
              at === offset ? { ...entry, done: true } : entry
            );
            const complete = legs.every(({ done }) => done);
            await repository.saveOperation(db, {
              ...active,
              legs,
              state: complete ? "applied" : "pending"
            });
            const latest = await repository.receipt(db, active.receiptId);
            if (!latest || latest.operationId !== active.id)
              throw new NoteContributionConflictError();
            if (complete || latest.state === "conflict") {
              await repository.updateReceipt(db, latest.revision, {
                ...latest,
                revision: latest.revision + 1,
                state: complete ? active.resultState : "pending"
              });
            }
            if (complete)
              await index.enqueueScoped(db, [
                ...new Map(legs.map(({ destination }) => [destination.id, destination])).values()
              ]);
            return {
              changes:
                reconciled.status === "changed"
                  ? [{ path: leg.destination.path, content: reconciled.content }]
                  : [],
              result: undefined
            };
          })
        );
      });
    } catch (error) {
      if (!isConflict(error)) throw error;
      await lifecycle.withPublication(access, operation.lifecycle, (db) =>
        destinations.withSnapshots(
          db,
          access,
          operation.legs.map(({ destination }) => destination),
          async () => {
            const active = await repository.lockOperation(db, operation.id);
            if (active.state === "applied") return;
            await repository.saveOperation(db, { ...active, state: "conflict" });
            const receipt = await repository.receipt(db, active.receiptId);
            if (!receipt || receipt.operationId !== active.id)
              throw new NoteContributionConflictError();
            if (receipt.state !== "conflict")
              await repository.updateReceipt(db, receipt.revision, {
                ...receipt,
                state: "conflict",
                revision: receipt.revision + 1
              });
          }
        )
      );
      return;
    }
  }
}
