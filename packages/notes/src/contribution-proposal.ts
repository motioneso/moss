import { createHash } from "node:crypto";
import type { DataContextDb } from "@moss/db";
import type { RecordingNoteSource } from "@moss/shared";
import type { ManagedSourceSnapshot } from "./managed-source-lifecycle.js";
import type { PrepareRecordingNoteInput, RecordingNoteProposal } from "@moss/shared";
import type { ContributionDestinationSnapshot } from "./contribution-destinations.js";
import type { RecordingContributionRepository } from "./contribution-repository.js";
import {
  NoteContributionConflictError,
  NoteContributionUnavailableError,
  publicNoteDestination,
  type ContributionLeg,
  type ContributionProposalRow,
  type ContributionReceiptRow,
  type StoredNoteDestination
} from "./contribution-state.js";
import { inspectRecordingNoteBlock, renderRecordingNoteBlock } from "./recording-note-blocks.js";
import { recordingNoteBlockId } from "./recording-note-identity.js";

export function proposalInputDigest(input: PrepareRecordingNoteInput): string {
  const common =
    input.kind === "apply"
      ? [
          input.source.sourceModuleId,
          input.source.sourceId.toLowerCase(),
          input.source.sourceVersion,
          input.source.itemKey
        ]
      : [input.receiptId, input.expectedRevision];
  const value =
    input.kind === "apply" || input.kind === "change"
      ? [
          ...common,
          input.text,
          input.destination.kind,
          input.destination.kind === "candidate"
            ? [input.destination.candidateId, input.destination.candidateRevision]
            : null
        ]
      : common;
  return createHash("sha256")
    .update(JSON.stringify([input.kind, ...value]))
    .digest("hex");
}

export async function prepareContributionProposal(input: {
  readonly db: DataContextDb;
  readonly owner: string;
  readonly lifecycle: ManagedSourceSnapshot;
  readonly request: PrepareRecordingNoteInput;
  readonly source: RecordingNoteSource;
  readonly side: "personal" | "work";
  readonly existing: ContributionReceiptRow | null;
  readonly target: StoredNoteDestination;
  readonly snapshots: readonly ContributionDestinationSnapshot[];
  readonly repository: RecordingContributionRepository;
}): Promise<ContributionProposalRow> {
  const { db, owner, request, source, side, existing, target, snapshots, repository } = input;
  const id = recordingNoteBlockId(owner, source);
  if (existing && existing.id !== id) throw new NoteContributionConflictError();
  const existingRevision = existing?.revision ?? 0;
  if (request.kind !== "apply" && (!existing || existingRevision !== request.expectedRevision))
    throw new NoteContributionConflictError();
  if (existing?.state === "pending" || existing?.state === "conflict")
    throw new NoteContributionConflictError();
  const fileFor = (destinationId: string) => {
    const snapshot = snapshots.find(({ destination }) => destination.id === destinationId);
    if (!snapshot) throw new NoteContributionUnavailableError();
    return snapshot.file;
  };
  if (existing) {
    const observed = inspectRecordingNoteBlock(
      fileFor(existing.destination.id).content ?? "",
      existing.block
    );
    if (
      (existing.state === "applied" && observed !== "unchanged") ||
      (existing.state === "undone" && observed !== "missing")
    )
      throw new NoteContributionConflictError();
  }
  if (request.kind === "change" && existing?.state !== "applied")
    throw new NoteContributionConflictError();
  if (request.kind === "restore" && (existing?.state !== "undone" || existing.side !== side))
    throw new NoteContributionConflictError();
  const text =
    request.kind === "apply" || request.kind === "change" ? request.text : existing!.text;
  const block = renderRecordingNoteBlock(id, text);
  const before = existing?.state === "applied" ? existing.block : null;
  const after =
    request.kind === "undo" || (request.kind === "apply" && existing?.state === "undone")
      ? null
      : block;
  if (
    request.kind === "apply" &&
    existing &&
    (existing.text !== text || existing.destination.id !== target.id || existing.side !== side)
  )
    throw new NoteContributionConflictError();

  const legs: ContributionLeg[] = [];
  const sameDestination = !existing || existing.destination.id === target.id;
  const addLeg = async (
    destination: StoredNoteDestination,
    beforeBlock: typeof before,
    afterBlock: typeof after,
    legSide: typeof side
  ) => {
    if (!beforeBlock && !afterBlock) return;
    if (!(await repository.available(db, destination.id)))
      throw new NoteContributionUnavailableError();
    const binding = await repository.binding(db, destination.id);
    if (binding && binding.side !== legSide) throw new NoteContributionConflictError();
    legs.push({
      destination,
      expectedRevision: fileFor(destination.id).revision,
      bindingRevision: binding?.revision ?? null,
      side: legSide,
      operation: { before: beforeBlock, after: afterBlock },
      done: false
    });
  };
  if (sameDestination) {
    await addLeg(target, before, after, side);
  } else {
    await addLeg(existing!.destination, before, null, existing!.side);
    await addLeg(target, null, after, side);
  }
  const targetFile = fileFor(target.id);
  const targetBinding = await repository.binding(db, target.id);
  const requiresBindingConsent =
    after !== null && !targetBinding && Boolean(targetFile.content?.length);
  const excerpt = new TextDecoder("utf-8", { fatal: true }).decode(
    Buffer.from(targetFile.content ?? "", "utf8").subarray(0, 2048),
    { stream: true }
  );
  const review: RecordingNoteProposal = {
    id: request.requestId,
    kind: request.kind,
    source,
    receiptId: id,
    expectedRevision: existingRevision,
    side,
    destination: publicNoteDestination(target),
    before: existing?.state === "applied" ? existing.text : null,
    after: after ? text : null,
    requiresBindingConsent,
    bindingReview: requiresBindingConsent
      ? {
          before: "unlabelled",
          after: side,
          noteRevision: targetFile.revision!,
          excerpt,
          truncated: Buffer.byteLength(targetFile.content ?? "", "utf8") > 2048
        }
      : null
  };
  return {
    id: request.requestId,
    lifecycle: input.lifecycle,
    digest: proposalInputDigest(request),
    review,
    destination: target,
    text,
    block,
    legs
  };
}
