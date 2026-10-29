import { assertUuid, type AccessContext, type DataContextRunner } from "@moss/db";
import type { RecordingNoteSource } from "@moss/shared";
import type { VaultContextRunner } from "@moss/vault";
import type {
  ApplyRecordingNoteInput,
  PrepareRecordingNoteInput,
  RecordingNoteInventory,
  RecordingNoteProposal,
  RecordingNoteReceipt,
  RecordingNoteResult,
  ReviseRecordingNoteInput
} from "@moss/shared";
import { ContributionDestinations } from "./contribution-destinations.js";
import { prepareContributionProposal, proposalInputDigest } from "./contribution-proposal.js";
import { RecordingContributionRepository } from "./contribution-repository.js";
import {
  NoteContributionConflictError,
  NoteContributionUnavailableError,
  publicNoteReceipt,
  type ContributionOperationRow,
  type ContributionProposalRow,
  type ContributionReceiptRow,
  type RecordingContributionAuthority,
  type RecordingContributionIndexPort
} from "./contribution-state.js";
import type { ManagedSourceLifecycle } from "./managed-source-lifecycle.js";
import { inspectRecordingNoteBlock } from "./recording-note-blocks.js";
import { recordingNoteBlockId, validateRecordingNoteSource } from "./recording-note-identity.js";
import { executeContributionOperation } from "./contribution-publication.js";

function receiptId(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new NoteContributionUnavailableError();
}
function expectedRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2147483645)
    throw new NoteContributionConflictError();
}
function managedSource(owner: string, source: RecordingNoteSource) {
  return {
    ownerUserId: owner.toLowerCase(),
    sourceModuleId: source.sourceModuleId,
    sourceId: source.sourceId.toLowerCase()
  };
}

/** Notes owns receipt authority and exact file changes; model/provider work happens outside it. */
export class RecordingContributionService {
  private readonly repository = new RecordingContributionRepository();
  private readonly destinations: ContributionDestinations;

  constructor(
    private readonly dependencies: {
      readonly runner: DataContextRunner;
      readonly lifecycle: ManagedSourceLifecycle;
      readonly privateVault: VaultContextRunner;
      readonly authority: RecordingContributionAuthority;
      readonly index: RecordingContributionIndexPort;
    }
  ) {
    this.destinations = new ContributionDestinations(dependencies.privateVault, this.repository);
  }

  async inventory(access: AccessContext): Promise<RecordingNoteInventory> {
    return this.dependencies.runner.withDataContext(
      access,
      async (db) => (await this.destinations.inventory(db, access)).public
    );
  }

  async prepare(
    access: AccessContext,
    input: PrepareRecordingNoteInput
  ): Promise<RecordingNoteProposal> {
    assertUuid(input.requestId, "Contribution request");
    if (input.kind !== "apply") {
      receiptId(input.receiptId);
      expectedRevision(input.expectedRevision);
    } else {
      validateRecordingNoteSource(input.source);
    }
    const initial = await this.dependencies.runner.withDataContext(access, async (db) => ({
      proposal: await this.repository.proposal(db, input.requestId),
      receipt: await this.repository.receipt(
        db,
        input.kind === "apply"
          ? recordingNoteBlockId(access.actorUserId, input.source)
          : input.receiptId
      )
    }));
    if (initial.proposal) {
      if (initial.proposal.digest !== proposalInputDigest(input))
        throw new NoteContributionConflictError();
      return initial.proposal.review;
    }
    if (input.kind !== "apply" && !initial.receipt) throw new NoteContributionUnavailableError();
    const source: RecordingNoteSource =
      input.kind === "apply"
        ? { ...input.source, sourceId: input.source.sourceId.toLowerCase() }
        : initial.receipt!.source;
    const snapshot = await this.dependencies.lifecycle.registerSource(
      access,
      managedSource(access.actorUserId, source)
    );
    return this.dependencies.lifecycle.withPublication(access, snapshot, async (db) => {
      const current = await this.dependencies.authority.readCurrent(db, source);
      if (input.kind !== "undo" && current.sourceVersion !== source.sourceVersion)
        throw new NoteContributionConflictError();
      const side = input.kind === "undo" ? initial.receipt!.side : current.side;
      const target =
        input.kind === "apply" || input.kind === "change"
          ? await this.destinations.choose(db, access, source, side, input.destination)
          : initial.receipt!.destination;
      return this.destinations.withSnapshots(
        db,
        access,
        [...(initial.receipt ? [initial.receipt.destination] : []), target],
        async (files) => {
          const existing = await this.repository.receipt(
            db,
            recordingNoteBlockId(access.actorUserId, source)
          );
          const proposal = await prepareContributionProposal({
            db,
            owner: access.actorUserId,
            lifecycle: snapshot,
            request: input,
            source,
            side,
            existing,
            target,
            snapshots: files,
            repository: this.repository
          });
          await this.repository.saveProposal(db, proposal);
          return (await this.repository.proposal(db, input.requestId))!.review;
        }
      );
    });
  }

