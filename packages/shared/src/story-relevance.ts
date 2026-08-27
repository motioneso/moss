import type { StoryFeedbackModule } from "./usefulness-feedback-api.js";

/**
 * The neutral decision layer between a saved story preference and a list of candidate stories.
 *
 * Everything here is pure and clock-free: the current time is passed in, never read, which is the
 * house style for ranking code and the only way these decisions stay reproducible in a test. This
 * file lives in the shared package because News, Sports and the feedback module all speak it, and
 * the browser bundle imports this package, so there are deliberately no `node:` imports here.
 *
 * The division of labour is the security property worth stating plainly: a model may only report
 * evidence drawn from two closed lists. It never decides an outcome. Our own code decides that a
 * story matching a "less like this" preference survives only when it carries both a real event
 * reason and a real editorial reason, and that the owner's own dismissal beats every override.
 */

export const STORY_RELEVANCE_RULE_VERSION = 1;
export const MAX_STORY_RULE_TERMS = 8;
export const STORY_RELEVANCE_BOOST = 1;
export const MAX_BOOSTED_PER_SUBJECT = 2;
export const MAX_STORY_RELEVANCE_VERDICTS = 200;
export const MAX_STORY_RELEVANCE_PROMPT_CHARS = 20_000;

export type StoryRelevanceDirection = "less" | "more";

/** The only description of a story this layer ever sees. Article bodies are never part of it. */
export interface StoryRelevanceCandidate {
  readonly storyRef: string;
  readonly headline: string;
  readonly sourceLabel: string;
  readonly publishedAt: string;
  readonly feedPosition: number;
  readonly topicRef?: string | null;
  readonly teamRef?: string | null;
  readonly competitionRef?: string | null;
  readonly isOpinion?: boolean;
}

/**
 * A compiled preference. It carries derived subject terms and never a copy of the owner's reason:
 * the reason has exactly one home, its own column, and these terms are treated with the same care.
 */
export interface StoryRelevanceRule {
  readonly version: number;
  readonly module: StoryFeedbackModule;
  readonly direction: StoryRelevanceDirection;
  readonly storyRef: string;
  readonly terms: readonly string[];
}

/** Something consequential actually happened. Nothing outside this list counts. */
export const STORY_EVENT_EVIDENCE_CODES = [
  "public_safety_threat",
  "terrorism_or_mass_casualty",
  "major_natural_disaster",
  "war_escalation",
  "consequential_civic_event",
  "championship_outcome",
  "historic_record",
  "sports_death_or_crisis"
] as const;

/** Someone editorially independent treated it as important. Nothing outside this list counts. */
export const STORY_EDITORIAL_EVIDENCE_CODES = [
  "source_lead_position",
  "event_stage_metadata",
  "cross_publisher_coverage"
] as const;

export type StoryEventEvidenceCode = (typeof STORY_EVENT_EVIDENCE_CODES)[number];
export type StoryEditorialEvidenceCode = (typeof STORY_EDITORIAL_EVIDENCE_CODES)[number];

const EVENT_CODES: ReadonlySet<string> = new Set(STORY_EVENT_EVIDENCE_CODES);
const EDITORIAL_CODES: ReadonlySet<string> = new Set(STORY_EDITORIAL_EVIDENCE_CODES);

export interface StoryRelevanceVerdict {
  readonly storyRef: string;
  readonly matched: boolean;
  readonly ruleStoryRef: string | null;
  readonly eventEvidence: readonly StoryEventEvidenceCode[];
  readonly editorialEvidence: readonly StoryEditorialEvidenceCode[];
}

export type StoryRelevanceFailure =
  | "needs_config"
  | "validation_failed"
  | "provider_error"
  | "aborted"
  | "malformed_output";

export interface StoryRelevanceBoost {
  readonly storyRef: string;
  readonly lift: number;
}

export interface StoryRelevanceApplied {
  readonly status: "applied";
  readonly kept: readonly StoryRelevanceCandidate[];
  readonly boosts: readonly StoryRelevanceBoost[];
  readonly suppressedCount: number;
  readonly overriddenCount: number;
}

/**
 * What the caller gets when the evaluator could not be trusted. The exact exclusions are still
 * honoured because they are deterministic and owe nothing to a model; everything else is kept, so a
 * retry loses no story and no half-filtered set is ever published.
 */
export interface StoryRelevanceDegraded {
  readonly status: "degraded";
  readonly failure: StoryRelevanceFailure;
  readonly excludedRefs: readonly string[];
  readonly kept: readonly StoryRelevanceCandidate[];
}

