import { sql } from "kysely";

import {
  assertDataContextDb,
  type DataContextDb,
  type UsefulnessFeedbackKind,
  type UsefulnessFeedbackSignal,
  type UsefulnessFeedbackStatus
} from "@moss/db";
import type { FeedbackSurface, FeedbackTargetKind } from "@moss/shared";

import { isStoryTargetKind, sanitizeStoryTargetMetadata } from "./story-target.js";
import type { FeedbackTargetVerification } from "./target-verifiers.js";

/**
 * The outcome of taking a preference back. `changed` is false when the row was already undone or
 * already superseded, so nothing actually moved and no follow-on refresh is owed.
 */
export interface UndoResult {
  readonly feedback: UsefulnessFeedbackSignal;
  readonly changed: boolean;
}

interface FeedbackRow {
  readonly id: string;
  readonly owner_user_id: string;
  readonly target_kind: FeedbackTargetKind;
  readonly target_ref: string;
  readonly surface: FeedbackSurface;
  readonly kind: UsefulnessFeedbackKind;
  readonly source_kind: string | null;
  readonly source_label: string | null;
  readonly priority_band: "critical" | "high" | "normal" | "low" | null;
  readonly effect_kind: string | null;
  readonly effect_ref: string | null;
  readonly metadata_json: Record<string, unknown>;
  readonly status: UsefulnessFeedbackStatus;
  readonly reason_text: string | null;
  readonly rule_json: Record<string, unknown>;
  readonly rule_version: number | null;
  readonly revision: number;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly resolved_at: Date | null;
}

export interface CreateFeedbackInput {
  readonly ownerUserId: string;
  readonly targetKind: FeedbackTargetKind;
  readonly targetRef: string;
  readonly surface: FeedbackSurface;
  readonly kind: UsefulnessFeedbackKind;
  readonly verification: FeedbackTargetVerification;
  readonly metadata: Record<string, unknown>;
  readonly effectKind?: string | null;
  readonly effectRef?: string | null;
  /** Already trimmed and length-checked by the route; stored verbatim. */
  readonly reasonText?: string | null;
}

export interface ListFeedbackOptions {
  readonly targetKinds?: readonly FeedbackTargetKind[];
  readonly status?: UsefulnessFeedbackStatus;
}

export class UsefulnessFeedbackRepository {
  async findActive(
    scopedDb: DataContextDb,
    ownerUserId: string,
    targetKind: FeedbackTargetKind,
    targetRef: string,
    kind: UsefulnessFeedbackKind
  ): Promise<UsefulnessFeedbackSignal | undefined> {
    assertDataContextDb(scopedDb);
    return scopedDb.db
      .selectFrom("app.usefulness_feedback_signals")
      .selectAll()
      .where("owner_user_id", "=", ownerUserId)
      .where("target_kind", "=", targetKind)
      .where("target_ref", "=", targetRef)
      .where("kind", "=", kind)
      .where("status", "=", "active")
      .executeTakeFirst();
  }

  async create(
    scopedDb: DataContextDb,
    input: CreateFeedbackInput
  ): Promise<UsefulnessFeedbackSignal> {
    assertDataContextDb(scopedDb);
    const result = await sql<FeedbackRow>`
      INSERT INTO app.usefulness_feedback_signals (
        owner_user_id,
        target_kind,
        target_ref,
        surface,
        kind,
        source_kind,
        source_label,
        priority_band,
        effect_kind,
        effect_ref,
        metadata_json,
        reason_text
      )
      VALUES (
        ${input.ownerUserId}::uuid,
        ${input.targetKind},
        ${input.targetRef},
        ${input.surface},
        ${input.kind},
        ${input.verification.sourceKind ?? null},
        ${input.verification.sourceLabel ?? null},
        ${input.verification.priorityBand ?? null},
        ${input.effectKind ?? null},
        ${input.effectRef ?? null},
        ${JSON.stringify(input.metadata)}::jsonb,
        ${input.reasonText ?? null}
      )
      RETURNING *
    `.execute(scopedDb.db);

    const row = result.rows[0];
    if (!row) throw new Error("usefulness feedback insert returned no row");
    return row;
  }