  async apply(access: AccessContext, input: ApplyRecordingNoteInput): Promise<RecordingNoteResult> {
    return this.applyPrepared(access, input, "apply");
  }
  async change(
    access: AccessContext,
    input: ApplyRecordingNoteInput
  ): Promise<RecordingNoteResult> {
    return this.applyPrepared(access, input, "change");
  }
  async undo(access: AccessContext, input: ReviseRecordingNoteInput): Promise<RecordingNoteResult> {
    const prepared = await this.prepare(access, { ...input, kind: "undo" });
    return this.applyPrepared(access, { proposalId: prepared.id, acceptBinding: false }, "undo");
  }
  async restore(
    access: AccessContext,
    input: ReviseRecordingNoteInput
  ): Promise<RecordingNoteResult> {
    const prepared = await this.prepare(access, { ...input, kind: "restore" });
    return this.applyPrepared(access, { proposalId: prepared.id, acceptBinding: false }, "restore");
  }

  async inspect(
    access: AccessContext,
    source: RecordingNoteSource
  ): Promise<RecordingNoteReceipt | null> {
    validateRecordingNoteSource(source);
    return this.dependencies.runner.withDataContext(access, async (db) => {
      const row = await this.repository.receipt(
        db,
        recordingNoteBlockId(access.actorUserId, source)
      );
      if (!row) return null;
      return this.destinations.withSnapshots(db, access, [row.destination], async ([snapshot]) => {
        if (!snapshot) throw new NoteContributionUnavailableError();
        const latest = await this.repository.receipt(db, row.id);
        if (!latest) throw new NoteContributionUnavailableError();
        if (latest.destination.id !== row.destination.id) throw new NoteContributionConflictError();
        const observed = inspectRecordingNoteBlock(snapshot.file.content ?? "", latest.block);
        const conflict =
          (latest.state === "applied" && observed !== "unchanged") ||
          (latest.state === "undone" && observed !== "missing");
        return publicNoteReceipt(conflict ? { ...latest, state: "conflict" } : latest);
      });
    });
  }

  private async applyPrepared(
    access: AccessContext,
    input: ApplyRecordingNoteInput,
    kind: ContributionProposalRow["review"]["kind"]
  ): Promise<RecordingNoteResult> {
    assertUuid(input.proposalId, "Contribution proposal");
    const initial = await this.dependencies.runner.withDataContext(access, async (db) => ({
      proposal: await this.repository.proposal(db, input.proposalId),
      operation: await this.repository.operation(db, input.proposalId)
    }));
    const proposal = initial.proposal;
    if (!proposal || proposal.review.kind !== kind) throw new NoteContributionUnavailableError();
    if (proposal.review.requiresBindingConsent && input.acceptBinding !== true)
      throw new NoteContributionConflictError();
    let operation = initial.operation;
    if (!operation) operation = await this.reserve(access, proposal);
    if (operation) {
      await executeContributionOperation({
        access,
        operation,
        ...this.dependencies,
        repository: this.repository,
        destinations: this.destinations
      });
    }
    const observed = await this.inspect(access, proposal.review.source);
    if (!observed) throw new NoteContributionUnavailableError();
    return {
      status:
        observed.state === "conflict"
          ? "conflict"
          : operation
            ? observed.state === "undone"
              ? "undone"
              : "applied"
            : "unchanged",
      receipt: observed
    };
  }

