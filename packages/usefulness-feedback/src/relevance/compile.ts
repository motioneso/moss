import {
  MAX_STORY_RULE_TERMS,
  STORY_RELEVANCE_RULE_VERSION,
  isStoryRelevanceRule,
  type StoryFeedbackModule,
  type StoryRelevanceDirection,
  type StoryRelevanceRule
} from "@moss/shared";

/**
 * Turns a saved story preference into a small, versioned rule.
 *
 * This is deliberately pure and involves no model call, so it can run inside the save request
 * without making saving slow or able to fail. The model is used for one thing only: judging
 * candidate stories later.
 *
 * The rule never stores a copy of the owner's reason. It stores derived subject terms, and those
 * terms are treated with exactly the same care as the reason itself - never logged, never in a
 * metric, never in a job payload. The reason keeps the one home #2016 gave it, its own column, and
 * is read from there at evaluation time.
 */

export interface CompileStoryRelevanceRuleInput {
  readonly moduleId: StoryFeedbackModule;
  readonly direction: StoryRelevanceDirection;
  readonly storyRef: string;
  /** The allow-listed, already verified story context stored on the row. */
  readonly context: Record<string, unknown>;
  readonly reasonText?: string | null;
}

const MIN_TERM_LENGTH = 2;
const MAX_TERM_LENGTH = 40;

/**
 * Ordinary English scaffolding that says nothing about a subject. Kept short on purpose: a long
 * stop-word list starts throwing away real subjects, and the terms are only ever a hint for the
 * evaluator, never the judgment.
 */
const FILLER_WORDS: ReadonlySet<string> = new Set([
  "about",
  "all",
  "and",
  "any",
  "are",
  "but",
  "dont",
  "for",
  "from",
  "get",
  "has",
  "have",
  "his",
  "her",
  "its",
  "just",
  "like",
  "more",
  "much",
  "not",
  "now",
  "of",
  "on",
  "one",
  "only",
  "or",
  "other",
  "our",
  "out",
  "over",
  "please",
  "really",
  "see",
  "should",
  "showing",
  "so",
  "some",
  "stop",
  "such",
  "than",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "too",
  "very",
  "want",
  "was",
  "were",
  "what",
  "when",
  "which",
  "who",
  "why",
  "with",
  "would",
  "you",
  "your"
]);

export function compileStoryRelevanceRule(
  input: CompileStoryRelevanceRuleInput
): StoryRelevanceRule {
  const terms: string[] = [];
  // Stable identifiers first: a club or topic id does not drift, a display name does.
  for (const key of input.moduleId === "sports"
    ? (["teamRef", "competitionRef"] as const)
    : (["topicRef"] as const)) {
    addTerm(terms, input.context[key]);
  }
  // A "more like this" preference has no reason, so its terms come from the record alone.
  for (const word of reasonTerms(input.reasonText)) {
    if (terms.length >= MAX_STORY_RULE_TERMS) break;
    addTerm(terms, word);
  }
  return {
    version: STORY_RELEVANCE_RULE_VERSION,
    module: input.moduleId,
    direction: input.direction,
    storyRef: input.storyRef,
    terms: terms.slice(0, MAX_STORY_RULE_TERMS)
  };
}

/**
 * True when a stored rule cannot be trusted to describe the preference any more: it is missing, it
 * is the empty object every row saved before this change carries, it is malformed, or it was built
 * by an older version. Such a row is rebuilt on read and written back.
 */
export function storyRelevanceRuleNeedsRecompile(value: unknown, version: number | null): boolean {
  if (version === null || version < STORY_RELEVANCE_RULE_VERSION) return true;
  if (!isStoryRelevanceRule(value)) return true;
  return value.version < STORY_RELEVANCE_RULE_VERSION;
}

function addTerm(terms: string[], value: unknown): void {
  if (typeof value !== "string") return;
  const term = value.trim().toLowerCase();
  if (term.length < MIN_TERM_LENGTH || term.length > MAX_TERM_LENGTH) return;
  if (terms.includes(term)) return;
  terms.push(term);
}

function reasonTerms(reasonText: string | null | undefined): string[] {
  if (typeof reasonText !== "string") return [];
  const words: string[] = [];
  for (const raw of reasonText.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < MIN_TERM_LENGTH || raw.length > MAX_TERM_LENGTH) continue;
    if (FILLER_WORDS.has(raw) || words.includes(raw)) continue;
    words.push(raw);
  }
  return words;
}
