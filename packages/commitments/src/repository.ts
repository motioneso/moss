import { assertDataContextDb } from "@moss/db";
import { sql } from "kysely";
import type { ProposedCommitmentAction } from "@moss/module-sdk";
import type {
  CommitmentCandidate,
  CommitmentCandidateSource,
  CommitmentCandidateStatus,
  CommitmentExtractionState,
  CommitmentSourceKind,
  CommitmentSuggestedHandling,
  EmailThreadJudgementOutcomeKind,
  UpsertCandidateInput,
  UpsertEmailCandidateInput,
  AddEvidenceInput
} from "./types.js";

const MAX_EVIDENCE_ROWS = 5;

export class CommitmentsRepository {
  async upsertCandidate(
    scopedDb: unknown,
    input: UpsertCandidateInput
  ): Promise<CommitmentCandidate> {
    assertDataContextDb(scopedDb);
    const now = new Date();

    const row = await scopedDb.db
      .insertInto("app.commitment_candidates")
      .values({
        owner_user_id: input.ownerUserId,
        candidate_signature: input.candidateSignature,
        kind: input.kind,
        title: input.title,
        due_local_date: input.dueLocalDate ?? null,
        counterparty_label: input.counterpartyLabel ?? null,
        confidence: input.confidence,
        suggested_handling: input.suggestedHandling ?? null,
        source_count: 1,
        first_seen_at: now,
        last_seen_at: now
      })
      .onConflict((oc) =>
        oc.columns(["owner_user_id", "candidate_signature"]).doUpdateSet({
          source_count: sql<number>`app.commitment_candidates.source_count + 1`,
          last_seen_at: now,
          updated_at: now
        })
      )
      .returningAll()
      .executeTakeFirstOrThrow();

    return rowToCandidate(row);
  }

  /**
   * One judged email thread becomes a candidate, or refreshes the one it already has. The
   * signature carries the thread reference, so a re-judgement lands on the same row (the partial
   * unique index on owner + thread_ref is the second guard). A person's rejection or "never owed"
   * decision is kept; anything else reopens as pending review and clears the stale flag.
   */
  async upsertEmailCandidate(
    scopedDb: unknown,
    input: UpsertEmailCandidateInput
  ): Promise<CommitmentCandidate> {
    assertDataContextDb(scopedDb);
    const now = new Date();
    const proposedActions = sql<
      Record<string, unknown>
    >`${JSON.stringify(input.proposedActions)}::jsonb`;
    const whyLines = [...input.whyLines];

    const row = await scopedDb.db
      .insertInto("app.commitment_candidates")
      .values({
        owner_user_id: input.ownerUserId,
        candidate_signature: input.candidateSignature,
        kind: input.kind,
        title: input.title,
        due_local_date: input.dueLocalDate ?? null,
        counterparty_label: input.counterpartyLabel ?? null,
        confidence: input.confidence,
        suggested_handling: input.suggestedHandling ?? null,
        counterparty_person_id: input.counterpartyPersonId,
        counterparty_address: input.counterpartyAddress,
        proposed_actions: proposedActions,
        why_lines: whyLines,
        thread_ref: input.threadRef,
        last_judged_external_id: input.lastJudgedExternalId,
        stale: false,
        source_count: 1,
        first_seen_at: now,
        last_seen_at: now
      })
      .onConflict((oc) =>
        oc.columns(["owner_user_id", "candidate_signature"]).doUpdateSet({
          title: input.title,
          due_local_date: input.dueLocalDate ?? null,
          counterparty_label: input.counterpartyLabel ?? null,
          confidence: input.confidence,
          suggested_handling: input.suggestedHandling ?? null,
          counterparty_person_id: input.counterpartyPersonId,
          counterparty_address: input.counterpartyAddress,
          proposed_actions: proposedActions,
          why_lines: whyLines,
          last_judged_external_id: input.lastJudgedExternalId,
          stale: false,
          status: sql`CASE WHEN app.commitment_candidates.status IN ('rejected', 'explicit_non_action') THEN app.commitment_candidates.status ELSE 'pending_review'::app.commitment_candidate_status END`,
          source_count: sql<number>`app.commitment_candidates.source_count + 1`,
          last_seen_at: now,
          updated_at: now
        })
      )
      .returningAll()
      .executeTakeFirstOrThrow();

    return rowToCandidate(row);
  }

  /** Remember what the last judgement of a thread concluded, and which message it read up to. */
  async recordThreadJudgement(
    scopedDb: unknown,
    ownerUserId: string,
    threadRef: string,
    lastJudgedExternalId: string,
    outcome: EmailThreadJudgementOutcomeKind
  ): Promise<void> {
    assertDataContextDb(scopedDb);
    const now = new Date();
    await scopedDb.db
      .insertInto("app.commitment_email_thread_judgements")
      .values({
        owner_user_id: ownerUserId,
        thread_ref: threadRef,
        last_judged_external_id: lastJudgedExternalId,
        outcome,
        judged_at: now
      })
      .onConflict((oc) =>
        oc.columns(["owner_user_id", "thread_ref"]).doUpdateSet({
          last_judged_external_id: lastJudgedExternalId,
          outcome,
          judged_at: now
        })
      )
      .execute();
  }

