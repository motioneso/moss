import { sql } from "kysely";

import { assertDataContextDb, type DataContextDb } from "@moss/db";
import type {
  MossGoal,
  MossGoalEvidence,
  MossGoalStatus,
  MossGoalEvidenceKind,
  MossGoalSourceKind,
  MossGoalReviewCadence
} from "./types.js";

export interface GoalRow {
  id: string;
  owner_user_id: string;
  title: string;
  desired_outcome: string;
  status: string;
  priority: number;
  review_cadence: string;
  next_review_at: Date | null;
  target_at: Date | null;
  last_progress_summary: string | null;
  last_progress_at: Date | null;
  blocker_summary: string | null;
  next_suggested_action: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
  archived_at: Date | null;
}

export interface EvidenceRow {
  id: string;
  owner_user_id: string;
  goal_id: string;
  evidence_kind: string;
  source_kind: string;
  source_ref: string | null;
  source_label: string;
  summary: string;
  occurred_at: Date | null;
  created_at: Date;
}

export class GoalsRepository {
  async getById(scopedDb: DataContextDb, id: string): Promise<MossGoal | null> {
    assertDataContextDb(scopedDb);
    const result = await sql<GoalRow>`
      SELECT * FROM app.moss_goals WHERE id = ${id}::uuid
    `.execute(scopedDb.db);
    return result.rows[0] ? this.mapGoal(result.rows[0]) : null;
  }

  async list(scopedDb: DataContextDb): Promise<MossGoal[]> {
    assertDataContextDb(scopedDb);
    const result = await sql<GoalRow>`
      SELECT * FROM app.moss_goals
      ORDER BY priority DESC, created_at DESC
    `.execute(scopedDb.db);
    return result.rows.map((row) => this.mapGoal(row));
  }

  async create(
    scopedDb: DataContextDb,
    ownerUserId: string,
    data: Partial<MossGoal>
  ): Promise<MossGoal> {
    assertDataContextDb(scopedDb);
    const result = await sql<GoalRow>`
      INSERT INTO app.moss_goals (
        owner_user_id, title, desired_outcome, priority, review_cadence, target_at
      ) VALUES (
        ${ownerUserId}::uuid, ${data.title ?? null}, ${data.desiredOutcome ?? null}, ${data.priority ?? 3}, ${data.reviewCadence ?? "weekly"}, ${data.targetAt ?? null}
      ) RETURNING *
    `.execute(scopedDb.db);
    return this.mapGoal(result.rows[0]!);
  }

  async update(scopedDb: DataContextDb, id: string, data: Partial<MossGoal>): Promise<MossGoal> {
    assertDataContextDb(scopedDb);
    const result = await sql<GoalRow>`
      UPDATE app.moss_goals SET
        title = COALESCE(${data.title ?? null}, title),
        desired_outcome = COALESCE(${data.desiredOutcome ?? null}, desired_outcome),
        status = COALESCE(${data.status ?? null}, status),
        priority = COALESCE(${data.priority ?? null}, priority),
        review_cadence = COALESCE(${data.reviewCadence ?? null}, review_cadence),
        target_at = CASE WHEN ${data.targetAt !== undefined}::boolean THEN ${data.targetAt ?? null} ELSE target_at END,
        last_progress_summary = CASE WHEN ${data.lastProgressSummary !== undefined}::boolean THEN ${data.lastProgressSummary ?? null} ELSE last_progress_summary END,
        blocker_summary = CASE WHEN ${data.blockerSummary !== undefined}::boolean THEN ${data.blockerSummary ?? null} ELSE blocker_summary END,
        next_suggested_action = CASE WHEN ${data.nextSuggestedAction !== undefined}::boolean THEN ${data.nextSuggestedAction ?? null} ELSE next_suggested_action END,
        updated_at = NOW()
      WHERE id = ${id}::uuid
      RETURNING *
    `.execute(scopedDb.db);
    if (!result.rows[0]) {
      throw new Error("Failed to update goal");
    }
    return this.mapGoal(result.rows[0]);
  }

  async listEvidence(scopedDb: DataContextDb, goalId: string): Promise<MossGoalEvidence[]> {
    assertDataContextDb(scopedDb);
    const result = await sql<EvidenceRow>`
      SELECT * FROM app.moss_goal_evidence
      WHERE goal_id = ${goalId}::uuid
      ORDER BY created_at DESC
    `.execute(scopedDb.db);
    return result.rows.map((row) => this.mapEvidence(row));
  }

