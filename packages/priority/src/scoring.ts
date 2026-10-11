/**
 * Pure priority scorer.
 *
 * Deterministic, side-effect free, max 200 candidates.
 * Fixed formula V1: explicit priority, time urgency, signals, anchors, readiness.
 */

import type {
  PriorityAnchor,
  PriorityCandidate,
  PriorityModelPreferenceV1,
  PriorityResult,
  PriorityScoreInput,
  FocusSignalInput
} from "./types.js";
import { CandidateLimitError } from "./types.js";

const MAX_CANDIDATES = 200;
const HIGH_PRESSURE_SIGNALS = new Set([
  "needs_reply",
  "time_sensitive",
  "follow_up_risk",
  "prep_needed",
  "high_stakes_meeting",
  "schedule_density_overload"
]);
const MEDIUM_PRESSURE_SIGNALS = new Set([
  "planning_impact",
  "travel_transition_pressure",
  "usable_open_gap"
]);

const BANDS = {
  critical: { min: 85, max: 100 },
  high: { min: 65, max: 84 },
  normal: { min: 35, max: 64 },
  low: { min: 0, max: 34 }
} as const;

const EFFORT_ORDER: Record<string, number> = { quick: 0, medium: 1, large: 2 };

function toBand(score: number): PriorityResult["band"] {
  if (score >= BANDS.critical.min) return "critical";
  if (score >= BANDS.high.min) return "high";
  if (score >= BANDS.normal.min) return "normal";
  return "low";
}

function localDay(iso: string, timeZone: string): string {
  const date = new Date(iso);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function dayDiff(iso: string | undefined, nowIso: string, timeZone: string): number | null {
  if (!iso) return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(iso);
  if (dateOnly) {
    const targetLocal = new Date(`${iso}T00:00:00Z`);
    const currentLocal = new Date(`${localDay(nowIso, timeZone)}T00:00:00Z`);
    return Math.round((targetLocal.getTime() - currentLocal.getTime()) / 86400000);
  }
  const startLocal = localDay(iso, timeZone);
  const currentLocal = localDay(nowIso, timeZone);
  const start = new Date(`${startLocal}T00:00:00Z`).getTime();
  const current = new Date(`${currentLocal}T00:00:00Z`).getTime();
  return Math.round((start - current) / 86400000);
}

function normalizeTokens(text: string): string[] {
  return text
    .toLowerCase()
    .trim()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

function containsSequence(tokens: readonly string[], sequence: readonly string[]): boolean {
  if (sequence.length === 0 || sequence.length > tokens.length) return false;
  for (let i = 0; i <= tokens.length - sequence.length; i++) {
    if (sequence.every((token, offset) => tokens[i + offset] === token)) return true;
  }
  return false;
}

function matchAnchors(candidate: PriorityCandidate, anchors: readonly PriorityAnchor[]) {
  const candidateTokens = candidate.textForAnchorMatch.flatMap((text) => normalizeTokens(text));
  let score = 0;
  let matched = 0;
  for (const anchor of anchors) {
    const terms = [anchor.label, ...anchor.aliases];
    if (terms.some((term) => containsSequence(candidateTokens, normalizeTokens(term)))) {
      score += anchor.weight * 10;
      matched += 1;
    }
  }
  return { matched, score: Math.max(-20, Math.min(20, score)) };
}

function minReadiness(signals: readonly FocusSignalInput[]): number {
  if (signals.length === 0) return 1.0;
  const clamped = signals.map((s) => Math.max(0, Math.min(1, s.readiness)));
  return Math.min(...clamped);
}

function computeScore(
  candidate: PriorityCandidate,
  model: PriorityModelPreferenceV1,
  now: string,
  timeZone: string,
  readiness: number
): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];

  const explicitPriority = candidate.explicitPriority ?? 0;
  const priorityWeight = [0, 0, 6, 14, 22, 30][explicitPriority] ?? 0;
  score += priorityWeight;
  if (priorityWeight > 0) reasons.push(`priority ${explicitPriority}`);

  const dueDiff = dayDiff(candidate.dueAt, now, timeZone);
  const startsDiff = dayDiff(candidate.startsAt, now, timeZone);
  const doDiff = dayDiff(candidate.doAt, now, timeZone);

  const earliestTimeDiff =
    [dueDiff, startsDiff, doDiff].filter((d): d is number => d !== null).sort((a, b) => a - b)[0] ??
    null;

  if (earliestTimeDiff !== null && earliestTimeDiff < 0) {
    score += 35;
    reasons.push("overdue");
  } else if (earliestTimeDiff === 0) {
    score += 28;
    reasons.push("due today");
  } else if (earliestTimeDiff === 1) {
    score += 18;
    reasons.push("due tomorrow");
  } else if (earliestTimeDiff !== null && earliestTimeDiff <= 7) {
    score += 8;
    reasons.push("due within 7 days");
  }

  if (candidate.signalType && HIGH_PRESSURE_SIGNALS.has(candidate.signalType)) {
    score += 20;
    reasons.push(candidate.signalType);
  } else if (candidate.signalType && MEDIUM_PRESSURE_SIGNALS.has(candidate.signalType)) {
    score += 10;
    reasons.push(candidate.signalType);
  }

  const anchorMatches = matchAnchors(
    candidate,
    model.anchors.filter((anchor) => anchor.enabled)
  );
  score += anchorMatches.score;
  if (anchorMatches.matched > 0) {
    reasons.push(`${anchorMatches.matched} anchor match${anchorMatches.matched > 1 ? "es" : ""}`);
  }

  const effort = candidate.effort ?? "medium";
  if (model.mode === "energy_protective" && readiness < 0.45) {
    if (effort === "quick") {
      score += 8;
      reasons.push("quick work, low energy");
    } else if (effort === "large") {
      score -= 12;
    }
  } else if (model.mode === "balanced" && readiness < 0.45 && effort === "large") {
    score -= 6;
  }

  if (model.mode === "deadline_first") {
    if (earliestTimeDiff === null || earliestTimeDiff > 0) {
      if (readiness < 0.45 && effort === "large") {
        score -= 10;
      }
    }
  }

  return { score: Math.max(0, Math.min(100, score)), reasons };
}

