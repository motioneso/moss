import { createHash, randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { AccessContext, DataContextRunner, ManagedSourceKey } from "@moss/db";
import { assertUuid } from "@moss/db";
import type {
  ApplyRecordingMemoryInput,
  PrepareRecordingMemoryInput,
  RecordingMemoryProposal,
  RecordingMemoryReceipt,
  RecordingMemoryResult,
  RecordingMemorySource
} from "@moss/shared";
import type { EmbeddingProvider } from "./embedding-provider.js";
import type { RecordingFactAuthority } from "./recording-fact-authority.js";
import { RecordingFactMutations } from "./recording-fact-mutations.js";
import { RecordingFactLineage } from "./recording-fact-lineage.js";
import {
  recordingMemoryReceiptId,
  RecordingMemoryConflictError,
  RecordingMemoryUnavailableError,
  validateRecordingFactText,
  validateRecordingMemoryReceiptId,
  validateRecordingMemoryRevision
} from "./recording-fact-identity.js";
import {
  RecordingMemoryRepository,
  recordingReceipt,
  recordingSource,
  type RecordingMemoryProposalRow,
  type RecordingMemoryRow
} from "./recording-memory-repository.js";
import { RecordingMemoryTransitions } from "./recording-memory-transitions.js";

/** Reviews persist before provider work; only an admitted current proposal may publish. */
export class RecordingMemoryService {
  private readonly repository = new RecordingMemoryRepository();
  private readonly mutations: RecordingFactMutations;
  private readonly transitions: RecordingMemoryTransitions;

  constructor(
    private readonly runner: DataContextRunner,
    private readonly authority: RecordingFactAuthority,
    private readonly embeddingProvider: EmbeddingProvider
  ) {
    this.mutations = new RecordingFactMutations(authority);
    this.transitions = new RecordingMemoryTransitions(
      this.mutations,
      new RecordingFactLineage(this.mutations)
    );
  }

  async inspect(
    access: AccessContext,
    source: RecordingMemorySource
  ): Promise<RecordingMemoryReceipt | null> {
    const id = recordingMemoryReceiptId(access.actorUserId, source);
    return this.runner.withDataContext(access, async (db) => {
      const row = await this.repository.findReceipt(db, access.actorUserId, id);
      return row ? recordingReceipt(row) : null;
    });
  }

  async prepare(
    access: AccessContext,
    input: PrepareRecordingMemoryInput
  ): Promise<RecordingMemoryProposal> {
    if (
      typeof input.requestId !== "string" ||
      !input.requestId ||
      input.requestId.includes("\0") ||
      Buffer.byteLength(input.requestId, "utf8") > 256
    )
      throw new RecordingMemoryUnavailableError();
    if (input.kind === "apply" || input.kind === "change") validateRecordingFactText(input.text);
    if (input.kind !== "apply") {
      validateRecordingMemoryReceiptId(input.receiptId);
      validateRecordingMemoryRevision(input.expectedRevision);
      if (
        input.expectedFactRevision !== null &&
        !/^(0|[1-9][0-9]{0,18})$/.test(input.expectedFactRevision)
      ) {
        throw new RecordingMemoryConflictError();
      }
    }
    const digest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const owner = access.actorUserId.toLowerCase();
    const original =
      input.kind === "apply"
        ? null
        : await this.runner.withDataContext(access, (db) =>
            this.repository.receipt(db, owner, input.receiptId)
          );
    const source = input.kind === "apply" ? input.source : recordingSource(original!);
    const receiptId = recordingMemoryReceiptId(owner, source);
    const key: ManagedSourceKey = {
      ownerUserId: owner,
      sourceModuleId: source.sourceModuleId,
      sourceId: source.sourceId
    };
    const registration = await this.authority.registerSource(access, key);
    return this.authority.withReservation(access, registration, async (db) => {
      const prior = await this.repository.findRequest(db, owner, input.requestId);
      if (prior) {
        if (
          prior.input_digest !== digest ||
          prior.receipt_id !== receiptId ||
          prior.kind !== input.kind ||
          prior.proposed_text !==
            (input.kind === "apply" || input.kind === "change" ? input.text : null)
        ) {
          throw new RecordingMemoryConflictError();
        }
        return toProposal(prior, source);
      }
      const current = await this.authority.readCurrent(db, source);
      if (input.kind !== "undo" && current.sourceVersion !== source.sourceVersion)
        throw new RecordingMemoryConflictError();
      const generation = registration.sources[0]?.generation;
      if (generation === undefined) throw new RecordingMemoryUnavailableError();
      const receipt =
        input.kind === "apply"
          ? await this.repository.reserve(
              db,
              owner,
              receiptId,
              source,
              generation,
              current.side,
              randomUUID()
            )
          : await this.repository.receipt(db, owner, receiptId);
      if (
        input.kind !== "apply" &&
        (receipt.revision !== input.expectedRevision ||
          receipt.fact_revision !== input.expectedFactRevision)
      )
        throw new RecordingMemoryConflictError();
      if (receipt.state === "forgotten" || (receipt.fact_id && receipt.fact_state !== "current")) {
        throw new RecordingMemoryConflictError();
      }
      if (input.kind === "restore" && receipt.state !== "undone")
        throw new RecordingMemoryConflictError();
      if (input.kind === "change" && receipt.state !== "applied")
        throw new RecordingMemoryConflictError();
      if (input.kind === "reconcile_side" && receipt.state === "pending")
        throw new RecordingMemoryConflictError();
      if (input.kind !== "reconcile_side" && input.kind !== "undo" && receipt.side !== current.side)
        throw new RecordingMemoryConflictError();
      const snapshot = await this.mutations.capture(
        db,
        owner,
        receipt.fact_id ? [receipt.fact_id] : [],
        [key]
      );
      const row: RecordingMemoryProposalRow = {
        proposal_id: randomUUID(),
        request_id: input.requestId,
        input_digest: digest,
        receipt_id: receiptId,
        kind: input.kind,
        expected_receipt_revision: receipt.revision,
        expected_fact_id: receipt.fact_id,
        expected_fact_revision: receipt.fact_revision,
        actor_generation: registration.actorGeneration,
        source_generation: generation,
        side: input.kind === "undo" ? receipt.side : current.side,
        proposed_text: input.kind === "apply" || input.kind === "change" ? input.text : null,
        state: "prepared",
        publication_snapshot: snapshot,
        before: recordingReceipt(receipt)
      };
      await this.repository.saveProposal(db, owner, row);
      return toProposal(row, source);
    });
  }

  async apply(
    access: AccessContext,
    input: ApplyRecordingMemoryInput
  ): Promise<RecordingMemoryResult> {
    assertUuid(input.proposalId, "Recording memory proposal");
    const owner = access.actorUserId.toLowerCase();
    const prepared = await this.runner.withDataContext(access, async (db) => {
      const proposal = await this.repository.proposal(db, owner, input.proposalId);
      const receipt = await this.repository.receipt(db, owner, proposal.receipt_id);
      return { proposal, receipt };
    });
    if (prepared.proposal.state === "applied") {
      const receipt = recordingReceipt(prepared.receipt);
      return { status: receipt.state === "forgotten" ? "forgotten" : "unchanged", receipt };
    }
    const text = prepared.proposal.proposed_text ?? prepared.receipt.fact_text;
    // No database connection or lifecycle admission is held while embedding.
    const embedding =
      text && prepared.proposal.kind !== "undo"
        ? await this.embeddingProvider.embedDocument(text)
        : null;
    return this.runner.withDataContext(access, (db) =>
      this.mutations.withPrepared(
        db,
        prepared.proposal.publication_snapshot,
        prepared.receipt.fact_id ? [prepared.receipt.fact_id] : [],
        async () => {
          const proposal = await this.repository.proposal(db, owner, input.proposalId);
          const receipt = await this.repository.receipt(db, owner, proposal.receipt_id, true);
          if (proposal.state === "applied")
            return { status: "unchanged", receipt: recordingReceipt(receipt) };
          checkRevision(receipt, proposal);
          const current = await this.authority.readCurrent(db, recordingSource(receipt));
          if (
            proposal.kind !== "undo" &&
            (current.sourceVersion !== receipt.source_version || current.side !== proposal.side)
          ) {
            throw new RecordingMemoryConflictError();
          }
          const status = await this.transitions.apply(
            db,
            owner,
            receipt,
            proposal,
            embedding,
            this.embeddingProvider
          );
          await sql`UPDATE app.memory_recording_proposals SET state = 'applied'
          WHERE owner_user_id = ${owner}::uuid AND proposal_id = ${proposal.proposal_id}::uuid`.execute(
            db.db
          );
          return {
            status,
            receipt: recordingReceipt(await this.repository.receipt(db, owner, receipt.receipt_id))
          };
        },
        ["reconcile_side", "undo"].includes(prepared.proposal.kind)
          ? {
              ownerUserId: owner,
              sourceModuleId: prepared.receipt.source_module_id,
              sourceId: prepared.receipt.source_id
            }
          : null
      )
    );
  }
}

function checkRevision(receipt: RecordingMemoryRow, proposal: RecordingMemoryProposalRow): void {
  if (
    receipt.revision !== proposal.expected_receipt_revision ||
    receipt.fact_id !== proposal.expected_fact_id ||
    receipt.fact_revision !== proposal.expected_fact_revision ||
    receipt.state === "forgotten" ||
    (receipt.fact_id !== null && receipt.fact_state !== "current")
  )
    throw new RecordingMemoryConflictError();
}

function toProposal(
  row: RecordingMemoryProposalRow,
  source: RecordingMemorySource
): RecordingMemoryProposal {
  return {
    id: row.proposal_id,
    kind: row.kind,
    receiptId: row.receipt_id,
    source,
    expectedRevision: row.expected_receipt_revision,
    side: row.side,
    beforeSide: row.before.state === "pending" ? null : row.before.side,
    before: row.before.fact,
    after: row.kind === "undo" ? null : (row.proposed_text ?? row.before.fact?.text ?? null)
  };
}