export type StoryRelevanceResult = StoryRelevanceApplied | StoryRelevanceDegraded;

const verdictItemSchema = {
  type: "object",
  additionalProperties: false,
  required: ["storyRef", "matched", "ruleStoryRef", "eventEvidence", "editorialEvidence"],
  properties: {
    storyRef: { type: "string" },
    matched: { type: "boolean" },
    ruleStoryRef: { type: ["string", "null"] },
    eventEvidence: {
      type: "array",
      maxItems: STORY_EVENT_EVIDENCE_CODES.length,
      items: { type: "string", enum: [...STORY_EVENT_EVIDENCE_CODES] }
    },
    editorialEvidence: {
      type: "array",
      maxItems: STORY_EDITORIAL_EVIDENCE_CODES.length,
      items: { type: "string", enum: [...STORY_EDITORIAL_EVIDENCE_CODES] }
    }
  }
} as const;

/** Bounded the way the News ranking schema is bounded: fixed shape, no room for extra keys. */
export const storyRelevanceResponseSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["verdicts"],
  properties: {
    verdicts: {
      type: "array",
      maxItems: MAX_STORY_RELEVANCE_VERDICTS,
      items: verdictItemSchema
    }
  }
};

const VERDICT_KEYS: ReadonlySet<string> = new Set([
  "storyRef",
  "matched",
  "ruleStoryRef",
  "eventEvidence",
  "editorialEvidence"
]);

export function isStoryRelevanceRule(value: unknown): value is StoryRelevanceRule {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const rule = value as Record<string, unknown>;
  return (
    typeof rule.version === "number" &&
    (rule.module === "news" || rule.module === "sports") &&
    (rule.direction === "less" || rule.direction === "more") &&
    typeof rule.storyRef === "string" &&
    rule.storyRef.length > 0 &&
    Array.isArray(rule.terms) &&
    rule.terms.every((term) => typeof term === "string")
  );
}

/**
 * The stories the owner rejected outright. These come out of the list whatever the evaluator says,
 * so they are computed before any model call and re-used when one fails.
 */
export function excludedStoryRefs(rules: readonly StoryRelevanceRule[]): ReadonlySet<string> {
  const refs = new Set<string>();
  for (const rule of rules) {
    if (rule.direction === "less") refs.add(rule.storyRef);
  }
  return refs;
}

/**
 * Reads the evaluator's answer strictly. Anything unexpected makes the whole response a failure
 * rather than a partial answer: an unknown key, a story nobody asked about, or the same story
 * twice. Unrecognised evidence names are dropped rather than rejected, because a model naming a
 * reason we do not have simply contributes nothing.
 */
export function parseStoryRelevanceVerdicts(
  object: unknown,
  candidateRefs: ReadonlySet<string>
): StoryRelevanceVerdict[] | null {
  if (!object || typeof object !== "object" || Array.isArray(object)) return null;
  const record = object as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !Array.isArray(record.verdicts)) return null;
  if (record.verdicts.length > MAX_STORY_RELEVANCE_VERDICTS) return null;

  const seen = new Set<string>();
  const verdicts: StoryRelevanceVerdict[] = [];
  for (const value of record.verdicts) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    if (Object.keys(row).some((key) => !VERDICT_KEYS.has(key))) return null;
    if (typeof row.storyRef !== "string" || !candidateRefs.has(row.storyRef)) return null;
    if (seen.has(row.storyRef)) return null;
    if (typeof row.matched !== "boolean") return null;
    if (row.ruleStoryRef !== null && typeof row.ruleStoryRef !== "string") return null;
    if (!Array.isArray(row.eventEvidence) || !Array.isArray(row.editorialEvidence)) return null;
    seen.add(row.storyRef);
    verdicts.push({
      storyRef: row.storyRef,
      matched: row.matched,
      ruleStoryRef: row.ruleStoryRef,
      eventEvidence: keepKnown(row.eventEvidence, EVENT_CODES) as StoryEventEvidenceCode[],
      editorialEvidence: keepKnown(
        row.editorialEvidence,
        EDITORIAL_CODES
      ) as StoryEditorialEvidenceCode[]
    });
  }
  return verdicts;
}

function keepKnown(values: readonly unknown[], allowed: ReadonlySet<string>): string[] {
  const kept: string[] = [];
  for (const value of values) {
    if (typeof value !== "string" || !allowed.has(value) || kept.includes(value)) continue;
    kept.push(value);
  }
  return kept;
}

