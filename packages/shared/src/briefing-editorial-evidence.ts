// packages/shared/src/briefing-editorial-evidence.ts — BROWSER-SAFE. No node:* imports.
//
// Typed, validated evidence blocks for the morning briefing's News and Sports
// sections (T10). The prompt receives only sanitized fact lines; these blocks
// travel through tool `metaKeys` into `sourceMetadata.editorial` for widgets.

import { localDay } from "./time.js";
import type { GameSummary } from "./sports-api.js";

export const SPORTS_EVIDENCE_GAMES_MAX = 8;
export const SPORTS_EVIDENCE_STORIES_PER_TEAM_MAX = 3;
export const SPORTS_EVIDENCE_STORIES_TOTAL_MAX = 6;
export const NEWS_EVIDENCE_STORIES_MAX = 5;
export const NEWS_EVIDENCE_SUMMARY_MAX = 240;

export type SportsBriefingGamePhase = "final" | "live" | "tonight" | "postponed" | "upcoming";
export type SportsBriefingState = "live" | "tonight" | "finals" | "quiet" | "unknown";

const POSTPONED_PATTERN = /postpon|ppd|cancel/i;

function isValidZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
    return true;
  } catch {
    return false;
  }
}

/**
 * One game's local-day phase from the actor's time zone and instants (T10, moved to
 * `@moss/shared` in T11 so the owning Today widgets can reuse it in the browser without
 * pulling the sports service's server-only imports into the web bundle).
 */
export function deriveGamePhase(
  game: Pick<GameSummary, "state" | "statusDetail" | "startsAt">,
  now: Date,
  timeZone: string
): SportsBriefingGamePhase {
  if (POSTPONED_PATTERN.test(game.statusDetail ?? "")) return "postponed";
  if (game.state === "live") return "live";
  if (game.state === "final") return "final";
  const zone = isValidZone(timeZone) ? timeZone : "UTC";
  const startsAt = new Date(game.startsAt);
  if (Number.isNaN(startsAt.getTime())) return "upcoming";
  if (localDay(startsAt, zone) === localDay(now, zone) && startsAt.getTime() > now.getTime()) {
    return "tonight";
  }
  return "upcoming";
}

export interface SportsBriefingEvidenceGameV1 {
  readonly id: string;
  readonly competitionKey: string;
  readonly startsAt: string;
  readonly phase: SportsBriefingGamePhase;
  readonly statusDetail: string;
  readonly headline: string;
  readonly homeShort: string;
  readonly awayShort: string;
  readonly homeScore: number | null;
  readonly awayScore: number | null;
}

export interface SportsBriefingEvidenceStoryV1 {
  readonly teamKey: string | null;
  readonly competitionKey: string;
  readonly title: string;
  readonly url: string;
  readonly publishedAt: string;
  readonly imageUrl: string | null;
  readonly publisherLabel: string;
  readonly publisherDomain: string;
  readonly storyRef?: string;
}

export interface SportsBriefingEvidenceV1 {
  readonly version: 1;
  readonly capturedAt: string;
  readonly degraded: boolean;
  readonly state: SportsBriefingState;
  readonly ambiguousFollowCount: number;
  readonly games: readonly SportsBriefingEvidenceGameV1[];
  readonly stories: readonly SportsBriefingEvidenceStoryV1[];
}

export interface NewsBriefingEvidenceStoryV1 {
  readonly id: string;
  readonly title: string;
  readonly sourceLabel: string;
  readonly sourceKey: string;
  readonly url: string;
  readonly publishedAt: string | null;
  readonly summary: string;
  readonly imageUrl: string | null;
  readonly feedbackRef?: string;
}