  async list(
    scopedDb: DataContextDb,
    ownerUserId: string,
    options: ListFeedbackOptions = {}
  ): Promise<UsefulnessFeedbackSignal[]> {
    assertDataContextDb(scopedDb);
    let query = scopedDb.db
      .selectFrom("app.usefulness_feedback_signals")
      .selectAll()
      .where("owner_user_id", "=", ownerUserId);
    if (options.targetKinds && options.targetKinds.length > 0) {
      query = query.where("target_kind", "in", [...options.targetKinds]);
    }
    if (options.status) query = query.where("status", "=", options.status);
    return query.orderBy("created_at", "desc").orderBy("id").limit(100).execute();
  }

  /**
   * The active story preference for one story, in either direction. The per-direction
   * `findActive` cannot see the opposite one, which is exactly what flipping a preference needs.
   */
  async findActiveStoryPreference(
    scopedDb: DataContextDb,
    ownerUserId: string,
    targetKind: FeedbackTargetKind,
    targetRef: string
  ): Promise<UsefulnessFeedbackSignal | undefined> {
    assertDataContextDb(scopedDb);
    return scopedDb.db
      .selectFrom("app.usefulness_feedback_signals")
      .selectAll()
      .where("owner_user_id", "=", ownerUserId)
      .where("target_kind", "=", targetKind)
      .where("target_ref", "=", targetRef)
      .where("status", "=", "active")
      .executeTakeFirst();
  }

  /** Retires a preference that the opposite direction has just replaced. */
  async supersede(
    scopedDb: DataContextDb,
    ownerUserId: string,
    id: string
  ): Promise<UsefulnessFeedbackSignal | undefined> {
    assertDataContextDb(scopedDb);
    const now = new Date();
    return scopedDb.db
      .updateTable("app.usefulness_feedback_signals")
      .set({ status: "superseded", resolved_at: now, updated_at: now })
      .where("owner_user_id", "=", ownerUserId)
      .where("id", "=", id)
      .where("status", "=", "active")
      .returningAll()
      .executeTakeFirst();
  }

  /** Rewrites the reason on an active row, keeping the same id and bumping the revision. */
  async updateReason(
    scopedDb: DataContextDb,
    ownerUserId: string,
    id: string,
    reasonText: string
  ): Promise<UsefulnessFeedbackSignal | undefined> {
    assertDataContextDb(scopedDb);
    const result = await sql<FeedbackRow>`
      UPDATE app.usefulness_feedback_signals
      SET reason_text = ${reasonText},
          revision = revision + 1,
          updated_at = now()
      WHERE owner_user_id = ${ownerUserId}::uuid
        AND id = ${id}::uuid
        AND status = 'active'
        AND kind = 'less_like_this'
      RETURNING *
    `.execute(scopedDb.db);
    return result.rows[0];
  }

  async findOwned(
    scopedDb: DataContextDb,
    ownerUserId: string,
    id: string
  ): Promise<UsefulnessFeedbackSignal | undefined> {
    assertDataContextDb(scopedDb);
    return scopedDb.db
      .selectFrom("app.usefulness_feedback_signals")
      .selectAll()
      .where("owner_user_id", "=", ownerUserId)
      .where("id", "=", id)
      .executeTakeFirst();
  }

  async upsertTarget(
    scopedDb: DataContextDb,
    input: {
      readonly ownerUserId: string;
      readonly targetKind: FeedbackTargetKind;
      readonly targetRef: string;
      readonly surface: FeedbackSurface;
      readonly sourceKind?: string | null;
      readonly sourceLabel?: string | null;
      readonly priorityBand?: "critical" | "high" | "normal" | "low" | null;
      readonly metadata?: Record<string, unknown>;
    }
  ): Promise<void> {
    assertDataContextDb(scopedDb);
    // Story targets are bounded on the way in, not just on the way out. The read path cleans too,
    // but a module registering a story must not be able to park anything wider than the agreed
    // shape in the row. Briefing targets keep their existing block-list behaviour.
    const metadata = isStoryTargetKind(input.targetKind)
      ? sanitizeStoryTargetMetadata(input.metadata)
      : (input.metadata ?? {});
    await sql`
      INSERT INTO app.usefulness_feedback_targets (
        owner_user_id,
        target_kind,
        target_ref,
        surface,
        source_kind,
        source_label,
        priority_band,
        metadata_json,
        last_seen_at
      )
      VALUES (
        ${input.ownerUserId}::uuid,
        ${input.targetKind},
        ${input.targetRef},
        ${input.surface},
        ${input.sourceKind ?? null},
        ${input.sourceLabel ?? null},
        ${input.priorityBand ?? null},
        ${JSON.stringify(metadata)}::jsonb,
        now()
      )
      ON CONFLICT (owner_user_id, target_kind, target_ref, surface) DO UPDATE
      SET source_kind = EXCLUDED.source_kind,
          source_label = EXCLUDED.source_label,
          priority_band = EXCLUDED.priority_band,
          metadata_json = app.usefulness_feedback_targets.metadata_json || EXCLUDED.metadata_json,
          last_seen_at = now()
    `.execute(scopedDb.db);
  }

