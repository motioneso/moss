import type { DataContextDb } from "@moss/db";
import {
  decideStoryRelevance,
  degradedStoryRelevance,
  type StoryFeedbackModule,
  type StoryRelevanceCandidate,
  type StoryRelevanceResult
} from "@moss/shared";

import type { UsefulnessFeedbackRepository } from "../repository.js";

import { evaluateStoryRelevance, type StoryRelevanceAiPort } from "./evaluator.js";

/**
 * The one thing News and Sports call. It reads the owner's saved preferences, asks the evaluator
 * for evidence, and then lets our own pure code decide what survives.
 *
 * Deliberately not registered in the module registry here: #2018 and #2019 attach it with their own
 * model binding, exactly as #2016 left the "story preference changed" callback unwired.
 */

/** Counts and names only. Never a reason, a term, a headline, a link or a story reference. */
export interface StoryRelevanceLogger {
  info(fields: Record<string, unknown>): void;
  warn?(fields: Record<string, unknown>): void;
}

export type StoryRelevancePolicy = (
  scopedDb: DataContextDb,
  input: {
    readonly ownerUserId: string;
    readonly moduleId: StoryFeedbackModule;
    readonly candidates: readonly StoryRelevanceCandidate[];
    readonly now: Date;
  }
) => Promise<StoryRelevanceResult>;

export function createStoryRelevancePolicy(deps: {
  readonly ai: StoryRelevanceAiPort;
  readonly repository: Pick<UsefulnessFeedbackRepository, "listActiveStoryRules">;
  readonly logger: StoryRelevanceLogger;
}): StoryRelevancePolicy {
  return async (scopedDb, input) => {
    const startedAt = Date.now();
    const ruleRows = await deps.repository.listActiveStoryRules(
      scopedDb,
      input.ownerUserId,
      input.moduleId
    );

    // The common case: nobody has told this module to show them less of anything, so there is
    // nothing to judge and no model call is made at all.
    if (ruleRows.length === 0) {
      return {
        status: "applied",
        kept: [...input.candidates],
        boosts: [],
        suppressedCount: 0,
        overriddenCount: 0
      };
    }

    const rules = ruleRows.map((row) => row.rule);
    const evaluated = await evaluateStoryRelevance(
      scopedDb,
      { ai: deps.ai },
      { candidates: input.candidates, rules: ruleRows }
    );

    if (!evaluated.ok) {
      const degraded = degradedStoryRelevance(evaluated.error, input.candidates, rules);
      deps.logger.warn?.({
        event: "story_relevance_degraded",
        module: input.moduleId,
        failure: evaluated.error,
        activeRules: ruleRows.length,
        candidates: input.candidates.length,
        excluded: degraded.excludedRefs.length,
        kept: degraded.kept.length,
        durationMs: Date.now() - startedAt
      });
      return degraded;
    }

    const decided = decideStoryRelevance({
      candidates: input.candidates,
      rules,
      verdicts: evaluated.verdicts,
      now: input.now
    });
    deps.logger.info({
      event: "story_relevance_applied",
      module: input.moduleId,
      activeRules: ruleRows.length,
      candidates: input.candidates.length,
      suppressed: decided.suppressedCount,
      overridden: decided.overriddenCount,
      boosted: decided.boosts.length,
      kept: decided.kept.length,
      durationMs: Date.now() - startedAt
    });
    return decided;
  };
}