export interface NewsBriefingEvidenceV1 {
  readonly version: 1;
  readonly capturedAt: string;
  readonly degraded: boolean;
  readonly stories: readonly NewsBriefingEvidenceStoryV1[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoInstant(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function isBoundedString(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max;
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2000) return false;
  try {
    const protocol = new URL(value).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

const GAME_PHASES: readonly string[] = ["final", "live", "tonight", "postponed", "upcoming"];
const STATES: readonly string[] = ["live", "tonight", "finals", "quiet", "unknown"];

function isSportsGame(value: unknown): value is SportsBriefingEvidenceGameV1 {
  if (!isRecord(value)) return false;
  if (!isBoundedString(value.id, 1, 200)) return false;
  if (!isBoundedString(value.competitionKey, 1, 100)) return false;
  if (!isIsoInstant(value.startsAt)) return false;
  if (typeof value.phase !== "string" || !GAME_PHASES.includes(value.phase)) return false;
  if (typeof value.statusDetail !== "string" || value.statusDetail.length > 200) return false;
  if (typeof value.headline !== "string" || value.headline.length > 300) return false;
  if (typeof value.homeShort !== "string" || value.homeShort.length > 60) return false;
  if (typeof value.awayShort !== "string" || value.awayShort.length > 60) return false;
  for (const score of [value.homeScore, value.awayScore]) {
    if (
      score !== null &&
      (typeof score !== "number" || !Number.isInteger(score) || score < 0 || score > 300)
    )
      return false;
  }
  return true;
}

function isSportsStory(value: unknown): value is SportsBriefingEvidenceStoryV1 {
  if (!isRecord(value)) return false;
  if (value.teamKey !== null && !isBoundedString(value.teamKey, 1, 100)) return false;
  if (!isBoundedString(value.competitionKey, 1, 100)) return false;
  if (!isBoundedString(value.title, 1, 300)) return false;
  if (!isHttpUrl(value.url)) return false;
  if (!isIsoInstant(value.publishedAt)) return false;
  if (value.imageUrl !== null && !isBoundedString(value.imageUrl, 1, 2000)) return false;
  if (!isBoundedString(value.publisherLabel, 1, 200)) return false;
  if (!isBoundedString(value.publisherDomain, 1, 200)) return false;
  if (value.storyRef !== undefined && !isBoundedString(value.storyRef, 1, 300)) return false;
  return true;
}

export function isSportsBriefingEvidence(value: unknown): value is SportsBriefingEvidenceV1 {
  if (!isRecord(value)) return false;
  if (value.version !== 1) return false;
  if (!isIsoInstant(value.capturedAt)) return false;
  if (typeof value.degraded !== "boolean") return false;
  if (typeof value.state !== "string" || !STATES.includes(value.state)) return false;
  if (
    typeof value.ambiguousFollowCount !== "number" ||
    !Number.isInteger(value.ambiguousFollowCount) ||
    value.ambiguousFollowCount < 0 ||
    value.ambiguousFollowCount > 100
  )
    return false;
  if (!Array.isArray(value.games) || value.games.length > SPORTS_EVIDENCE_GAMES_MAX) return false;
  if (!Array.isArray(value.stories) || value.stories.length > SPORTS_EVIDENCE_STORIES_TOTAL_MAX)
    return false;
  return value.games.every(isSportsGame) && value.stories.every(isSportsStory);
}

function isNewsStory(value: unknown): value is NewsBriefingEvidenceStoryV1 {
  if (!isRecord(value)) return false;
  if (!isBoundedString(value.id, 1, 300)) return false;
  if (!isBoundedString(value.title, 1, 300)) return false;
  if (!isBoundedString(value.sourceLabel, 1, 200)) return false;
  if (!isBoundedString(value.sourceKey, 1, 200)) return false;
  if (!isHttpUrl(value.url)) return false;
  if (value.publishedAt !== null && !isIsoInstant(value.publishedAt)) return false;
  if (typeof value.summary !== "string" || value.summary.length > NEWS_EVIDENCE_SUMMARY_MAX)
    return false;
  if (value.imageUrl !== null && !isBoundedString(value.imageUrl, 1, 2000)) return false;
  if (value.feedbackRef !== undefined && !isBoundedString(value.feedbackRef, 1, 300)) return false;
  return true;
}

export function isNewsBriefingEvidence(value: unknown): value is NewsBriefingEvidenceV1 {
  if (!isRecord(value)) return false;
  if (value.version !== 1) return false;
  if (!isIsoInstant(value.capturedAt)) return false;
  if (typeof value.degraded !== "boolean") return false;
  if (!Array.isArray(value.stories) || value.stories.length > NEWS_EVIDENCE_STORIES_MAX)
    return false;
  return value.stories.every(isNewsStory);
}
