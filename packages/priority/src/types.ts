/**
 * Unified priority model types.
 *
 * V1: owner-scored preference, pure scorer, mixed-source candidates.
 */

export type PrioritySource = "tasks" | "calendar" | "email" | "notes" | "memory" | "wellness";

export interface PriorityAnchor {
  readonly id: string;
  readonly kind: "project" | "person" | "domain" | "goal" | "obligation";
  readonly label: string;
  readonly aliases: readonly string[];
  readonly weight: -2 | -1 | 0 | 1 | 2;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PriorityModelPreferenceV1 {
  readonly version: 1;
  readonly mode: "balanced" | "deadline_first" | "energy_protective";
  readonly anchors: readonly PriorityAnchor[];
  readonly mutedSources: readonly PrioritySource[];
  readonly updatedAt: string;
}

export interface PriorityCandidate {
  readonly source: PrioritySource;
  readonly title: string;
  readonly summary?: string;
  readonly occurredAt?: string;
  readonly startsAt?: string;
  readonly dueAt?: string;
  readonly doAt?: string;
  readonly effort?: "quick" | "medium" | "large";
  readonly explicitPriority?: 1 | 2 | 3 | 4 | 5;
  readonly signalType?: string;
  readonly relevanceReasons?: readonly string[];
  readonly textForAnchorMatch: readonly string[];
  /**
   * #2609: opaque caller identity carried through ranking untouched, so results can be
   * matched back to their exact candidate. Titles are not unique (recurring events share
   * them), so matching by title can cross wires between same-title candidates.
   */
  readonly key?: string;
}

export interface FocusSignalInput {
  readonly moduleId: string;
  readonly readiness: number;
  readonly summary: string;
}

export interface PriorityScoreInput {
  readonly model: PriorityModelPreferenceV1;
  readonly candidates: readonly PriorityCandidate[];
  readonly now: string;
  readonly timeZone: string;
  readonly focusReadiness: readonly FocusSignalInput[];
}

export interface PriorityResult {
  readonly source: PrioritySource;
  readonly title: string;
  readonly score: number;
  readonly band: "critical" | "high" | "normal" | "low";
  readonly reasons: readonly string[];
  /** The candidate's `key`, when it set one. Absent otherwise. */
  readonly key?: string;
}

export class CandidateLimitError extends Error {
  constructor(public readonly count: number) {
    super(`Scorer accepts at most 200 candidates, received ${count}`);
    this.name = "CandidateLimitError";
  }
}

export class InvalidPreferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPreferenceError";
  }
}