function tieBreakKey(
  candidate: PriorityCandidate,
  score: number
): readonly [number, number, number, number, string] {
  const pri = candidate.explicitPriority ?? 0;
  const eff = EFFORT_ORDER[candidate.effort ?? "medium"] ?? 3;
  const time = [candidate.dueAt, candidate.startsAt, candidate.doAt, candidate.occurredAt].find(
    (t) => t !== undefined
  );
  const timeMs = time ? new Date(time).getTime() : Infinity;
  return [-score, timeMs, -pri, eff, candidate.title];
}

export function rankPriorityCandidates(input: PriorityScoreInput): PriorityResult[] {
  if (input.candidates.length > MAX_CANDIDATES) {
    throw new CandidateLimitError(input.candidates.length);
  }

  const readiness = minReadiness(input.focusReadiness);
  const activeCandidates = input.candidates.filter(
    (candidate) => !input.model.mutedSources.includes(candidate.source)
  );
  const scored = activeCandidates.map((candidate) => {
    const { score, reasons } = computeScore(
      candidate,
      input.model,
      input.now,
      input.timeZone,
      readiness
    );
    return {
      candidate,
      result: {
        source: candidate.source,
        title: candidate.title,
        score,
        band: toBand(score),
        reasons: reasons.slice(0, 4),
        // #2609: carry the caller's identity through untouched. Only present when set.
        ...(candidate.key !== undefined ? { key: candidate.key } : {})
      }
    };
  });

  scored.sort((a, b) => {
    const keyA = tieBreakKey(a.candidate, a.result.score);
    const keyB = tieBreakKey(b.candidate, b.result.score);
    for (let i = 0; i < keyA.length; i++) {
      if (keyA[i]! !== keyB[i]!) {
        const ka = keyA[i]!;
        const kb = keyB[i]!;
        return typeof ka === "string" && typeof kb === "string"
          ? ka.localeCompare(kb)
          : (ka as number) - (kb as number);
      }
    }
    return 0;
  });

  return scored.map(({ result }) => result);
}
