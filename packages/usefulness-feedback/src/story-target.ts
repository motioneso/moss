import { createHash } from "node:crypto";

import type { FeedbackTargetKind, StoryFeedbackModule } from "@moss/shared";

/**
 * Stable, opaque identity for a News or Sports story, plus the bounded context a story target row
 * is allowed to carry.
 *
 * The identifier is a hash of the module id and the story's canonical link. Raw links and article
 * text are never used as an identifier and never stored as one: a target reference travels through
 * request bodies, logs and the owner's export, and a readable link there would leak reading habits
 * far beyond the feedback feature. This lives in the feedback package rather than `@moss/shared`
 * because the browser bundle imports `@moss/shared` and Node-only imports there have broken it
 * before.
 */

const HASH_LENGTH = 32;

export const STORY_TARGET_KIND_BY_MODULE: Readonly<
  Record<StoryFeedbackModule, Extract<FeedbackTargetKind, "news_story" | "sports_story">>
> = {
  news: "news_story",
  sports: "sports_story"
};

export const STORY_TARGET_KINDS: ReadonlySet<FeedbackTargetKind> = new Set<FeedbackTargetKind>([
  "news_story",
  "sports_story"
]);

export function isStoryTargetKind(targetKind: FeedbackTargetKind): boolean {
  return STORY_TARGET_KINDS.has(targetKind);
}

/** Turns a module id plus a story's canonical link into an opaque, repeatable reference. */
export function storyFeedbackTargetRef(
  moduleId: StoryFeedbackModule,
  canonicalLink: string
): string {
  const normalized = canonicalLink.trim().toLowerCase().replace(/\s+/g, "");
  if (normalized.length === 0) throw new Error("story feedback target needs a canonical link");
  const digest = createHash("sha256")
    .update([moduleId, normalized].join("|"))
    .digest("hex")
    .slice(0, HASH_LENGTH);
  return `${moduleId}:${digest}`;
}

export interface StoryTargetContextInput {
  readonly moduleId: StoryFeedbackModule;
  readonly headline?: string | null;
  readonly sourceLabel?: string | null;
  readonly publishedAt?: Date | string | null;
  readonly topicRef?: string | null;
  readonly teamRef?: string | null;
  readonly competitionRef?: string | null;
  readonly hasEditorialEvidence?: boolean | null;
  readonly isOpinion?: boolean | null;
}

const MAX_HEADLINE_LENGTH = 200;
const MAX_LABEL_LENGTH = 80;
const MAX_REF_LENGTH = 120;

/**
 * The only shape a story target row may carry. Everything else about a story stays in the owning
 * module. Key names are chosen to survive `sanitizeFeedbackMetadata`, which silently drops keys
 * that look like `externalId`, `summary`, `raw` and friends: `topicRef` survives, `externalId`
 * would vanish without warning.
 */
export function buildStoryTargetContext(input: StoryTargetContextInput): Record<string, unknown> {
  const context: Record<string, unknown> = { module: input.moduleId };
  const headline = boundedText(input.headline, MAX_HEADLINE_LENGTH);
  if (headline) context.headline = headline;
  const sourceLabel = boundedText(input.sourceLabel, MAX_LABEL_LENGTH);
  if (sourceLabel) context.sourceLabel = sourceLabel;
  const publishedAt = isoTime(input.publishedAt);
  if (publishedAt) context.publishedAt = publishedAt;
  const topicRef = boundedText(input.topicRef, MAX_REF_LENGTH);
  if (topicRef) context.topicRef = topicRef;
  const teamRef = boundedText(input.teamRef, MAX_REF_LENGTH);
  if (teamRef) context.teamRef = teamRef;
  const competitionRef = boundedText(input.competitionRef, MAX_REF_LENGTH);
  if (competitionRef) context.competitionRef = competitionRef;
  if (typeof input.hasEditorialEvidence === "boolean") {
    context.hasEditorialEvidence = input.hasEditorialEvidence;
  }
  if (typeof input.isOpinion === "boolean") context.isOpinion = input.isOpinion;
  return context;
}

const STORY_CONTEXT_KEYS: ReadonlySet<string> = new Set([
  "module",
  "headline",
  "sourceLabel",
  "publishedAt",
  "topicRef",
  "teamRef",
  "competitionRef",
  "hasEditorialEvidence",
  "isOpinion"
]);

/**
 * Allow-list cleaner for story target metadata. Deliberately narrower than
 * `sanitizeFeedbackMetadata`, which is a block-list: an unknown key on a story target is dropped
 * rather than trusted. Only applied on the story path — briefing targets keep their existing
 * merging behaviour, which a test depends on.
 */
export function sanitizeStoryTargetMetadata(
  input: Record<string, unknown> | undefined
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input ?? {})) {
    if (!STORY_CONTEXT_KEYS.has(key)) continue;
    if (typeof value === "boolean") {
      output[key] = value;
      continue;
    }
    const text = boundedText(value, MAX_HEADLINE_LENGTH);
    if (text) output[key] = text;
  }
  return output;
}

function boundedText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed.length > 0 ? trimmed.slice(0, maxLength) : null;
}

function isoTime(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
