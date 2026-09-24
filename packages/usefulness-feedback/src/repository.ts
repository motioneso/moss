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
  STORY_RELEVANCE_ANSWER_TTL_DAYS,
  type StoryRelevanceAnswerKey,
  type StoryRelevanceAskedAnswer,
  type StoryRelevanceStoredAnswer
} from "./relevance/answer-cache.js";
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

/** One row of the "this owner may give feedback on this thing, on this surface" table. */
export interface UpsertTargetInput {
  readonly ownerUserId: string;
  readonly targetKind: FeedbackTargetKind;
  readonly targetRef: string;
  readonly surface: FeedbackSurface;
  readonly sourceKind?: string | null;
  readonly sourceLabel?: string | null;
  readonly priorityBand?: "critical" | "high" | "normal" | "low" | null;
  readonly metadata?: Record<string, unknown>;
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
    const retired = await scopedDb.db
      .updateTable("app.usefulness_feedback_signals")
      .set({ status: "superseded", resolved_at: now, updated_at: now })
      .where("owner_user_id", "=", ownerUserId)
      .where("id", "=", id)
      .where("status", "=", "active")
      .returningAll()
      .executeTakeFirst();
    // #2636: the retired rule's remembered answers are no longer reachable, so drop them.
    if (retired) await this.deleteStoryRelevanceAnswersForRule(scopedDb, ownerUserId, id);
    return retired;
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
    const updated = result.rows[0];
    // #2636: the rule's text changed, so its remembered answers are stale. Drop them rather than
    // lean on the key hash alone; the delete keeps the cache from carrying abandoned keys.
    if (updated) await this.deleteStoryRelevanceAnswersForRule(scopedDb, ownerUserId, id);
    return updated;
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
   * #2636: the remembered answers for the pairs the matcher is about to judge. Only the caller's
   * own rows, and only the ones still inside their seven-day life. The read is deliberately narrow
   * (the exact stories and rules asked about) so a large feed never pulls the owner's whole cache.
   */
  async readStoryRelevanceAnswers(
    scopedDb: DataContextDb,
    ownerUserId: string,
    keys: readonly StoryRelevanceAnswerKey[]
  ): Promise<StoryRelevanceStoredAnswer[]> {
    assertDataContextDb(scopedDb);
    if (keys.length === 0) return [];
    const storyRefs = [...new Set(keys.map((key) => key.storyRef))];
    const ruleIds = [...new Set(keys.map((key) => key.ruleId))];
    const result = await sql<{
      readonly story_ref: string;
      readonly rule_id: string;
      readonly rule_text_hash: string;
      readonly model_fingerprint: string;
      readonly answer: string;
      readonly confidence: number;
      readonly expires_at: Date;
    }>`
      SELECT story_ref, rule_id, rule_text_hash, model_fingerprint, answer, confidence, expires_at
      FROM app.story_relevance_answer_cache
      WHERE owner_user_id = ${ownerUserId}::uuid
        AND expires_at > now()
        AND story_ref IN (${sql.join(
          storyRefs.map((ref) => sql`${ref}`),
          sql`, `
        )})
        AND rule_id IN (${sql.join(
          ruleIds.map((id) => sql`${id}::uuid`),
          sql`, `
        )})
    `.execute(scopedDb.db);

    const answers: StoryRelevanceStoredAnswer[] = [];
    for (const row of result.rows) {
      if (row.answer !== "yes" && row.answer !== "no") continue;
      if (!Number.isFinite(row.confidence)) continue;
      answers.push({
        storyRef: row.story_ref,
        ruleId: row.rule_id,
        ruleTextHash: row.rule_text_hash,
        modelFingerprint: row.model_fingerprint,
        answer: row.answer,
        confidence: row.confidence,
        expiresAt: row.expires_at
      });
    }
    return answers;
  }

