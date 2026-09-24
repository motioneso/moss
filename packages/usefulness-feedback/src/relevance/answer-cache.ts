import { createHash } from "node:crypto";

import type { DataContextDb } from "@moss/db";
import type { StoryRelevanceRule } from "@moss/shared";

/**
 * #2636: the shape of a remembered sorting answer, and the keys that make it safe to reuse.
 *
 * The key carries only opaque references and hashes. The story reference is the matcher's own
 * hash of a canonical link; the rule is its id plus a hash of its terms and reason text; the
 * model is a hash of its provider kind and id. An edited rule or a switched model changes the
 * key, so a stale answer is simply never found. Nothing here stores a prompt or story text.
 */

/** Answers older than this are read as a miss and replaced. */
export const STORY_RELEVANCE_ANSWER_TTL_DAYS = 7;

export interface StoryRelevanceAnswerKey {
  readonly storyRef: string;
  readonly ruleId: string;
  readonly ruleTextHash: string;
  readonly modelFingerprint: string;
}

/** The two things the model told us: the verdict and how sure it was. */
export interface StoryRelevanceAskedAnswer {
  readonly answer: "yes" | "no";
  readonly confidence: number;
}

export interface StoryRelevanceStoredAnswer
  extends StoryRelevanceAnswerKey, StoryRelevanceAskedAnswer {
  readonly expiresAt: Date;
}

/**
 * The store the evaluator calls. The real one is the usefulness feedback repository; a unit test
 * passes a small in-memory stand-in. Owner is passed separately so the implementation can scope
 * every read and write to the caller's own rows.
 */
export interface StoryRelevanceAnswerCachePort {
  readStoryRelevanceAnswers(
    scopedDb: DataContextDb,
    ownerUserId: string,
    keys: readonly StoryRelevanceAnswerKey[]
  ): Promise<readonly StoryRelevanceStoredAnswer[]>;
  writeStoryRelevanceAnswers(
    scopedDb: DataContextDb,
    ownerUserId: string,
    answers: readonly (StoryRelevanceAnswerKey & StoryRelevanceAskedAnswer)[]
  ): Promise<void>;
}

/**
 * The rule's own text, hashed. The model sees the compiled terms and the owner's reason, so both
 * go in: a change to either must make the old answer unusable.
 */
export function storyRelevanceRuleTextHash(
  rule: StoryRelevanceRule,
  reasonText: string | null
): string {
  return createHash("sha256")
    .update(JSON.stringify({ terms: rule.terms, reason: reasonText ?? null }))
    .digest("hex");
}

/**
 * One unambiguous string for a key, used to line a stored row back up with the pair it answers.
 * The story reference never contains a NUL, so the pieces cannot run together.
 */
export function storyRelevanceAnswerKeyId(key: StoryRelevanceAnswerKey): string {
  return [key.storyRef, key.ruleId, key.ruleTextHash, key.modelFingerprint].join("\u0000");
}