  async getThreadJudgement(
    scopedDb: unknown,
    ownerUserId: string,
    threadRef: string
  ): Promise<{ lastJudgedExternalId: string; outcome: EmailThreadJudgementOutcomeKind } | null> {
    assertDataContextDb(scopedDb);
    const row = await scopedDb.db
      .selectFrom("app.commitment_email_thread_judgements")
      .select(["last_judged_external_id", "outcome"])
      .where("owner_user_id", "=", ownerUserId)
      .where("thread_ref", "=", threadRef)
      .executeTakeFirst();
    return row ? { lastJudgedExternalId: row.last_judged_external_id, outcome: row.outcome } : null;
  }

  /** Email-thread candidates still waiting on the person: open, not yet resolved, soonest due first. */
  async listOpenEmailCandidates(
    scopedDb: unknown,
    ownerUserId: string
  ): Promise<CommitmentCandidate[]> {
    assertDataContextDb(scopedDb);
    const rows = await scopedDb.db
      .selectFrom("app.commitment_candidates")
      .selectAll()
      .where("owner_user_id", "=", ownerUserId)
      .where("thread_ref", "is not", null)
      .where("status", "in", ["pending_review", "accepted", "snoozed"])
      .where("resolution_ref", "is", null)
      .orderBy(sql`due_local_date nulls last`)
      .orderBy("last_seen_at", "desc")
      .execute();
    return rows.map(rowToCandidate);
  }

  async addEvidenceRow(scopedDb: unknown, input: AddEvidenceInput): Promise<boolean> {
    assertDataContextDb(scopedDb);

    const count = await scopedDb.db
      .selectFrom("app.commitment_candidate_sources")
      .select((eb) => eb.fn.countAll<number>().as("cnt"))
      .where("candidate_id", "=", input.candidateId)
      .executeTakeFirstOrThrow();

    if (Number(count.cnt) >= MAX_EVIDENCE_ROWS) return false;

    await scopedDb.db
      .insertInto("app.commitment_candidate_sources")
      .values({
        candidate_id: input.candidateId,
        owner_user_id: input.ownerUserId,
        source_kind: input.sourceKind,
        source_ref: input.sourceRef,
        source_version: input.sourceVersion,
        evidence_excerpt: sanitizeExcerpt(input.evidenceExcerpt),
        occurred_at: input.occurredAt ? new Date(input.occurredAt) : null
      })
      .onConflict((oc) =>
        oc.columns(["candidate_id", "source_kind", "source_ref"]).doUpdateSet({
          source_version: input.sourceVersion,
          evidence_excerpt: sanitizeExcerpt(input.evidenceExcerpt)
        })
      )
      .execute();

    return true;
  }

  async listCandidates(
    scopedDb: unknown,
    ownerUserId: string,
    status?: CommitmentCandidateStatus
  ): Promise<CommitmentCandidate[]> {
    assertDataContextDb(scopedDb);
    let q = scopedDb.db
      .selectFrom("app.commitment_candidates as c")
      .selectAll()
      .where("c.owner_user_id", "=", ownerUserId)
      .orderBy("c.last_seen_at", "desc");
    if (status) q = q.where("c.status", "=", status);
    const rows = await q.execute();
    return rows.map(rowToCandidate);
  }

  async getCandidate(
    scopedDb: unknown,
    ownerUserId: string,
    candidateId: string
  ): Promise<CommitmentCandidate | null> {
    assertDataContextDb(scopedDb);
    const row = await scopedDb.db
      .selectFrom("app.commitment_candidates as c")
      .selectAll()
      .where("c.id", "=", candidateId)
      .where("c.owner_user_id", "=", ownerUserId)
      .executeTakeFirst();
    return row ? rowToCandidate(row) : null;
  }

  async updateStatus(
    scopedDb: unknown,
    ownerUserId: string,
    candidateId: string,
    status: CommitmentCandidateStatus,
    snoozedUntil?: Date | null
  ): Promise<CommitmentCandidate> {
    assertDataContextDb(scopedDb);
    const row = await scopedDb.db
      .updateTable("app.commitment_candidates")
      .set({
        status,
        snoozed_until: snoozedUntil ?? null,
        updated_at: new Date()
      })
      .where("id", "=", candidateId)
      .where("owner_user_id", "=", ownerUserId)
      .returningAll()
      .executeTakeFirstOrThrow();
    return rowToCandidate(row);
  }

  async setResolutionRef(
    scopedDb: unknown,
    ownerUserId: string,
    candidateId: string,
    resolutionRef: string
  ): Promise<CommitmentCandidate> {
    assertDataContextDb(scopedDb);
    const row = await scopedDb.db
      .updateTable("app.commitment_candidates")
      .set({ resolution_ref: resolutionRef, updated_at: new Date() })
      .where("id", "=", candidateId)
      .where("owner_user_id", "=", ownerUserId)
      .returningAll()
      .executeTakeFirstOrThrow();
    return rowToCandidate(row);
  }