  private async reserve(
    access: AccessContext,
    proposal: ContributionProposalRow
  ): Promise<ContributionOperationRow | null> {
    const source = proposal.review.source;
    const snapshot = proposal.lifecycle;
    return this.dependencies.lifecycle.withReservation(access, snapshot, async (db) => {
      const replay = await this.repository.operation(db, proposal.id);
      if (replay) return replay;
      if (await this.repository.pendingSource(db, source))
        throw new NoteContributionConflictError();
      const current = await this.dependencies.authority.readCurrent(db, source);
      if (
        proposal.review.kind !== "undo" &&
        (current.sourceVersion !== source.sourceVersion || current.side !== proposal.review.side)
      )
        throw new NoteContributionConflictError();
      if (proposal.review.kind !== "undo")
        await this.destinations.assertCurrentTarget(db, proposal.destination);
      return this.destinations.withSnapshots(
        db,
        access,
        proposal.legs.length
          ? proposal.legs.map(({ destination }) => destination)
          : [proposal.destination],
        async (files) => {
          const previous = await this.repository.receipt(db, proposal.review.receiptId);
          // Ordinary apply replay cannot recreate an undone or externally removed source block.
          if (proposal.review.kind === "apply" && previous) {
            if (
              previous.text !== proposal.text ||
              previous.destination.id !== proposal.destination.id ||
              previous.side !== proposal.review.side
            )
              throw new NoteContributionConflictError();
            return null;
          }
          if ((previous?.revision ?? 0) !== proposal.review.expectedRevision)
            throw new NoteContributionConflictError();
          if (proposal.review.kind === "undo" && previous?.state === "undone") return null;
          if (
            (proposal.review.kind === "apply" ||
              (proposal.review.kind === "restore" && previous?.state === "undone")) &&
            (await this.repository.activeItemCount(db, source)) >= 20
          )
            throw new NoteContributionConflictError();
          for (const leg of proposal.legs) {
            const file = files.find(
              ({ destination }) => destination.id === leg.destination.id
            )?.file;
            if (!file || file.revision !== leg.expectedRevision)
              throw new NoteContributionConflictError();
            if (!(await this.repository.available(db, leg.destination.id)))
              throw new NoteContributionUnavailableError();
            const binding = await this.repository.binding(db, leg.destination.id);
            if ((binding?.revision ?? null) !== leg.bindingRevision)
              throw new NoteContributionConflictError();
            await this.repository.claim(db, leg.destination.id, leg.side);
            await this.repository.invalidateBinding(db, leg.destination.id);
          }
          if (!proposal.legs.length) throw new NoteContributionConflictError();
          const row: ContributionReceiptRow = {
            id: proposal.review.receiptId,
            sourceGeneration: snapshot.sources[0]!.generation,
            source,
            revision: (previous?.revision ?? 0) + 1,
            side: proposal.review.side,
            state: "pending",
            destination: proposal.destination,
            text: proposal.text,
            block: proposal.block,
            operationId: proposal.id
          };
          if (previous) await this.repository.updateReceipt(db, previous.revision, row);
          else await this.repository.insertReceipt(db, row);
          const operation: ContributionOperationRow = {
            id: proposal.id,
            kind: proposal.review.kind,
            receiptId: row.id,
            source,
            lifecycle: snapshot,
            state: "pending",
            resultState: proposal.review.kind === "undo" ? "undone" : "applied",
            legs: proposal.legs
          };
          await this.repository.insertOperation(db, operation);
          await this.dependencies.index.invalidateScoped(db, [
            ...new Set(proposal.legs.map(({ destination }) => destination.id))
          ]);
          return operation;
        }
      );
    });
  }
}
