import { HttpError } from "@moss/module-sdk";
import {
  STORY_FEEDBACK_REASON_MAX_LENGTH,
  type CreateUsefulnessFeedbackRequest,
  type FeedbackStatus,
  type FeedbackSurface,
  type FeedbackTargetKind,
  type ListUsefulnessFeedbackQuery,
  type StoryFeedbackModule,
  type UsefulnessFeedbackKind
} from "@moss/shared";

import { STORY_TARGET_KIND_BY_MODULE } from "./story-target.js";

const INVALID = "Usefulness feedback request is invalid";

const FEEDBACK_TARGET_KINDS = new Set<FeedbackTargetKind>([
  "chat_message",
  "briefing_run",
  "briefing_item",
  "proactive_card",
  "news_story",
  "sports_story"
]);
const FEEDBACK_SURFACES = new Set<FeedbackSurface>([
  "chat",
  "briefing",
  "today",
  "proactive",
  "news",
  "sports"
]);
const FEEDBACK_KINDS = new Set<UsefulnessFeedbackKind>([
  "more_like_this",
  "less_like_this",
  "too_much",
  "wrong_priority",
  "not_useful",
  "remember_this",
  "dismiss"
]);
const FEEDBACK_STATUSES = new Set<FeedbackStatus>(["active", "undone", "superseded"]);
const STORY_MODULES = new Set<StoryFeedbackModule>(["news", "sports"]);

const REQUIRED_CREATE_KEYS = ["kind", "surface", "targetKind", "targetRef"] as const;
const OPTIONAL_CREATE_KEYS = ["reason"] as const;

export function parseCreateBody(body: unknown): CreateUsefulnessFeedbackRequest {
  const value = asObject(body);

  // Every required key must be present and nothing outside the known set may be, so a caller
  // cannot smuggle an extra field past the hand-written parser.
  for (const key of REQUIRED_CREATE_KEYS) {
    if (!Object.hasOwn(value, key)) throw new HttpError(400, INVALID);
  }
  const allowed = new Set<string>([...REQUIRED_CREATE_KEYS, ...OPTIONAL_CREATE_KEYS]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new HttpError(400, INVALID);
  }

  if (
    typeof value.targetRef !== "string" ||
    value.targetRef.length < 1 ||
    value.targetRef.length > 1024
  ) {
    throw new HttpError(400, INVALID);
  }
  if (
    typeof value.targetKind !== "string" ||
    !FEEDBACK_TARGET_KINDS.has(value.targetKind as FeedbackTargetKind)
  ) {
    throw new HttpError(400, INVALID);
  }
  if (
    typeof value.surface !== "string" ||
    !FEEDBACK_SURFACES.has(value.surface as FeedbackSurface)
  ) {
    throw new HttpError(400, INVALID);
  }
  if (typeof value.kind !== "string" || !FEEDBACK_KINDS.has(value.kind as UsefulnessFeedbackKind)) {
    throw new HttpError(400, INVALID);
  }

  const kind = value.kind as UsefulnessFeedbackKind;
  const reason = parseReasonForKind(value.reason, kind);

  return {
    targetKind: value.targetKind as FeedbackTargetKind,
    targetRef: value.targetRef,
    surface: value.surface as FeedbackSurface,
    kind,
    ...(reason === null ? {} : { reason })
  };
}

/** The reason body of the edit route. Only a reason may be sent. */
export function parseReasonBody(body: unknown): string {
  const value = asObject(body);
  if (Object.keys(value).length !== 1 || !Object.hasOwn(value, "reason")) {
    throw new HttpError(400, INVALID);
  }
  return normalizeReason(value.reason);
}

export function parseListQuery(query: unknown): {
  readonly targetKinds?: readonly FeedbackTargetKind[];
  readonly status?: FeedbackStatus;
} {
  if (query === undefined || query === null) return {};
  const value = asObject(query);
  for (const key of Object.keys(value)) {
    if (key !== "module" && key !== "status") throw new HttpError(400, INVALID);
  }

  const parsed: ListUsefulnessFeedbackQuery = {
    ...(value.module === undefined ? {} : { module: asStoryModule(value.module) }),
    ...(value.status === undefined ? {} : { status: asStatus(value.status) })
  };

  return {
    ...(parsed.module === undefined
      ? {}
      : { targetKinds: [STORY_TARGET_KIND_BY_MODULE[parsed.module]] }),
    ...(parsed.status === undefined ? {} : { status: parsed.status })
  };
}

function parseReasonForKind(raw: unknown, kind: UsefulnessFeedbackKind): string | null {
  if (kind === "less_like_this") {
    if (raw === undefined) throw new HttpError(400, "Less like this needs a reason");
    return normalizeReason(raw);
  }
  // A reason is a standing preference, so it only makes sense alongside "Less like this".
  if (raw !== undefined) throw new HttpError(400, "This feedback action does not take a reason");
  return null;
}

/**
 * Trims the ends and nothing else. Internal spacing is left exactly as typed so the person who
 * wrote the reason sees their own words back; the "remember this" path collapses whitespace, and
 * copying that here would quietly rewrite the user's text.
 */
function normalizeReason(raw: unknown): string {
  if (typeof raw !== "string") throw new HttpError(400, INVALID);
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new HttpError(400, "A reason cannot be empty");
  if (trimmed.length > STORY_FEEDBACK_REASON_MAX_LENGTH) {
    throw new HttpError(
      400,
      `A reason cannot be longer than ${STORY_FEEDBACK_REASON_MAX_LENGTH} characters`
    );
  }
  return trimmed;
}

function asStoryModule(raw: unknown): StoryFeedbackModule {
  if (typeof raw !== "string" || !STORY_MODULES.has(raw as StoryFeedbackModule)) {
    throw new HttpError(400, INVALID);
  }
  return raw as StoryFeedbackModule;
}

function asStatus(raw: unknown): FeedbackStatus {
  if (typeof raw !== "string" || !FEEDBACK_STATUSES.has(raw as FeedbackStatus)) {
    throw new HttpError(400, INVALID);
  }
  return raw as FeedbackStatus;
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, INVALID);
  }
  return value as Record<string, unknown>;
}