  async getEvidenceForCandidate(
    scopedDb: unknown,
    candidateId: string
  ): Promise<CommitmentCandidateSource[]> {
    assertDataContextDb(scopedDb);
    const rows = await scopedDb.db
      .selectFrom("app.commitment_candidate_sources")
      .selectAll()
      .where("candidate_id", "=", candidateId)
      .orderBy("created_at", "asc")
      .execute();
    return rows.map(rowToSource);
  }

  async getExtractionState(
    scopedDb: unknown,
    ownerUserId: string,
    sourceKind: CommitmentSourceKind
  ): Promise<CommitmentExtractionState | null> {
    assertDataContextDb(scopedDb);
    const row = await scopedDb.db
      .selectFrom("app.commitment_extraction_state")
      .selectAll()
      .where("owner_user_id", "=", ownerUserId)
      .where("source_kind", "=", sourceKind)
      .executeTakeFirst();
    return row ? rowToState(row) : null;
  }

  async upsertExtractionState(
    scopedDb: unknown,
    ownerUserId: string,
    sourceKind: CommitmentSourceKind,
    lastExtractedAt: Date
  ): Promise<void> {
    assertDataContextDb(scopedDb);
    await scopedDb.db
      .insertInto("app.commitment_extraction_state")
      .values({
        owner_user_id: ownerUserId,
        source_kind: sourceKind,
        last_extracted_at: lastExtractedAt,
        last_run_at: new Date()
      })
      .onConflict((oc) =>
        oc.columns(["owner_user_id", "source_kind"]).doUpdateSet({
          last_extracted_at: lastExtractedAt,
          last_run_at: new Date(),
          updated_at: new Date()
        })
      )
      .execute();
  }
}

function sanitizeExcerpt(text: string): string {
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return escaped.slice(0, 500);
}

function pgDateToLocalStr(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, "0");
    const d = String(v.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return v as string;
}

function rowToCandidate(row: Record<string, unknown>): CommitmentCandidate {
  return {
    id: row["id"] as string,
    ownerUserId: row["owner_user_id"] as string,
    candidateSignature: row["candidate_signature"] as string,
    kind: row["kind"] as CommitmentCandidate["kind"],
    title: row["title"] as string,
    dueLocalDate: pgDateToLocalStr(row["due_local_date"]),
    counterpartyLabel: row["counterparty_label"] as string | null,
    status: row["status"] as CommitmentCandidateStatus,
    confidence: row["confidence"] as "high" | "medium" | "low",
    suggestedHandling: row["suggested_handling"] as CommitmentSuggestedHandling | null,
    resolutionRef: row["resolution_ref"] as string | null,
    suppressedBy: row["suppressed_by"] as string | null,
    sourceCount: row["source_count"] as number,
    firstSeenAt: row["first_seen_at"] as Date,
    lastSeenAt: row["last_seen_at"] as Date,
    snoozedUntil: row["snoozed_until"] as Date | null,
    expiresAt: row["expires_at"] as Date | null,
    createdAt: row["created_at"] as Date,
    updatedAt: row["updated_at"] as Date,
    ...emailColumns(row)
  };
}

/** The 0216 columns, present only once that migration has run (and only set on email items). */
function emailColumns(row: Record<string, unknown>): Partial<CommitmentCandidate> {
  if (!("thread_ref" in row)) return {};
  const actions = row["proposed_actions"];
  return {
    counterpartyPersonId: (row["counterparty_person_id"] as string | null) ?? null,
    counterpartyAddress: (row["counterparty_address"] as string | null) ?? null,
    proposedActions: Array.isArray(actions) ? (actions as ProposedCommitmentAction[]) : [],
    whyLines: Array.isArray(row["why_lines"]) ? (row["why_lines"] as string[]) : [],
    threadRef: (row["thread_ref"] as string | null) ?? null,
    lastJudgedExternalId: (row["last_judged_external_id"] as string | null) ?? null,
    stale: row["stale"] === true
  };
}

function rowToSource(row: Record<string, unknown>): CommitmentCandidateSource {
  return {
    id: row["id"] as string,
    candidateId: row["candidate_id"] as string,
    ownerUserId: row["owner_user_id"] as string,
    sourceKind: row["source_kind"] as CommitmentSourceKind,
    sourceRef: row["source_ref"] as string,
    sourceVersion: row["source_version"] as number,
    evidenceExcerpt: row["evidence_excerpt"] as string,
    occurredAt: row["occurred_at"] as Date | null,
    createdAt: row["created_at"] as Date
  };
}

function rowToState(row: Record<string, unknown>): CommitmentExtractionState {
  return {
    id: row["id"] as string,
    ownerUserId: row["owner_user_id"] as string,
    sourceKind: row["source_kind"] as CommitmentSourceKind,
    lastExtractedAt: row["last_extracted_at"] as Date | null,
    lastRunAt: row["last_run_at"] as Date,
    updatedAt: row["updated_at"] as Date
  };
}
