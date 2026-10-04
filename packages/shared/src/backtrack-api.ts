/**
 * Backtrack user routes (#2638 plan 2026-10-03-backtrack-phase2.md §4.7). Session-authenticated
 * module routes the Moss Settings screen calls; the companion ingest contract lives in
 * companion-api.ts. Timestamps are ISO-8601 strings.
 */

/** `GET /api/backtrack/status`. Counts cover only the signed-in person's own rows. */
export interface BacktrackStatusResponse {
  readonly storage: "off" | "on";
  readonly paused: boolean;
  /** Distinct Macs with a segment in the last 30 days. */
  readonly macs: number;
  /** Distinct days that hold at least one segment. */
  readonly days: number;
  /** Approximate stored text size, in bytes. */
  readonly bytes: number;
  readonly oldest?: string;
  readonly lastReceivedAt?: string;
}

/** `PUT /api/backtrack/preferences`. */
export interface BacktrackPreferencesRequest {
  readonly paused: boolean;
}

export interface BacktrackPreferencesResponse {
  readonly paused: boolean;
}

/**
 * `DELETE /api/backtrack/segments`. Both bounds or neither (neither means everything); the range
 * is `[from, to)`, `from` before `to`, at most 31 days apart. Computed by the browser in the
 * person's time zone (decision 7), never resolved by the server.
 */
export interface BacktrackDeleteRequest {
  readonly from?: string;
  readonly to?: string;
}

export interface BacktrackDeleteResponse {
  readonly deleted: number;
}

/** The longest range a delete may name (decision 7); "everything" sends no range. */
export const BACKTRACK_DELETE_MAX_RANGE_MS = 31 * 24 * 60 * 60 * 1000;

export const backtrackPreferencesRouteSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["paused"],
    properties: { paused: { type: "boolean" } }
  }
} as const;