  /**
   * #2636: remembers the answers a run just earned. The key is the whole identity of the answer, so
   * a repeat writes the same row and refreshes its life rather than piling up duplicates.
   */
  async writeStoryRelevanceAnswers(
    scopedDb: DataContextDb,
    ownerUserId: string,
    answers: readonly (StoryRelevanceAnswerKey & StoryRelevanceAskedAnswer)[]
  ): Promise<void> {
    assertDataContextDb(scopedDb);
    if (answers.length === 0) return;
    const rows = answers.map(
      (entry) => sql`(
        ${ownerUserId}::uuid,
        ${entry.storyRef},
        ${entry.ruleId}::uuid,
        ${entry.ruleTextHash},
        ${entry.modelFingerprint},
        ${entry.answer},
        ${entry.confidence},
        now() + make_interval(days => ${STORY_RELEVANCE_ANSWER_TTL_DAYS})
      )`
    );
    await sql`
      INSERT INTO app.story_relevance_answer_cache (
        owner_user_id,
        story_ref,
        rule_id,
        rule_text_hash,
        model_fingerprint,
        answer,
        confidence,
        expires_at
      )
      VALUES ${sql.join(rows, sql`, `)}
      ON CONFLICT (owner_user_id, story_ref, rule_id, rule_text_hash, model_fingerprint)
      DO UPDATE SET answer = EXCLUDED.answer,
                    confidence = EXCLUDED.confidence,
                    expires_at = EXCLUDED.expires_at,
                    updated_at = now()
    `.execute(scopedDb.db);
  }

  /**
   * #2636: drops a rule's remembered answers. Called when the rule is edited, taken back or
   * replaced. Owner-scoped so one person's rule edit can never touch another person's rows.
   */
  async deleteStoryRelevanceAnswersForRule(
    scopedDb: DataContextDb,
    ownerUserId: string,
    ruleId: string
  ): Promise<void> {
    assertDataContextDb(scopedDb);
    await sql`
      DELETE FROM app.story_relevance_answer_cache
      WHERE owner_user_id = ${ownerUserId}::uuid
        AND rule_id = ${ruleId}::uuid
    `.execute(scopedDb.db);
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

  async upsertTarget(scopedDb: DataContextDb, input: UpsertTargetInput): Promise<void> {
    await this.upsertTargets(scopedDb, [input]);
  }

  /**
   * Records many targets in one statement. A module that composes a page live registers every
   * story that page shows on every request, which is easily a hundred rows once each story is
   * registered for more than one surface; one row at a time would be a hundred round-trips per
   * page load (#2019).
   *
   * Identical in every other respect to a single upsert, including the bounding of story
   * metadata, so the two paths cannot drift apart.
   */
  async upsertTargets(
    scopedDb: DataContextDb,
    inputs: readonly UpsertTargetInput[]
  ): Promise<void> {
    assertDataContextDb(scopedDb);
    if (inputs.length === 0) return;
    const rows = inputs.map((input) => {
      // Story targets are bounded on the way in, not just on the way out. The read path cleans
      // too, but a module registering a story must not be able to park anything wider than the
      // agreed shape in the row. Briefing targets keep their existing block-list behaviour.
      const metadata = isStoryTargetKind(input.targetKind)
        ? sanitizeStoryTargetMetadata(input.metadata)
        : (input.metadata ?? {});
      return sql`(
        ${input.ownerUserId}::uuid,
        ${input.targetKind},
        ${input.targetRef},
        ${input.surface},
        ${input.sourceKind ?? null},
        ${input.sourceLabel ?? null},
        ${input.priorityBand ?? null},
        ${JSON.stringify(metadata)}::jsonb,
        now()
      )`;
    });
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
      VALUES ${sql.join(rows, sql`, `)}
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
    // #2636: a story rule that has just been taken back leaves no rule behind to key an answer to.
    if (updated) await this.deleteStoryRelevanceAnswersForRule(scopedDb, ownerUserId, id);
    return updated ? { feedback: updated, changed: true } : undefined;
  }
}