/**
 * Decides what survives. Ordering of the kept list is the caller's own feed order, untouched: this
 * layer removes and nudges, it does not re-rank.
 */
export function decideStoryRelevance(input: {
  readonly candidates: readonly StoryRelevanceCandidate[];
  readonly rules: readonly StoryRelevanceRule[];
  readonly verdicts: readonly StoryRelevanceVerdict[];
  readonly now: Date;
}): StoryRelevanceApplied {
  const excluded = excludedStoryRefs(input.rules);
  const negativeRuleRefs = new Set<string>();
  const positiveRuleRefs = new Set<string>();
  for (const rule of input.rules) {
    if (rule.direction === "less") negativeRuleRefs.add(rule.storyRef);
    else positiveRuleRefs.add(rule.storyRef);
  }
  const verdictByRef = new Map(input.verdicts.map((verdict) => [verdict.storyRef, verdict]));

  const kept: StoryRelevanceCandidate[] = [];
  const liftable = new Map<string, StoryRelevanceCandidate[]>();
  let suppressedCount = 0;
  let overriddenCount = 0;

  for (const candidate of input.candidates) {
    // The owner's own dismissal comes first and cannot be argued with.
    if (excluded.has(candidate.storyRef)) {
      suppressedCount += 1;
      continue;
    }
    const verdict = verdictByRef.get(candidate.storyRef);
    const matchedRule = verdict?.matched === true ? (verdict.ruleStoryRef ?? null) : null;

    if (matchedRule !== null && negativeRuleRefs.has(matchedRule)) {
      if (isExceptional(candidate, verdict)) {
        overriddenCount += 1;
        kept.push(candidate);
      } else {
        suppressedCount += 1;
      }
      continue;
    }

    kept.push(candidate);
    if (matchedRule !== null && positiveRuleRefs.has(matchedRule)) {
      const forRule = liftable.get(matchedRule) ?? [];
      forRule.push(candidate);
      liftable.set(matchedRule, forRule);
    }
  }

  return {
    status: "applied",
    kept,
    boosts: boundedBoosts(liftable, input.now),
    suppressedCount,
    overriddenCount
  };
}

/**
 * A matching story survives only with both kinds of reason. Editorial attention on its own is how a
 * front page would defeat the preference; an event code on its own is how a single wire alert
 * would. An opinion piece never survives, and that is read from the record, not from the model.
 */
function isExceptional(
  candidate: StoryRelevanceCandidate,
  verdict: StoryRelevanceVerdict | undefined
): boolean {
  if (candidate.isOpinion === true) return false;
  if (!verdict) return false;
  return verdict.eventEvidence.length > 0 && verdict.editorialEvidence.length > 0;
}

/**
 * A small fixed lift, for kept stories only, capped per preference so one subject cannot take over
 * the feed. When more stories qualify than there are slots, the newest wins; the passed-in time is
 * what makes "newest" judgeable without reading a clock, and feed position settles a tie.
 */
function boundedBoosts(
  liftable: ReadonlyMap<string, StoryRelevanceCandidate[]>,
  now: Date
): StoryRelevanceBoost[] {
  const boosts: StoryRelevanceBoost[] = [];
  for (const candidates of liftable.values()) {
    const ordered = [...candidates].sort(
      (left, right) => ageMillis(left, now) - ageMillis(right, now) ||
        left.feedPosition - right.feedPosition
    );
    for (const candidate of ordered.slice(0, MAX_BOOSTED_PER_SUBJECT)) {
      boosts.push({ storyRef: candidate.storyRef, lift: STORY_RELEVANCE_BOOST });
    }
  }
  return boosts;
}

function ageMillis(candidate: StoryRelevanceCandidate, now: Date): number {
  const published = Date.parse(candidate.publishedAt);
  return Number.isNaN(published) ? Number.MAX_SAFE_INTEGER : now.getTime() - published;
}

/** The honest answer when the evaluator failed: exact exclusions only, nothing on guesswork. */
export function degradedStoryRelevance(
  failure: StoryRelevanceFailure,
  candidates: readonly StoryRelevanceCandidate[],
  rules: readonly StoryRelevanceRule[]
): StoryRelevanceDegraded {
  const excluded = excludedStoryRefs(rules);
  return {
    status: "degraded",
    failure,
    excludedRefs: [...excluded],
    kept: candidates.filter((candidate) => !excluded.has(candidate.storyRef))
  };
}