  async addEvidence(
    scopedDb: DataContextDb,
    ownerUserId: string,
    goalId: string,
    data: Partial<MossGoalEvidence>
  ): Promise<MossGoalEvidence> {
    assertDataContextDb(scopedDb);
    const result = await sql<EvidenceRow>`
      INSERT INTO app.moss_goal_evidence (
        owner_user_id, goal_id, evidence_kind, source_kind, source_ref, source_label, summary, occurred_at
      ) VALUES (
        ${ownerUserId}::uuid, ${goalId}::uuid, ${data.evidenceKind ?? null}, ${data.sourceKind ?? null}, ${data.sourceRef ?? null}, ${data.sourceLabel ?? null}, ${data.summary ?? null}, ${data.occurredAt ?? null}
      ) RETURNING *
    `.execute(scopedDb.db);
    return this.mapEvidence(result.rows[0]!);
  }

  async updateSyncStatus(
    scopedDb: DataContextDb,
    id: string,
    syncedAt: Date,
    goalUpdatedAt: Date
  ): Promise<void> {
    assertDataContextDb(scopedDb);
    await sql`
      UPDATE app.moss_goals
      SET memory_synced_at = ${syncedAt},
          memory_synced_goal_updated_at = ${goalUpdatedAt},
          memory_sync_error_class = NULL
      WHERE id = ${id}::uuid
    `.execute(scopedDb.db);
  }

  async markSyncError(scopedDb: DataContextDb, id: string, errorClass: string): Promise<void> {
    assertDataContextDb(scopedDb);
    await sql`
      UPDATE app.moss_goals
      SET memory_sync_error_class = ${errorClass}
      WHERE id = ${id}::uuid
    `.execute(scopedDb.db);
  }

  async acquireSyncLock(scopedDb: DataContextDb, id: string): Promise<boolean> {
    assertDataContextDb(scopedDb);
    const result = await sql<{ locked: boolean }>`
      SELECT pg_try_advisory_xact_lock(
        hashtext('goals-sync'),
        hashtext(${id})
      ) as locked
    `.execute(scopedDb.db);
    return result.rows[0]?.locked ?? false;
  }

  async listForReconcile(
    scopedDb: DataContextDb
  ): Promise<{ id: string; updated_at: string; memory_synced_goal_updated_at: string | null }[]> {
    assertDataContextDb(scopedDb);
    const result = await sql<{
      id: string;
      updated_at: Date;
      memory_synced_goal_updated_at: Date | null;
    }>`
      SELECT id, updated_at, memory_synced_goal_updated_at
      FROM app.moss_goals
      WHERE status != 'archived' 
        AND (memory_synced_goal_updated_at IS NULL OR memory_synced_goal_updated_at < updated_at)
      ORDER BY updated_at ASC
      LIMIT 100
    `.execute(scopedDb.db);
    return result.rows.map((row) => ({
      id: row.id,
      updated_at: row.updated_at.toISOString(),
      memory_synced_goal_updated_at: row.memory_synced_goal_updated_at?.toISOString() ?? null
    }));
  }

  private mapGoal(row: GoalRow): MossGoal {
    return {
      id: row.id,
      ownerUserId: row.owner_user_id,
      title: row.title,
      desiredOutcome: row.desired_outcome,
      status: row.status as MossGoalStatus,
      priority: row.priority as 1 | 2 | 3 | 4 | 5,
      reviewCadence: row.review_cadence as MossGoalReviewCadence,
      nextReviewAt: row.next_review_at ? row.next_review_at.toISOString() : null,
      targetAt: row.target_at ? row.target_at.toISOString() : null,
      lastProgressSummary: row.last_progress_summary,
      lastProgressAt: row.last_progress_at ? row.last_progress_at.toISOString() : null,
      blockerSummary: row.blocker_summary,
      nextSuggestedAction: row.next_suggested_action,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      completedAt: row.completed_at ? row.completed_at.toISOString() : null,
      archivedAt: row.archived_at ? row.archived_at.toISOString() : null
    };
  }

  private mapEvidence(row: EvidenceRow): MossGoalEvidence {
    return {
      id: row.id,
      ownerUserId: row.owner_user_id,
      goalId: row.goal_id,
      evidenceKind: row.evidence_kind as MossGoalEvidenceKind,
      sourceKind: row.source_kind as MossGoalSourceKind,
      sourceRef: row.source_ref,
      sourceLabel: row.source_label,
      summary: row.summary,
      occurredAt: row.occurred_at ? row.occurred_at.toISOString() : null,
      createdAt: row.created_at.toISOString()
    };
  }
}
