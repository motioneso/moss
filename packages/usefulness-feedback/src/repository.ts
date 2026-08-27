import { sql } from "kysely";

import {
  assertDataContextDb,
  type DataContextDb,
  type UsefulnessFeedbackKind,
  type UsefulnessFeedbackSignal,
  type UsefulnessFeedbackStatus
} from "@moss/db";
import type {
  FeedbackSurface,
  FeedbackTargetKind,
  StoryFeedbackModule,
  StoryRelevanceDirection,
  StoryRelevanceRule
} from "@moss/shared";

import {
  compileStoryRelevanceRule,
  storyRelevanceDirectionForKind,
  storyRelevanceRuleNeedsRecompile
} from "./relevance/compile.js";
import {
  STORY_TARGET_KIND_BY_MODULE,
  isStoryTargetKind,
  sanitizeStoryTargetMetadata
} from "./story-target.js";
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
  /**
   * The compiled preference, for a story row. Compiling is pure, so it happens in the route before
   * this call and can never make saving fail. Anything else keeps today's empty default.
   */
  readonly rule?: StoryRelevanceRule | null;
}

/**
 * One owner preference, ready to evaluate candidate stories against. The reason travels with it as
 * data, read from its own column: it is never copied into the rule and never logged.
 */
export interface ActiveStoryRuleRow {
  readonly id: string;
  readonly targetRef: string;
  readonly direction: StoryRelevanceDirection;
  readonly reasonText: string | null;
  readonly rule: StoryRelevanceRule;
}

/** The most preferences one owner's feed is ever judged against, matching the existing list cap. */
const MAX_ACTIVE_STORY_RULES = 100;

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
        reason_text,
        rule_json,
        rule_version
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
        ${input.reasonText ?? null},
        ${JSON.stringify(input.rule ?? {})}::jsonb,
        ${input.rule?.version ?? null}
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

  /**
   * Rewrites the reason on an active row, keeping the same id and bumping the revision. The
   * rebuilt rule is written in the same statement, so a row can never carry a reason and a rule
   * that disagree with each other.
   */
  async updateReason(
    scopedDb: DataContextDb,
    ownerUserId: string,
    id: string,
    reasonText: string,
    rule: StoryRelevanceRule | null
  ): Promise<UsefulnessFeedbackSignal | undefined> {
    assertDataContextDb(scopedDb);
    const result = await sql<FeedbackRow>`
      UPDATE app.usefulness_feedback_signals
      SET reason_text = ${reasonText},
          rule_json = ${JSON.stringify(rule ?? {})}::jsonb,
          rule_version = ${rule?.version ?? null},
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

  /**
   * Every active story preference this owner holds for one module, ready to judge candidates
   * against. Owner-scoped and module-scoped, so a News refresh can never see a Sports preference
   * and the other way round.
   *
   * A row whose stored rule is missing, empty or built by an older version is rebuilt here from
   * that row's own verified story context and reason, and written back. That repairs every row
   * saved before this change and makes a later change of rule shape safe, without a migration.
   */
  async listActiveStoryRules(
    scopedDb: DataContextDb,
    ownerUserId: string,
    moduleId: StoryFeedbackModule
  ): Promise<ActiveStoryRuleRow[]> {
    assertDataContextDb(scopedDb);
    const targetKind = STORY_TARGET_KIND_BY_MODULE[moduleId];
    const result = await sql<{
      readonly id: string;
      readonly target_ref: string;
      readonly kind: UsefulnessFeedbackKind;
      readonly metadata_json: Record<string, unknown>;
      readonly reason_text: string | null;
      readonly rule_json: Record<string, unknown>;
      readonly rule_version: number | null;
    }>`
      SELECT id, target_ref, kind, metadata_json, reason_text, rule_json, rule_version
      FROM app.usefulness_feedback_signals
      WHERE owner_user_id = ${ownerUserId}::uuid
        AND target_kind = ${targetKind}
        AND status = 'active'
        AND kind IN ('less_like_this', 'more_like_this')
      ORDER BY created_at DESC, id
      LIMIT ${MAX_ACTIVE_STORY_RULES}
    `.execute(scopedDb.db);

    const rules: ActiveStoryRuleRow[] = [];
    for (const row of result.rows) {
      const direction = storyRelevanceDirectionForKind(row.kind);
      if (!direction) continue;
      let rule = row.rule_json as unknown as StoryRelevanceRule;
      if (storyRelevanceRuleNeedsRecompile(row.rule_json, row.rule_version)) {
        rule = compileStoryRelevanceRule({
          moduleId,
          direction,
          storyRef: row.target_ref,
          context: sanitizeStoryTargetMetadata(row.metadata_json),
          reasonText: row.reason_text
        });
        await this.writeRule(scopedDb, ownerUserId, row.id, rule);
      }
      rules.push({
        id: row.id,
        targetRef: row.target_ref,
        direction,
        reasonText: row.reason_text,
        rule
      });
    }
    return rules;
  }

  /**
   * Stores a rebuilt rule without touching the revision: repairing a rule is our own housekeeping,
   * not a change the owner made, so nothing downstream should read it as an edit.
   */
  private async writeRule(
    scopedDb: DataContextDb,
    ownerUserId: string,
    id: string,
    rule: StoryRelevanceRule
  ): Promise<void> {
    await sql`
      UPDATE app.usefulness_feedback_signals
      SET rule_json = ${JSON.stringify(rule)}::jsonb,
          rule_version = ${rule.version}
      WHERE owner_user_id = ${ownerUserId}::uuid
        AND id = ${id}::uuid
        AND status = 'active'
    `.execute(scopedDb.db);
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