  async findTarget(
    scopedDb: DataContextDb,
    ownerUserId: string,
    targetKind: FeedbackTargetKind,
    targetRef: string,
    surface: FeedbackSurface
  ): Promise<{
    readonly owner_user_id: string;
    readonly target_kind: FeedbackTargetKind;
    readonly target_ref: string;
    readonly surface: FeedbackSurface;
    readonly source_kind: string | null;
    readonly source_label: string | null;
    readonly priority_band: "critical" | "high" | "normal" | "low" | null;
    readonly metadata_json: Record<string, unknown>;
  } | null> {
    assertDataContextDb(scopedDb);
    const result = await sql<{
      readonly owner_user_id: string;
      readonly target_kind: FeedbackTargetKind;
      readonly target_ref: string;
      readonly surface: FeedbackSurface;
      readonly source_kind: string | null;
      readonly source_label: string | null;
      readonly priority_band: "critical" | "high" | "normal" | "low" | null;
      readonly metadata_json: Record<string, unknown>;
    }>`
      SELECT owner_user_id, target_kind, target_ref, surface, source_kind, source_label,
             priority_band, metadata_json
      FROM app.usefulness_feedback_targets
      WHERE owner_user_id = ${ownerUserId}::uuid
        AND target_kind = ${targetKind}
        AND target_ref = ${targetRef}
        AND surface = ${surface}
    `.execute(scopedDb.db);
    return result.rows[0] ?? null;
  }

  async listActiveDismissedRefs(
    scopedDb: DataContextDb,
    ownerUserId: string,
    targetKind: FeedbackTargetKind,
    surface: FeedbackSurface
  ): Promise<Set<string>> {
    assertDataContextDb(scopedDb);
    const result = await sql<{ target_ref: string }>`
      SELECT target_ref
      FROM app.usefulness_feedback_signals
      WHERE owner_user_id = ${ownerUserId}::uuid
        AND target_kind = ${targetKind}
        AND surface = ${surface}
        AND kind = 'dismiss'
        AND status = 'active'
    `.execute(scopedDb.db);
    return new Set(result.rows.map((row) => row.target_ref));
  }

  async undo(
    scopedDb: DataContextDb,
    ownerUserId: string,
    id: string,
    options: {
      readonly cancelMemoryCandidate?: (candidateId: string) => Promise<boolean>;
      readonly undoDismissCard?: (cardId: string) => Promise<void>;
    } = {}
  ): Promise<UndoResult | undefined> {
    assertDataContextDb(scopedDb);
    const existing = await scopedDb.db
      .selectFrom("app.usefulness_feedback_signals")
      .selectAll()
      .where("owner_user_id", "=", ownerUserId)
      .where("id", "=", id)
      .executeTakeFirst();
    if (!existing) return undefined;
    // Only an active preference can be taken back; an undone or superseded one is already retired.
    // `changed` is false in that case so callers can skip side effects for a row nothing happened to.
    if (existing.status !== "active") return { feedback: existing, changed: false };
    if (existing.effect_kind === "memory_candidate" && existing.effect_ref) {
      await options.cancelMemoryCandidate?.(existing.effect_ref);
    }
    if (existing.effect_kind === "proactive_card_dismissed" && existing.effect_ref) {
      await options.undoDismissCard?.(existing.effect_ref);
    }
    const updated = await scopedDb.db
      .updateTable("app.usefulness_feedback_signals")
      .set({ status: "undone", resolved_at: new Date(), updated_at: new Date() })
      .where("owner_user_id", "=", ownerUserId)
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();
    return updated ? { feedback: updated, changed: true } : undefined;
  }
}
